import { pino } from 'pino';

import { env } from '../config/env';

// pino-pretty só em desenvolvimento: em teste ele abriria um worker thread que
// mantém o Jest pendurado, e em produção queremos JSON puro para o coletor.
const isDevelopment = env.NODE_ENV === 'development';

// Nada de credencial, token ou cookie no log — nem em desenvolvimento.
export const redactOptions = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    '*.password',
    '*.passwordHash',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    'DATABASE_URL',
    'JWT_SECRET',
    'SEED_ADMIN_PASSWORD',
    // O wildcard do pino cobre só um nível de aninhamento — segredos sob uma chave de
    // contexto (`{ env: { JWT_SECRET } }`, `{ session: { accessTokenHash } }`) exigem entrada própria.
    '*.JWT_SECRET',
    '*.DATABASE_URL',
    '*.SEED_ADMIN_PASSWORD',
    '*.accessTokenHash',
    '*.refreshTokenHash',
  ],
  censor: '[redigido]',
};

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: redactOptions,
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
});
