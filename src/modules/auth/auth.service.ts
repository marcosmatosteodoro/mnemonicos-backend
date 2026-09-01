import { randomUUID } from 'node:crypto';

import { env } from '../../config/env';
import type { SessionUser, UserRole } from '../../domain/types';
import { UnauthorizedError } from '../../http/errors';
import { recordAuthEvent } from '../../lib/audit';
import { hashPassword, verifyPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { generateToken, hashToken } from '../../lib/tokens';
import type { ChangePasswordInput, LoginInput } from './auth.schema';
import { decideRefresh } from './session-rotation';
import { revokeAllSessionsOp } from './session-revocation';

/**
 * Origem da requisição — resolvida pela rota a partir da conexão (`req.ip`,
 * cabeçalho `user-agent`), nunca do corpo. Supre o indicador de origem que todo
 * evento de auditoria exige (NFR-002-005): o `AuthAuditEvent` de
 * `src/lib/audit.ts` fixa `ip` como obrigatório.
 */
export interface RequestOrigin {
  ip: string;
  userAgent?: string;
}

/** Entrada de `login`: as credenciais normalizadas pelo schema + a origem da requisição. */
export type LoginParams = LoginInput & RequestOrigin;

/** Um valor de credencial opaca emitido para a sessão, com seu prazo. */
export interface SessionCredential {
  /**
   * Valor opaco em claro. Destina-se **só** ao cookie httpOnly que a rota escreve —
   * nunca ao corpo de uma resposta da API nem a um log (NFR-002-004).
   */
  value: string;
  expiresAt: Date;
}

/**
 * Sessão emitida por `login`/`refresh`: o usuário para o corpo da resposta e os
 * dois valores de credencial para os cookies. É a forma **interna** que a rota
 * converte em `Set-Cookie` + corpo `SessionUser` — não é, ela mesma, serializada
 * numa resposta.
 */
export interface IssuedSession {
  user: SessionUser;
  access: SessionCredential;
  refresh: SessionCredential;
}

/** Identidade resolvida de uma requisição autenticada — o que popula `req.auth`. */
export interface AuthContext {
  userId: string;
  role: UserRole;
  sessionId: string;
}

/** Ponta de família viva não encontrada após esta quantidade de corridas perdidas → nega. */
const MAX_ROTATE_ATTEMPTS = 4;

let paddingHashPromise: Promise<string> | undefined;

/**
 * Hash Argon2id de descarte, derivado uma vez por processo. Dá a `verifyPassword`
 * o mesmo trabalho quando o e-mail não existe, igualando o tempo de resposta
 * (FR-002-002 — o tempo não pode revelar se a conta existe). Nunca é credencial válida.
 *
 * A promise só é memoizada quando **resolve**: se o KDF falhar (ex.: pressão de
 * memória do Argon2id), o cache é limpo para a próxima chamada tentar de novo —
 * uma rejeição memoizada tornaria o oráculo de enumeração permanente.
 */
function paddingHash(): Promise<string> {
  paddingHashPromise ??= hashPassword('not-a-credential: constant-time login padding').catch(
    (cause: unknown) => {
      paddingHashPromise = undefined;
      throw cause instanceof Error ? cause : new Error(String(cause));
    },
  );
  return paddingHashPromise;
}

function accessDeadline(now: Date): Date {
  return new Date(now.getTime() + env.AUTH_ACCESS_TTL_MINUTES * 60_000);
}

function refreshDeadline(now: Date): Date {
  return new Date(now.getTime() + env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000);
}

function issue(
  owner: { id: string; name: string; email: string; role: UserRole },
  accessValue: string,
  accessExpiresAt: Date,
  refreshValue: string,
  refreshExpiresAt: Date,
): IssuedSession {
  return {
    user: { id: owner.id, name: owner.name, email: owner.email, role: owner.role },
    access: { value: accessValue, expiresAt: accessExpiresAt },
    refresh: { value: refreshValue, expiresAt: refreshExpiresAt },
  };
}

/**
 * Recorte de `RequestOrigin` para o payload de auditoria: `ip` sempre, `userAgent`
 * só quando informado (o evento o declara opcional). Um ponto único evita repetir
 * o mesmo spread condicional em cada `recordAuthEvent`.
 */
function auditOrigin(origin: RequestOrigin): { ip: string; userAgent?: string } {
  return origin.userAgent === undefined
    ? { ip: origin.ip }
    : { ip: origin.ip, userAgent: origin.userAgent };
}

/** Revoga toda a família de sessão (logout, reuso). Não mexe em linhas já revogadas. */
async function revokeFamily(familyId: string, now: Date): Promise<void> {
  await prisma.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  });
}

