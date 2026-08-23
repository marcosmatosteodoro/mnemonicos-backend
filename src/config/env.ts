import 'dotenv/config';

import { z } from 'zod';

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: 'deve ser uma URL postgresql://',
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3333),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /// Allowlist de origens do CORS. Deny-by-default: sem entrada, nenhuma origem passa.
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: postgresUrl,
  DIRECT_URL: postgresUrl.optional(),

  /// 32 caracteres é o piso; gere com `openssl rand -base64 48`.
  JWT_SECRET: z.string().min(32, 'deve ter ao menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('15m'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Apenas os NOMES das variáveis e as mensagens — jamais os valores, que são segredos.
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Variáveis de ambiente inválidas:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
