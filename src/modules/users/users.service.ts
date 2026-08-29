import type { SessionUser } from '../../domain/types';
import { Prisma } from '../../generated/prisma/client';
import { ConflictError, NotFoundError } from '../../http/errors';
import { hashPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import type { Paginated } from '../disciplines/disciplines.service';
import type { CreateUserInput, ListUsersQuery } from './users.schema';

/**
 * Regra + Prisma da gestão de contas internas (COMP-003-014). Toda resposta é
 * montada campo a campo por `select` explícito — nunca a entidade Prisma crua, e
 * **nunca** `passwordHash` nem a relação `sessions` (NFR-002-004). O papel é
 * fixado na criação; alterar papel e reativar conta estão fora de F1 (§4.2).
 */

/** Situação de uma conta na listagem — derivada de `disabledAt` (null = ativa). */
export type UserStatus = 'active' | 'disabled';

/** Item da listagem de contas: sem material de senha/token (FR-002-017 / AC-002-019). */
export interface UserListItem {
  id: string;
  email: string;
  name: string;
  role: SessionUser['role'];
  status: UserStatus;
}

/**
 * Cria uma conta interna com o papel informado (FR-002-014). O `data` é montado
 * campo a campo a partir do parse (§6.1), nunca o `req.body` cru. E-mail já em
 * uso (violação do `@unique` → P2002) vira `ConflictError` **sem** nenhum
 * `update` — a conta existente não é tocada (FR-002-015 / AC-002-017). A resposta
 * sai de um `select` explícito `{id,name,email,role}` (nunca `passwordHash`).
 */
export async function createInternalUser(input: CreateUserInput): Promise<SessionUser> {
  const passwordHash = await hashPassword(input.password);

  try {
    return await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash,
      },
      select: { id: true, name: true, email: true, role: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Já existe uma conta com este e-mail.');
    }
    throw error;
  }
}

/**
 * Lista as contas internas paginadas (FR-002-017). `select` explícito com só
 * `id,email,name,role,disabledAt` — `disabledAt` é traduzido para `status` e não
 * viaja cru; nenhum `include`, nenhum `passwordHash`. `search` (herdado do schema
 * de paginação de `disciplines`) filtra por nome **ou** e-mail, sem SQL montado à
 * mão (`mode: 'insensitive'` vai parametrizado pelo Prisma).
 */
export async function listInternalUsers(query: ListUsersQuery): Promise<Paginated<UserListItem>> {
  const { page, perPage, search } = query;

  const where: Prisma.UserWhereInput = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, email: true, name: true, role: true, disabledAt: true },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    data: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.disabledAt === null ? 'active' : 'disabled',
    })),
    page,
    perPage,
    total,
  };
}

/**
 * Desativa uma conta de forma reversível (FR-002-018): marca `disabledAt` e
 * revoga as sessões vivas dela **na mesma transação**. Recusa quando o alvo é o
 * último ADMIN ativo (FR-002-019 / DEC-003-007 / AC-002-021) — contenção de
 * lockout administrativo, já que a reativação está fora de F1 (§4.2).
 *
 * A revogação é `session.updateMany` inline dentro de `prisma.$transaction([...])`,
 * não a chamada a `revokeAllSessions`: aquele helper roda sobre o client
 * singleton e não compõe numa transação — é o mesmo motivo (e o mesmo padrão) de
 * `changeOwnPassword` (`auth.service.ts`). A conta desativada já teria as sessões
 * recusadas em `resolveAccessSession`/`refresh` (guarda `disabledAt`); a
 * revogação atômica é a contenção imediata que AC-002-020 exige.
 */
export async function disableUser(id: string): Promise<void> {
  const now = new Date();

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, disabledAt: true },
  });

  if (target === null) throw new NotFoundError('Conta não encontrada.');

  // Já desativada → nada a fazer; re-carimbar perderia a marca temporal original.
  if (target.disabledAt !== null) return;

  if (target.role === 'ADMIN') {
    const activeAdmins = await prisma.user.count({
      where: { role: 'ADMIN', disabledAt: null },
    });
    if (activeAdmins <= 1) {
      throw new ConflictError('Não é possível desativar o último ADMIN ativo.');
    }
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { disabledAt: now } }),
    prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
}

/**
 * Redefine a senha de uma conta por ADMIN (FR-002-020 / AC-002-022). Deriva o
 * novo hash (Argon2id) e, na mesma transação, grava e revoga as sessões vivas da
 * conta — a sessão continuada com a senha antiga para de funcionar de imediato.
 * Mesma composição de `changeOwnPassword` (o helper `revokeAllSessions` não
 * compõe em transação). Não devolve nada — nunca hash nem token.
 */
export async function resetUserPassword(id: string, password: string): Promise<void> {
  const now = new Date();

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (target === null) throw new NotFoundError('Conta não encontrada.');

  const passwordHash = await hashPassword(password);

  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { passwordHash } }),
    prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
}
