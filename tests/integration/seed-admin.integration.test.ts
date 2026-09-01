import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENV_EXAMPLE_ADMIN_PASSWORD_PLACEHOLDER, seedAdmin } from '../../prisma/seed-admin';
import { verifyPassword } from '../../src/lib/password';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * Bootstrap do primeiro ADMIN (FR-002-021 / AC-002-023 / DEC-003-008) sobre o
 * Postgres real (harness de TASK-003-016). Cobre: env completa cria exatamente 1
 * ADMIN com senha derivada; rerun idempotente; env ausente e env parcial não
 * criam ninguém; `SEED_ADMIN_PASSWORD` igual ao placeholder do `.env.example`
 * aborta sem criar e sem ecoar o valor.
 */

const VALID_EMAIL = 'admin.bootstrap@example.com';
const VALID_PASSWORD = 'bootstrap-secret-1234';

function countAdmins(): Promise<number> {
  return testPrisma.user.count({ where: { role: 'ADMIN' } });
}

/**
 * Lê o literal de `SEED_ADMIN_PASSWORD` direto do `.env.example` — a prova de que
 * o seed recusa o placeholder não pode depender da constante que o próprio seed
 * exporta, senão a mutação que troca uma sem a outra passaria despercebida.
 */
function envExampleAdminPassword(): string {
  const raw = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
  const line = raw.split(/\r?\n/).find((entry) => entry.startsWith('SEED_ADMIN_PASSWORD='));
  if (line === undefined) throw new Error('SEED_ADMIN_PASSWORD ausente de .env.example');
  return line
    .slice('SEED_ADMIN_PASSWORD='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('seedAdmin — AC-002-023: primeiro ADMIN a partir de env, sem senha embutida', () => {
  it('(a) credenciais presentes e base sem ADMIN: cria exatamente 1 ADMIN e a senha confere', async () => {
    const outcome = await seedAdmin(testPrisma, { email: VALID_EMAIL, password: VALID_PASSWORD });

    expect(outcome).toEqual({ status: 'created', email: VALID_EMAIL });
    expect(await countAdmins()).toBe(1);

    const admin = await testPrisma.user.findUniqueOrThrow({ where: { email: VALID_EMAIL } });
    expect(admin.role).toBe('ADMIN');
    expect(admin.name.length).toBeGreaterThan(0);
    expect(admin.passwordHash).not.toBe(VALID_PASSWORD);
    expect(await verifyPassword(VALID_PASSWORD, admin.passwordHash)).toBe(true);
  });

  it('(b) rerun com um ADMIN já presente: continua exatamente 1 (idempotência)', async () => {
    await seedAdmin(testPrisma, { email: VALID_EMAIL, password: VALID_PASSWORD });

    const second = await seedAdmin(testPrisma, {
      email: 'segundo.admin@example.com',
      password: 'segundo-bootstrap-99',
    });

    expect(second).toEqual({ status: 'exists' });
    expect(await countAdmins()).toBe(1);
    await expect(
      testPrisma.user.findUnique({ where: { email: 'segundo.admin@example.com' } }),
    ).resolves.toBeNull();
  });

  it('(c) nenhuma das duas variáveis: nenhum ADMIN criado', async () => {
    const outcome = await seedAdmin(testPrisma, { email: undefined, password: undefined });

    expect(outcome).toEqual({ status: 'not-configured' });
    expect(await countAdmins()).toBe(0);
  });

  it('(d) config parcial — só SEED_ADMIN_EMAIL: nenhum ADMIN criado, nenhuma senha default', async () => {
    const outcome = await seedAdmin(testPrisma, { email: VALID_EMAIL, password: undefined });

    expect(outcome).toEqual({ status: 'partial' });
    expect(await countAdmins()).toBe(0);
  });

  it('(d) config parcial — só SEED_ADMIN_PASSWORD: nenhum ADMIN criado', async () => {
    const outcome = await seedAdmin(testPrisma, { email: undefined, password: VALID_PASSWORD });

    expect(outcome).toEqual({ status: 'partial' });
    expect(await countAdmins()).toBe(0);
  });

  it('(e) SEED_ADMIN_PASSWORD igual ao literal do .env.example: aborta citando a variável, sem o valor, e não cria ADMIN', async () => {
    const placeholder = envExampleAdminPassword();
    // Guarda de sincronia: a constante exportada tem de bater com o .env.example real.
    expect(placeholder).toBe(ENV_EXAMPLE_ADMIN_PASSWORD_PLACEHOLDER);

    const error = await seedAdmin(testPrisma, {
      email: VALID_EMAIL,
      password: placeholder,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('SEED_ADMIN_PASSWORD');
    expect((error as Error).message).not.toContain(placeholder);
    expect(await countAdmins()).toBe(0);
  });
});