/**
 * Rotaciona a ponta viva da família e devolve as novas credenciais. Serve tanto
 * ao ramo `rotate` (o refresh apresentado É a ponta) quanto ao `replay-grace` (o
 * refresh apresentado já foi trocado, e a renovação concorrente segue da ponta
 * atual) — nos dois casos a família continua com uma sessão viva e sem revogação
 * (AC-002-026).
 *
 * A ponta é reivindicada em CAS (`updateMany ... WHERE rotatedAt IS NULL`) dentro
 * da transação que também cria a sucessora: dois refresh concorrentes nunca geram
 * duas sucessoras da mesma linha — o perdedor recarrega a ponta e tenta de novo.
 */
async function rotateFamilyTip(
  familyId: string,
  now: Date,
  owner: { id: string; name: string; email: string; role: UserRole },
  origin: RequestOrigin,
): Promise<IssuedSession> {
  for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt += 1) {
    const tip = await prisma.session.findFirst({
      where: { familyId, rotatedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userId: true, refreshExpiresAt: true },
    });

    // Nenhuma ponta viva (família revogada, ou toda rotacionada por uma corrida
    // que este ramo perdeu) → nega, nunca cria sessão órfã.
    if (tip === null) break;

    const rawAccess = generateToken();
    const rawRefresh = generateToken();
    const accessExpiresAt = accessDeadline(now);

    const claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.session.updateMany({
        where: { id: tip.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now },
      });

      if (claim.count === 0) return false;

      await tx.session.create({
        data: {
          userId: tip.userId,
          familyId,
          accessTokenHash: hashToken(rawAccess),
          refreshTokenHash: hashToken(rawRefresh),
          accessExpiresAt,
          // Expiração absoluta: a sucessora herda o prazo do login, não desliza (FR-002-005).
          refreshExpiresAt: tip.refreshExpiresAt,
        },
      });

      return true;
    });

    if (!claimed) continue;

    recordAuthEvent({
      type: 'token.refresh',
      at: now,
      outcome: 'success',
      subject: owner.id,
      ...auditOrigin(origin),
    });

    return issue(owner, rawAccess, accessExpiresAt, rawRefresh, tip.refreshExpiresAt);
  }

  throw new UnauthorizedError();
}

/**
 * Estabelece uma sessão a partir de e-mail e senha. Recusa com `UnauthorizedError`
 * genérico — mensagem única — se a conta não existe, a senha está errada **ou** a
 * conta está desativada (sem distinguir os casos: enumeração de contas). Sucesso
 * cria uma família nova com uma sessão. Toda tentativa é auditada sem senha nem token.
 */
