import 'dotenv/config';

import { defineConfig } from 'prisma/config';

/**
 * Configuração do CLI do Prisma (migrate, db, studio, generate).
 *
 * A URL de runtime não passa por aqui — em `src/lib/prisma.ts` a conexão é feita
 * pelo driver adapter. Este arquivo só interessa aos comandos de migração, que
 * precisam de conexão direta: pgbouncer não suporta os statements de DDL que o
 * Migrate emite. Daí DIRECT_URL ter precedência sobre DATABASE_URL aqui.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
