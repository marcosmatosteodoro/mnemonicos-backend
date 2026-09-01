/**
 * Bootstrap do primeiro ADMIN (FR-002-021 / AC-002-023 / DEC-003-008).
 *
 * Lógica isolada do seed de conteúdo para ser exercitável contra o Postgres real
 * sem rodar a carga inteira. Nunca há senha embutida: a credencial vem só de
 * `env.SEED_ADMIN_EMAIL` + `env.SEED_ADMIN_PASSWORD` (ambos de `src/config/env.ts`).
 * O `console.log` informativo fica no chamador (`prisma/seed.ts`), que traduz o
 * desfecho — aqui só a decisão e a persistência.
 */
import { env } from '../src/config/env';
import type { PrismaClient } from '../src/generated/prisma/client';
import { hashPassword } from '../src/lib/password';

/**
 * Valor-placeholder de `SEED_ADMIN_PASSWORD` em `mnemonicos-backend/.env.example`.
 * Mantido em sincronia com aquele arquivo à mão — mudou o placeholder de lá, este
 * literal muda junto (o teste de integração compara os dois e falha se divergirem).
 * É recusado de propósito: passa o `.min(12)` do schema, mas está no histórico
 * público do repositório, então usá-lo faria a conta de maior privilégio nascer
 * com uma credencial conhecida (critério herdado do gate 8 da Wave 1).
 */
export const ENV_EXAMPLE_ADMIN_PASSWORD_PLACEHOLDER = 'troque-por-uma-senha-forte-de-bootstrap';

interface AdminSeedCredentials {
  email?: string;
  password?: string;
}

export type AdminSeedOutcome =
  | { status: 'created'; email: string }
  | { status: 'exists' }
  | { status: 'partial' }
  | { status: 'not-configured' };

function deriveName(email: string): string {
  const localPart = email.split('@')[0]?.trim();
  return localPart && localPart.length > 0 ? localPart : 'Administrador';
}

/**
 * Cria exatamente um ADMIN inicial quando as credenciais de bootstrap estão
 * configuradas e ainda não há nenhum ADMIN. Idempotente pela guarda
 * `count(role=ADMIN) === 0`.
 *
 * - Config parcial (só e-mail **ou** só senha) → tratada como ausente, nada é criado.
 * - Ausentes → nada é criado.
 * - `password` igual ao placeholder do `.env.example` → **aborta** (lança), citando o
 *   nome da variável, nunca o valor; nada é criado.
 */
export async function seedAdmin(
  client: PrismaClient,
  credentials: AdminSeedCredentials = {
    email: env.SEED_ADMIN_EMAIL,
    password: env.SEED_ADMIN_PASSWORD,
  },
): Promise<AdminSeedOutcome> {
  const { email, password } = credentials;

  if (password !== undefined && password === ENV_EXAMPLE_ADMIN_PASSWORD_PLACEHOLDER) {
    throw new Error(
      'SEED_ADMIN_PASSWORD está com o valor-placeholder do .env.example; defina uma senha de bootstrap real antes de rodar o seed.',
    );
  }

  const hasEmail = email !== undefined;
  const hasPassword = password !== undefined;

  if (!hasEmail && !hasPassword) return { status: 'not-configured' };
  if (!hasEmail || !hasPassword) return { status: 'partial' };

  const existingAdmins = await client.user.count({ where: { role: 'ADMIN' } });
  if (existingAdmins > 0) return { status: 'exists' };

  await client.user.create({
    data: {
      email,
      name: deriveName(email),
      passwordHash: await hashPassword(password),
      role: 'ADMIN',
    },
  });

  return { status: 'created', email };
}