export async function login(input: LoginParams): Promise<IssuedSession> {
  const now = new Date();
  const { email, password, ip, userAgent } = input;

  const user = await prisma.user.findUnique({ where: { email } });

  // Confere a senha em todos os caminhos — inclusive contra um hash de descarte
  // quando o e-mail não existe — para o tempo de resposta não denunciar a conta.
  // Qualquer falha do KDF (do hash de padding ou da verificação) resolve como
  // "não confere": fail secure (§6.3) — nega com a recusa genérica, nunca deixa
  // virar 500, que distinguiria e-mail inexistente de senha errada.
  let passwordMatches: boolean;
  try {
    passwordMatches = await verifyPassword(password, user?.passwordHash ?? (await paddingHash()));
  } catch {
    passwordMatches = false;
  }

  if (user === null || !passwordMatches || user.disabledAt !== null) {
    recordAuthEvent({
      type: 'login.failure',
      at: now,
      outcome: 'failure',
      subject: email,
      ...auditOrigin(input),
    });

    throw new UnauthorizedError();
  }

  const rawAccess = generateToken();
  const rawRefresh = generateToken();
  const accessExpiresAt = accessDeadline(now);
  const refreshExpiresAt = refreshDeadline(now);

  await prisma.session.create({
    data: {
      userId: user.id,
      familyId: randomUUID(),
      accessTokenHash: hashToken(rawAccess),
      refreshTokenHash: hashToken(rawRefresh),
      accessExpiresAt,
      refreshExpiresAt,
      createdIp: ip,
      ...(userAgent === undefined ? {} : { userAgent }),
    },
  });

  recordAuthEvent({
    type: 'login.success',
    at: now,
    outcome: 'success',
    subject: user.id,
    ...auditOrigin(input),
  });

  return issue(user, rawAccess, accessExpiresAt, rawRefresh, refreshExpiresAt);
}

/**
 * Cliente Prisma que `resolveAccessSession` usa. O default é o singleton de
 * produção; um teste pode injetar um client com `log: [{ level: 'query' }]` para
 * fixar a contagem de idas ao banco (§10 do perfil — caminho por requisição).
 */
type SessionReader = Pick<typeof prisma, 'session'>;

/**
 * Resolve a identidade de uma requisição a partir da credencial de acesso. É o
 * que o middleware chama a cada requisição: **uma** consulta por hash (LATERAL
 * JOIN com `User` via `relationLoadStrategy: 'join'`, `select` explícito — nunca
 * `passwordHash` nem coluna não usada), e devolve `null` — nunca lança — se o
 * token não existe, a sessão expirou ou foi revogada, ou a conta dona está
 * desativada (FR-002-007).
 */
export async function resolveAccessSession(
  accessToken: string,
  now: Date,
  db: SessionReader = prisma,
): Promise<AuthContext | null> {
  if (!accessToken) return null;

  const session = await db.session.findUnique({
    where: { accessTokenHash: hashToken(accessToken) },
    relationLoadStrategy: 'join',
    select: {
      id: true,
      userId: true,
      revokedAt: true,
      accessExpiresAt: true,
      user: { select: { role: true, disabledAt: true } },
    },
  });

  if (session === null) return null;
  if (session.revokedAt !== null) return null;
  if (session.accessExpiresAt.getTime() <= now.getTime()) return null;
  if (session.user.disabledAt !== null) return null;

  return { userId: session.userId, role: session.user.role, sessionId: session.id };
}

/**
 * Troca a credencial de acesso expirada por uma nova. Delega o desfecho a
 * `decideRefresh` (função pura) e persiste conforme o ramo. Token ausente ou
 * linha inexistente → `UnauthorizedError` genérico, a mesma mensagem do login
 * inválido, nunca uma exceção não tratada.
 */
export async function refresh(
  refreshToken: string | undefined,
  origin: RequestOrigin,
  now: Date,
): Promise<IssuedSession> {
  if (!refreshToken) throw new UnauthorizedError();

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(refreshToken) },
    relationLoadStrategy: 'join',
    select: {
      familyId: true,
      userId: true,
      rotatedAt: true,
      revokedAt: true,
      refreshExpiresAt: true,
      user: { select: { id: true, name: true, email: true, role: true, disabledAt: true } },
    },
  });

  if (session === null) throw new UnauthorizedError();

  // Conta desativada não renova — mesma recusa genérica de `login` e
  // `resolveAccessSession`, sem distinguir o motivo (enumeração).
  if (session.user.disabledAt !== null) throw new UnauthorizedError();

  const decision = decideRefresh(
    {
      rotatedAt: session.rotatedAt,
      revokedAt: session.revokedAt,
      refreshExpiresAt: session.refreshExpiresAt,
    },
    now,
    env.AUTH_REFRESH_GRACE_SECONDS,
  );

  switch (decision.kind) {
    case 'expired': {
      // Um refresh já rotacionado/revogado apresentado depois da expiração absoluta
      // ainda é sinal de reuso — a família do atacante não escapa da detecção só
      // por ter passado dos 7 dias (gate 8 da Wave 2).
      if (session.rotatedAt !== null || session.revokedAt !== null) {
        await revokeFamily(session.familyId, now);
        recordAuthEvent({
          type: 'token.reuse',
          at: now,
          outcome: 'failure',
          subject: session.userId,
          ...auditOrigin(origin),
        });
      }
      throw new UnauthorizedError();
    }

    case 'reuse': {
      await revokeFamily(session.familyId, now);
      recordAuthEvent({
        type: 'token.reuse',
        at: now,
        outcome: 'failure',
        subject: session.userId,
        ...auditOrigin(origin),
      });
      throw new UnauthorizedError();
    }

    case 'replay-grace':
    case 'rotate':
      return rotateFamilyTip(session.familyId, now, session.user, origin);

    default: {
      const unreachable: never = decision;
      throw new Error(`variante de renovação não tratada: ${String(unreachable)}`);
    }
  }
}

