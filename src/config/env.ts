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

  /// Canal seguro do cookie de sessão (NFR-002-008). Default acompanha produção; afinável sem redeploy.
  /// `z.enum` + `transform` em vez de `z.coerce.boolean()`: valor inválido (`''`, `'0'`, `'no'`) derruba o
  /// boot em vez de virar `false`/`true` silenciosamente (perfil §6.4).
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default(process.env.NODE_ENV === 'production' ? 'true' : 'false')
    .transform((value) => value === 'true'),

  /// Credenciais de bootstrap do 1º ADMIN, lidas pelo seed. Ausentes (ou só uma delas) → o seed não cria ninguém.
  SEED_ADMIN_EMAIL: z.email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(12).optional(),

  /// TTLs de sessão (DEC-003-003), afináveis sem redeploy.
  AUTH_ACCESS_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /// Janela de graça para renovações concorrentes do SPA (AC-002-026).
  AUTH_REFRESH_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(10),

  /// Parâmetros de custo do Argon2id (DEC-003-001), ponto de partida OWASP.
  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),
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
