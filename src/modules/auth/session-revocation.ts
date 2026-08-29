import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { prisma } from '../../lib/prisma';

/**
 * Revogação em massa das sessões de uma conta (COMP-003-008 / EMENDA Wave 5).
 *
 * Vive num módulo próprio — e não como função interna de `auth.service.ts` —
 * porque `changeOwnPassword` (mesmo arquivo que a definição estaria) precisa ser
 * provado delegando a esta operação, e uma chamada intra-módulo não é
 * interceptável por spy sob o transpile CJS do ts-jest. Aqui os três
 * consumidores (`changeOwnPassword`, `disableUser`, `resetUserPassword`) a
 * importam de fora, e o spy de delegação funciona para todos.
 */

/** Client capaz de revogar sessão: o singleton de produção ou o `tx` de uma transação interativa. */
type SessionRevokerClient = PrismaClient | Prisma.TransactionClient;

/**
 * A **única** operação de revogação em massa de sessões por usuário em `src/`
 * (revogação por *família* — logout, reuso de token — é outra operação, escopada
 * a `familyId`, e vive em `auth.service.ts`). Devolve o `PrismaPromise` **sem
 * `await`** para compor tanto em `prisma.$transaction([...])` quanto, passando
 * `client: tx`, dentro de `prisma.$transaction(async (tx) => ...)`.
 *
 * `exceptSessionId` preserva uma sessão viva — a corrente na troca da própria
 * senha (AC-002-029), que não deve se auto-deslogar.
 */
export function revokeAllSessionsOp(
  userId: string,
  now: Date,
  opts: { client?: SessionRevokerClient; exceptSessionId?: string } = {},
): Prisma.PrismaPromise<Prisma.BatchPayload> {
  const client = opts.client ?? prisma;

  return client.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(opts.exceptSessionId === undefined ? {} : { id: { not: opts.exceptSessionId } }),
    },
    data: { revokedAt: now },
  });
}
