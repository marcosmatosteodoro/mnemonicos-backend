import { Router } from 'express';

import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';

export const healthRoutes = Router();

/** Liveness: responde sem tocar em dependência externa. */
healthRoutes.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    environment: env.NODE_ENV,
    uptime: Math.round(process.uptime()),
  });
});

/** Readiness: confirma que o Postgres responde. */
healthRoutes.get('/health/db', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'reachable' });
  } catch (err) {
    // A mensagem do driver pode revelar host, usuário e nome do banco: só no log.
    logger.error({ err }, 'health check do banco falhou');
    res.status(503).json({
      error: { code: 'DATABASE_UNAVAILABLE', message: 'Banco de dados indisponível.' },
    });
  }
});
