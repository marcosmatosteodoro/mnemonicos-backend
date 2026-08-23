import { pino } from 'pino';

import { env } from '../config/env';

// pino-pretty só em desenvolvimento: em teste ele abriria um worker thread que
// mantém o Jest pendurado, e em produção queremos JSON puro para o coletor.
const isDevelopment = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  // Nada de credencial, token ou cookie no log — nem em desenvolvimento.
  redact: {
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
    ],
    censor: '[redigido]',
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
});
