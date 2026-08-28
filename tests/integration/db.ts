import { PrismaPg } from '@prisma/adapter-pg';

import { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import { TEST_DATABASE_URL } from './db-url';

/**
 * `PrismaClient` exclusivo dos testes de integração.
 *
 * É **infra de teste**, por isso vive em `tests/` e não em `src/lib/prisma.ts`
 * (perfil §9: aquele arquivo é o único `new PrismaClient` de *produção*). Cache no
 * `globalThis` para não abrir um pool por reavaliação de módulo; a suíte roda em
 * série (`--runInBand`), daí o pool pequeno.
 */
const globalForTestPrisma = globalThis as typeof globalThis & {
  __mnemonicosTestPrisma?: PrismaClient;
};

export const testPrisma: PrismaClient =
  globalForTestPrisma.__mnemonicosTestPrisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 5 }),
  });

globalForTestPrisma.__mnemonicosTestPrisma = testPrisma;

// Reexportado daqui para que o namespace do client gerado (erros tipados como
// `PrismaClientKnownRequestError`) chegue aos testes por um único ponto.
export { Prisma };

/**
 * Zera todas as tabelas de dados do schema `public` — chamada no `beforeEach` de
 * cada arquivo `*.integration.test.ts` para isolar os casos.
 *
 * A lista sai do catálogo (`pg_tables`), então tabela nova entra sozinha; a tabela
 * de controle do Prisma Migrate (`_prisma_migrations`) fica de fora para o schema
 * não precisar ser remigrado a cada caso. `TRUNCATE ... CASCADE` dispensa ordenar
 * por FK; `RESTART IDENTITY` reinicia sequências.
 */
export async function resetDb(): Promise<void> {
  const tables = await testPrisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;

  if (tables.length === 0) return;

  // Identificadores vêm do catálogo do próprio banco de teste, não de entrada
  // externa — não há como parametrizar nome de tabela em `TRUNCATE`.
  const list = tables.map(({ tablename }) => `"public"."${tablename}"`).join(', ');
  await testPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Encerra o pool de conexões. Chamado no `afterAll` de cada arquivo e no `globalTeardown`. */
export async function closeTestDb(): Promise<void> {
  await testPrisma.$disconnect();
}
