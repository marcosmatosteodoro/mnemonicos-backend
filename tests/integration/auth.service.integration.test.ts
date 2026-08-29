import { randomUUID } from 'node:crypto';

import { env } from '../../src/config/env';
import { UnauthorizedError } from '../../src/http/errors';
import { logger } from '../../src/lib/logger';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import { generateToken, hashToken } from '../../src/lib/tokens';
import {
  changeOwnPassword,
  login,
  logout,
  refresh,
  type RequestOrigin,
  resolveAccessSession,
  revokeAllSessions,
} from '../../src/modules/auth/auth.service';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * Camada de serviço de autenticação sobre o Postgres real (harness de
 * TASK-003-016). Cobre os critérios de pronto de TASK-003-006: recusa genérica
 * com auditoria sem segredo, rotação de família ponta-a-ponta, expiração
 * absoluta, revogação por logout, troca da própria senha e ausência de segredo
 * em log ou retorno. `decideRefresh` (pura) tem prova própria em
 * `tests/unit/session-rotation.test.ts` — aqui o foco é a persistência.
 */

const PASSWORD = 'senha-de-fixture-123';
const ORIGIN: RequestOrigin = { ip: '203.0.113.7', userAgent: 'jest-suite/1.0' };
const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;
const GRACE_MS = env.AUTH_REFRESH_GRACE_SECONDS * 1000;

/** Hash Argon2id do `PASSWORD` — derivado uma vez; o KDF é caro de propósito. */
let sharedPasswordHash: string;

interface UserSeed {
  email?: string;
  name?: string;
  role?: 'STUDENT' | 'EDITOR' | 'ADMIN';
  password?: string;
  disabledAt?: Date | null;
}

async function createUser(seed: UserSeed = {}) {
  return testPrisma.user.create({
    data: {
      email: seed.email ?? `user-${randomUUID()}@example.com`,
      name: seed.name ?? 'Fulano de Tal',
      passwordHash:
        seed.password === undefined ? sharedPasswordHash : await hashPassword(seed.password),
      role: seed.role ?? 'STUDENT',
      disabledAt: seed.disabledAt ?? null,
    },
  });
}

interface SessionSeed {
  familyId?: string;
  accessExpiresAt?: Date;
  refreshExpiresAt?: Date;
  rotatedAt?: Date | null;
  revokedAt?: Date | null;
}

/** Semeia uma linha de `Session` e devolve os valores em claro dos tokens dela. */
async function seedSession(userId: string, seed: SessionSeed = {}) {
  const access = generateToken();
  const refreshValue = generateToken();

  const row = await testPrisma.session.create({
    data: {
      userId,
      familyId: seed.familyId ?? randomUUID(),
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(refreshValue),
      accessExpiresAt: seed.accessExpiresAt ?? new Date(Date.now() + ACCESS_TTL_MS),
      refreshExpiresAt: seed.refreshExpiresAt ?? new Date(Date.now() + REFRESH_TTL_MS),
      rotatedAt: seed.rotatedAt ?? null,
      revokedAt: seed.revokedAt ?? null,
    },
  });

  return { row, access, refresh: refreshValue };
}

/** Espião do transport estruturado — `recordAuthEvent` escreve por `logger.info`. */
function captureAuthLog() {
  return jest.spyOn(logger, 'info').mockImplementation(() => undefined);
}

beforeAll(async () => {
  sharedPasswordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await closeTestDb();
});