/**
 * Revoga a sessão no servidor: apaga a família inteira do token de renovação. A
 * rota limpa os cookies. Token ausente ou linha inexistente → no-op silencioso.
 */
export async function logout(
  refreshToken: string | undefined,
  origin: RequestOrigin,
): Promise<void> {
  if (!refreshToken) return;

  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(refreshToken) },
    select: { familyId: true, userId: true },
  });

  if (session === null) return;

  await revokeFamily(session.familyId, now);
  recordAuthEvent({
    type: 'logout',
    at: now,
    outcome: 'success',
    subject: session.userId,
    ...auditOrigin(origin),
  });
}

/**
 * Troca a senha da própria conta. Exige a senha atual correta (erro → recusa sem
 * alterar) e revoga as **demais** sessões do usuário, mantendo a corrente. Nova
 * senha igual à atual é aceita — F1 não promete política de reuso de senha.
 */
export async function changeOwnPassword(
  userId: string,
  input: ChangePasswordInput,
  currentSessionId: string,
): Promise<void> {
  const now = new Date();

  const user = await prisma.user.findUnique({ where: { id: userId } });

  // A identidade vem da sessão resolvida (§6.3): se ela não resolve para um
  // usuário, nega, nunca segue.
  if (user === null) throw new UnauthorizedError();

  const currentMatches = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!currentMatches) throw new UnauthorizedError();

  const newPasswordHash = await hashPassword(input.newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: newPasswordHash } }),
    revokeAllSessionsOp(userId, now, { exceptSessionId: currentSessionId }),
  ]);
}

/**
 * Revoga todas as sessões de um usuário — invólucro de `revokeAllSessionsOp`
 * (COMP-003-008 / EMENDA Wave 5) num `$transaction` de uma operação. O
 * `session.updateMany` de revogação por usuário vive só em `revokeAllSessionsOp`;
 * `disableUser`/`resetUserPassword` compõem a operação dentro das suas próprias
 * transações em vez de chamar este invólucro.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.$transaction([revokeAllSessionsOp(userId, new Date())]);
}

/**
 * Leitor fino do usuário da sessão corrente — o corpo de `GET /auth/me`
 * (COMP-003-010). `AuthContext`/`resolveAccessSession` carregam só
 * `{ userId, role, sessionId }` e o caminho por requisição não deve carregar mais
 * (o resolvedor roda a cada request — perf do gate 10 da Wave 3), então
 * `name`/`email` vêm desta consulta separada, que só roda na rota `/auth/me`.
 *
 * `where: { id, disabledAt: null }` **é** a guarda de conta desativada — o mesmo
 * predicado de negação que `login`/`resolveAccessSession`/`refresh` aplicam
 * (checklist "Consumidores de sessão do auth.service", README §72–76): conta
 * desativada → `null`, e a rota responde 401. `select` explícito — nunca
 * `passwordHash` nem valor de token no retorno (NFR-002-004).
 */
export async function getSessionUser(userId: string): Promise<SessionUser | null> {
  return prisma.user.findFirst({
    where: { id: userId, disabledAt: null },
    select: { id: true, name: true, email: true, role: true },
  });
}
