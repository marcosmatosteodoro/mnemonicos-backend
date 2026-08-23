import cors, { type CorsOptions } from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env, isTest } from './config/env';
import { ForbiddenError } from './http/errors';
import { errorHandler, notFoundHandler } from './http/middlewares/error-handler';
import { apiRoutes } from './http/routes';
import { logger } from './lib/logger';

export const API_PREFIX = '/api/v1';

/**
 * Allowlist explícita: uma origem só passa se estiver em CORS_ORIGINS.
 * Requisições sem header `Origin` (curl, health check da plataforma, chamadas
 * servidor-a-servidor) não são cross-origin e seguem.
 */
const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || env.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new ForbiddenError('Origem não permitida.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86_400,
};

/**
 * Limite em memória: protege contra abuso trivial, mas em serverless o contador
 * é por instância. Para proteção real, trocar por um store compartilhado (Redis).
 */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});

export function createApp(): Express {
  const app = express();

  // Atrás do proxy da Vercel: sem isso req.ip é o do proxy e o rate limit vira global.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(limiter);
  // Corpo pequeno de propósito: a API recebe texto de mnemônico, não upload.
  app.use(express.json({ limit: '100kb' }));
  app.use(pinoHttp({ logger }));

  app.use(API_PREFIX, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