describe('login — AC-002-002: recusa genérica e auditoria sem segredo', () => {
  it('não distingue e-mail inexistente, senha errada e conta desativada — mesma exceção e mensagem', async () => {
    const active = await createUser();
    const disabled = await createUser({ disabledAt: new Date() });

    const errors = await Promise.all([
      login({ email: 'ninguem@example.com', password: PASSWORD, ...ORIGIN }).catch(
        (e: unknown) => e,
      ),
      login({ email: active.email, password: 'senha-errada', ...ORIGIN }).catch((e: unknown) => e),
      login({ email: disabled.email, password: PASSWORD, ...ORIGIN }).catch((e: unknown) => e),
    ]);

    for (const error of errors) expect(error).toBeInstanceOf(UnauthorizedError);
    const messages = new Set(errors.map((e) => (e as Error).message));
    expect(messages.size).toBe(1);
  });

  it('a mensagem de recusa é a genérica de credenciais inválidas', async () => {
    const error = await login({
      email: 'ninguem@example.com',
      password: PASSWORD,
      ...ORIGIN,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect((error as Error).message).toBe('Credenciais inválidas.');
  });

  it('audita a tentativa como login.failure sem a senha da fixture no payload', async () => {
    const info = captureAuthLog();

    await login({ email: 'ninguem@example.com', password: PASSWORD, ...ORIGIN }).catch(
      () => undefined,
    );

    const failures = info.mock.calls.filter(
      (call) => (call[0] as { audit?: { type?: string } }).audit?.type === 'login.failure',
    );
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain(PASSWORD);
  });
});

describe('resolveAccessSession — AC-002-008: revogada / conta desativada rejeitada mesmo no prazo', () => {
  it('numa base com sessão ativa+revogada e conta ativa+desativada, só ativa+ativa resolve', async () => {
    const activeUser = await createUser();
    const disabledUser = await createUser({ disabledAt: new Date() });
    const good = await seedSession(activeUser.id);
    const revoked = await seedSession(activeUser.id, { revokedAt: new Date() });
    const onDisabled = await seedSession(disabledUser.id);
    const now = new Date();

    expect(await resolveAccessSession(good.access, now)).toEqual({
      userId: activeUser.id,
      role: activeUser.role,
      sessionId: good.row.id,
    });
    expect(await resolveAccessSession(revoked.access, now)).toBeNull();
    expect(await resolveAccessSession(onDisabled.access, now)).toBeNull();
  });

  it('devolve null quando o access já passou de accessExpiresAt', async () => {
    const user = await createUser();
    const { access } = await seedSession(user.id, {
      accessExpiresAt: new Date(Date.now() - 1000),
    });

    expect(await resolveAccessSession(access, new Date())).toBeNull();
  });

  it('devolve null — nunca lança — para token de acesso desconhecido', async () => {
    expect(await resolveAccessSession(generateToken(), new Date())).toBeNull();
  });
});

describe('refresh — AC-002-004: rotação sequencial ponta-a-ponta na camada de serviço', () => {
  it('troca o refresh apresentado por uma sessão nova, e o novo access resolve', async () => {
    const user = await createUser();
    const t0 = new Date();
    const first = await login({ email: user.email, password: PASSWORD, ...ORIGIN });

    const rotated = await refresh(first.refresh.value, ORIGIN, t0);

    expect(rotated.refresh.value).not.toBe(first.refresh.value);
    expect(await resolveAccessSession(rotated.access.value, new Date())).toMatchObject({
      userId: user.id,
    });
  });

  it('reapresentar o refresh original fora da graça é reuso — lança e revoga a família', async () => {
    const user = await createUser();
    const t0 = new Date();
    const first = await login({ email: user.email, password: PASSWORD, ...ORIGIN });
    await refresh(first.refresh.value, ORIGIN, t0);

    const afterGrace = new Date(t0.getTime() + GRACE_MS + 1000);
    await expect(refresh(first.refresh.value, ORIGIN, afterGrace)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    const rows = await testPrisma.session.findMany({ where: { userId: user.id } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });
});

describe('refresh — AC-002-006: expiração absoluta do refresh', () => {
  it('lança quando refreshExpiresAt já está no passado', async () => {
    const user = await createUser();
    const { refresh: token } = await seedSession(user.id, {
      refreshExpiresAt: new Date(Date.now() - 60_000),
    });

    await expect(refresh(token, ORIGIN, new Date())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('aceita um refresh no prazo e não rotacionado (caso neutro)', async () => {
    const user = await createUser();
    const { refresh: token } = await seedSession(user.id);

    await expect(refresh(token, ORIGIN, new Date())).resolves.toMatchObject({
      user: { id: user.id },
    });
  });
});

describe('refresh — AC-002-005: reuso revoga a família, e só ela', () => {
  it('token já rotacionado revoga toda a família A e deixa a família B intacta', async () => {
    const userA = await createUser();
    const userB = await createUser();
    const familyA = randomUUID();
    const familyB = randomUUID();
    const rotatedAt = new Date(Date.now() - (GRACE_MS + 5000));

    const staleA = await seedSession(userA.id, { familyId: familyA, rotatedAt });
    await seedSession(userA.id, { familyId: familyA });
    await seedSession(userB.id, { familyId: familyB });
    await seedSession(userB.id, { familyId: familyB });

    await expect(refresh(staleA.refresh, ORIGIN, new Date())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    const rowsA = await testPrisma.session.findMany({ where: { familyId: familyA } });
    const rowsB = await testPrisma.session.findMany({ where: { familyId: familyB } });
    expect(rowsA.every((r) => r.revokedAt !== null)).toBe(true);
    expect(rowsB.every((r) => r.revokedAt === null)).toBe(true);
  });
});

describe('logout — AC-002-007: revoga a família; reapresentação rejeitada', () => {
  it('após logout, o access anterior deixa de resolver', async () => {
    const user = await createUser();
    const issued = await login({ email: user.email, password: PASSWORD, ...ORIGIN });

    await logout(issued.refresh.value, ORIGIN);

    expect(await resolveAccessSession(issued.access.value, new Date())).toBeNull();
  });

  it('após logout, o refresh anterior é rejeitado e a família de outra conta segue ativa', async () => {
    const user = await createUser();
    const other = await createUser();
    const issued = await login({ email: user.email, password: PASSWORD, ...ORIGIN });
    const otherIssued = await login({ email: other.email, password: PASSWORD, ...ORIGIN });

    await logout(issued.refresh.value, ORIGIN);

    await expect(refresh(issued.refresh.value, ORIGIN, new Date())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(await resolveAccessSession(otherIssued.access.value, new Date())).toMatchObject({
      userId: other.id,
    });
  });
});

describe('token ausente ou linha não encontrada', () => {
  it('refresh(undefined) lança a mesma exceção genérica do login inválido', async () => {
    const user = await createUser();
    const loginErr = await login({ email: user.email, password: 'errada', ...ORIGIN }).catch(
      (e: unknown) => e,
    );
    const refreshErr = await refresh(undefined, ORIGIN, new Date()).catch((e: unknown) => e);

    expect(refreshErr).toBeInstanceOf(UnauthorizedError);
    expect((refreshErr as Error).message).toBe((loginErr as Error).message);
  });

  it('refresh de token desconhecido lança UnauthorizedError, nunca erro não tratado', async () => {
    await expect(refresh(generateToken(), ORIGIN, new Date())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('logout(undefined) resolve sem efeito (no-op silencioso)', async () => {
    await expect(logout(undefined, ORIGIN)).resolves.toBeUndefined();
  });

  it('logout de token desconhecido não lança e não revoga nenhuma linha', async () => {
    const user = await createUser();
    const { row } = await seedSession(user.id);

    await expect(logout(generateToken(), ORIGIN)).resolves.toBeUndefined();

    const after = await testPrisma.session.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.revokedAt).toBeNull();
  });
});

describe('refresh — AC-002-026: renovações concorrentes', () => {
  it('dois refresh concorrentes com o mesmo token resolvem e não revogam a família', async () => {
    const user = await createUser();
    const t0 = new Date();
    const issued = await login({ email: user.email, password: PASSWORD, ...ORIGIN });

    const [a, b] = await Promise.all([
      refresh(issued.refresh.value, ORIGIN, t0),
      refresh(issued.refresh.value, ORIGIN, t0),
    ]);

    expect(a.access.value).toBeTruthy();
    expect(b.access.value).toBeTruthy();
    const rows = await testPrisma.session.findMany({ where: { userId: user.id } });
    expect(rows.some((r) => r.revokedAt !== null)).toBe(false);
  });

  it('o token original reapresentado após a graça revoga a família', async () => {
    const user = await createUser();
    const t0 = new Date();
    const issued = await login({ email: user.email, password: PASSWORD, ...ORIGIN });
    await refresh(issued.refresh.value, ORIGIN, t0);

    const afterGrace = new Date(t0.getTime() + GRACE_MS + 1000);
    await expect(refresh(issued.refresh.value, ORIGIN, afterGrace)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    const rows = await testPrisma.session.findMany({ where: { userId: user.id } });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('o @unique de refreshTokenHash faz o duplo-rotate simultâneo falhar fechado (P2002)', async () => {
    const user = await createUser();
    const { row } = await seedSession(user.id);

    const duplicate = testPrisma.session.create({
      data: {
        userId: user.id,
        familyId: row.familyId,
        accessTokenHash: hashToken(generateToken()),
        refreshTokenHash: row.refreshTokenHash,
        accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
        refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });

    await expect(duplicate).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('changeOwnPassword — AC-002-029: troca da própria senha', () => {
  it('com a senha atual correta: o hash muda e a nova senha passa a verificar', async () => {
    const user = await createUser();
    const nova = 'nova-senha-bem-longa-1';

    await changeOwnPassword(
      user.id,
      { currentPassword: PASSWORD, newPassword: nova },
      'sessao-corrente',
    );

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).not.toBe(sharedPasswordHash);
    expect(await verifyPassword(nova, after.passwordHash)).toBe(true);
  });

  it('revoga as demais sessões da conta, preservando a corrente e as de outras contas', async () => {
    const user = await createUser();
    const other = await createUser();
    const current = await seedSession(user.id);
    const sibling = await seedSession(user.id);
    const foreign = await seedSession(other.id);

    await changeOwnPassword(
      user.id,
      { currentPassword: PASSWORD, newPassword: 'outra-senha-longa-9' },
      current.row.id,
    );

    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: current.row.id } })).revokedAt,
    ).toBeNull();
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sibling.row.id } })).revokedAt,
    ).not.toBeNull();
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: foreign.row.id } })).revokedAt,
    ).toBeNull();
  });

  it('com a senha atual errada: lança UnauthorizedError e não altera o hash', async () => {
    const user = await createUser();
    const before = (await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .passwordHash;

    await expect(
      changeOwnPassword(
        user.id,
        { currentPassword: 'errada', newPassword: 'nova-senha-longa-77' },
        'sessao-corrente',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    const after = (await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .passwordHash;
    expect(after).toBe(before);
  });
});

describe('changeOwnPassword — nova senha igual à atual é aceita', () => {
  it('aceita newPassword == senha atual (≥12): o hash muda pelo salt e as demais sessões são revogadas', async () => {
    const longPassword = 'senha-identica-de-12+';
    const user = await createUser({ password: longPassword });
    const current = await seedSession(user.id);
    const sibling = await seedSession(user.id);
    const before = (await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .passwordHash;

    await changeOwnPassword(
      user.id,
      { currentPassword: longPassword, newPassword: longPassword },
      current.row.id,
    );

    const after = (await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .passwordHash;
    expect(after).not.toBe(before);
    expect(await verifyPassword(longPassword, after)).toBe(true);
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sibling.row.id } })).revokedAt,
    ).not.toBeNull();
  });
});

describe('revokeAllSessions', () => {
  it('revoga só as sessões do usuário alvo', async () => {
    const userA = await createUser();
    const userB = await createUser();
    await seedSession(userA.id);
    await seedSession(userA.id);
    await seedSession(userB.id);
    await seedSession(userB.id);

    await revokeAllSessions(userA.id);

    const rowsA = await testPrisma.session.findMany({ where: { userId: userA.id } });
    const rowsB = await testPrisma.session.findMany({ where: { userId: userB.id } });
    expect(rowsA.every((r) => r.revokedAt !== null)).toBe(true);
    expect(rowsB.every((r) => r.revokedAt === null)).toBe(true);
  });
});

describe('AC-002-024 / NFR-002-004: nenhum segredo em log ou retorno', () => {
  it('nenhum registro durante login e changeOwnPassword contém senha, access ou refresh', async () => {
    const info = captureAuthLog();
    const user = await createUser();

    const issued = await login({ email: user.email, password: PASSWORD, ...ORIGIN });
    await login({ email: user.email, password: 'errada', ...ORIGIN }).catch(() => undefined);
    await changeOwnPassword(
      user.id,
      { currentPassword: PASSWORD, newPassword: 'w'.repeat(13) },
      'sc',
    );
    await changeOwnPassword(
      user.id,
      { currentPassword: 'errada', newPassword: 'w'.repeat(13) },
      'sc',
    ).catch(() => undefined);

    expect(info.mock.calls.length).toBeGreaterThan(0);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(issued.access.value);
    expect(logged).not.toContain(issued.refresh.value);
  });

  it('o retorno de login não expõe passwordHash / accessToken / refreshToken', async () => {
    const user = await createUser();

    const issued = await login({ email: user.email, password: PASSWORD, ...ORIGIN });

    expect(issued).not.toHaveProperty('passwordHash');
    expect(issued).not.toHaveProperty('accessToken');
    expect(issued).not.toHaveProperty('refreshToken');
    expect(Object.keys(issued.user).sort()).toEqual(['email', 'id', 'name', 'role']);
  });

  it('o contexto de resolveAccessSession carrega só userId / role / sessionId', async () => {
    const user = await createUser();
    const issued = await login({ email: user.email, password: PASSWORD, ...ORIGIN });

    const ctx = await resolveAccessSession(issued.access.value, new Date());

    expect(ctx).not.toBeNull();
    expect(ctx).not.toHaveProperty('passwordHash');
    expect(Object.keys(ctx as object).sort()).toEqual(['role', 'sessionId', 'userId']);
  });

  it('changeOwnPassword não devolve nada (nem hash, nem token)', async () => {
    const user = await createUser();

    const result = await changeOwnPassword(
      user.id,
      { currentPassword: PASSWORD, newPassword: 'z'.repeat(13) },
      'sc',
    );

    expect(result).toBeUndefined();
  });
});
