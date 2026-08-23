import { app } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'mnemonicos-backend no ar');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'encerrando');

  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });

  // Rede pendurada não pode travar o deploy: prazo máximo para encerrar.
  setTimeout(() => process.exit(1), 10_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown(signal));
}
