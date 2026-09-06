/**
 * Bootstrap do EDITOR de dev — sujeito concreto do gate 9 das telas de
 * produção de material (resolução 2 do manifesto de telas).
 *
 * Mesmo padrão de `seedAdmin` (`prisma/seed-admin.ts`): lógica isolada do
 * laço de material para ser exercitável contra o Postgres real sem rodar a
 * carga inteira. Credencial só de `env.SEED_EDITOR_EMAIL` +
 * `env.SEED_EDITOR_PASSWORD` — nunca embutida. Diferente do ADMIN, não há
 * placeholder a recusar: um EDITOR de dev a menos não trava o boot, então
 * ausência/config parcial é sempre no-op, nunca aborta. O `console.log`
 * informativo fica no chamador (`prisma/seed.ts`), que traduz o desfecho.
 */
import { env } from '../src/config/env';
import type { PrismaClient } from '../src/generated/prisma/client';
import { hashPassword } from '../src/lib/password';
import { deriveName } from './seed-admin';

interface DevEditorSeedCredentials {
  email?: string;
  password?: string;
}

export type DevEditorSeedOutcome =
  | { status: 'created'; email: string }
  | { status: 'exists' }
  | { status: 'partial' }
  | { status: 'not-configured' };

/**
 * Cria exatamente um EDITOR de dev quando `email`/`password` estão presentes
 * e ainda não existe usuário com aquele e-mail. Idempotente por e-mail
 * (`User.email` é `@unique`).
 *
 * - Ausentes (as duas) → nada é criado, `not-configured`.
 * - Config parcial (só e-mail **ou** só senha) → tratada como ausente, `partial`.
 * - E-mail já cadastrado → nada é criado, `exists` (nunca sobrescreve senha/role).
 */
export async function seedDevEditor(
  client: PrismaClient,
  credentials: DevEditorSeedCredentials = {
    email: env.SEED_EDITOR_EMAIL,
    password: env.SEED_EDITOR_PASSWORD,
  },
): Promise<DevEditorSeedOutcome> {
  const { email, password } = credentials;

  const hasEmail = email !== undefined;
  const hasPassword = password !== undefined;

  if (!hasEmail && !hasPassword) return { status: 'not-configured' };
  if (!hasEmail || !hasPassword) return { status: 'partial' };

  const existing = await client.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return { status: 'exists' };

  await client.user.create({
    data: {
      email,
      name: deriveName(email),
      passwordHash: await hashPassword(password),
      role: 'EDITOR',
    },
  });

  return { status: 'created', email };
}
