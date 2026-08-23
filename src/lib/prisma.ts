import { PrismaPg } from '@prisma/adapter-pg';

import { env, isProduction } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { logger } from './logger';

/**
 * No Prisma 7 a conexão de runtime vem de um driver adapter, não da URL no
 * schema. Pool pequeno de propósito: em serverless cada instância abre o seu,
 * e o limite de conexões do Postgres é compartilhado entre todas elas —
 * DATABASE_URL deve apontar para o pooler (pgbouncer).
 */
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: isProduction ? 3 : 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  const client = new PrismaClient({
    adapter,
    // Eventos em vez de stdout: assim os logs do Prisma passam pela redação do
    // pino e saem no mesmo formato do resto da aplicação.
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

  client.$on('error', (event) => {
    logger.error({ prisma: event }, 'erro do prisma');
  });

  client.$on('warn', (event) => {
    logger.warn({ prisma: event }, 'aviso do prisma');
  });

  return client;
}

/**
 * Cache no globalThis: o hot-reload do dev reavalia os módulos e o runtime
 * serverless reusa o processo entre invocações. Sem isso, um pool novo por
 * reavaliação esgotaria as conexões do banco.
 */
const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
