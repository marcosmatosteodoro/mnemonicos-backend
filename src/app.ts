import cookieParser from 'cookie-parser';
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

/** Teto do freio global da API em uma janela de 15 min — os freios dedicados (ex.: login) ficam abaixo dele. */
export const GLOBAL_RATE_LIMIT_MAX = 300;

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
  limit: GLOBAL_RATE_LIMIT_MAX,
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
  // Parsing de `Cookie` — Express 5 não traz no core. **Sem segredo**: o token de
  // sessão já é opaco de 256 bits e validado por hash no servidor (DEC-003-002/004),
  // então cookie assinado só somaria um 2º mecanismo de integridade e o
  // `cookie-signature` transitivo. Antes de `apiRoutes` para o `requireAuth` da
  // fatia de acesso enxergar `req.cookies`.
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  app.use(API_PREFIX, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
