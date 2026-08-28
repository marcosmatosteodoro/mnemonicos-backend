import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { Client } from 'pg';

import { TEST_DATABASE_URL } from './db-url';

/**
 * `globalSetup` do runner de integração (roda uma vez, antes de qualquer arquivo):
 *
 *  1. cria o banco `mnemonicos_test` se ele ainda não existir;
 *  2. aplica todas as migrações versionadas nele (`prisma migrate deploy`).
 *
 * Idempotente: banco já criado e migrações já aplicadas → os dois passos são
 * no-op. O banco **não** é dropado no teardown — reusá-lo entre execuções economiza
 * o custo de recriar o schema.
 */

const TEST_DB_NAME = 'mnemonicos_test';
// tests/integration → tests → raiz do backend (onde vive prisma.config.ts).
const BACKEND_ROOT = resolve(__dirname, '..', '..');

async function ensureDatabaseExists(): Promise<void> {
  // CREATE DATABASE não roda dentro do próprio banco-alvo nem em transação;
  // conecta no banco administrativo `postgres` do mesmo servidor.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [TEST_DB_NAME],
    );
    if (!rows[0]?.exists) {
      // Identificador não é parametrizável em DDL; `TEST_DB_NAME` é constante
      // literal deste arquivo, nunca entrada externa.
      await client.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
    }
  } finally {
    await client.end();
  }
}

function applyMigrations(): void {
  // `prisma migrate deploy` lê a conexão de `prisma.config.ts`, que dá precedência
  // a `DIRECT_URL`. Passamos as duas apontando para o banco de teste — `dotenv`
  // não sobrescreve variável já presente, então o `.env` do dev não vaza aqui.
  execSync('npx prisma migrate deploy', {
    cwd: BACKEND_ROOT,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DIRECT_URL: TEST_DATABASE_URL },
  });
}

export default async function globalSetup(): Promise<void> {
  await ensureDatabaseExists();
  applyMigrations();
}
