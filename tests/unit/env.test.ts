import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import dotenv from 'dotenv';

import type * as EnvModule from '../../src/config/env';

/**
 * Chaves acrescentadas ao `envSchema` pela fatia de acesso interno (COMP-003-001).
 */
const NEW_ENV_KEYS = [
  'COOKIE_SECURE',
  'SEED_ADMIN_EMAIL',
  'SEED_ADMIN_PASSWORD',
  'AUTH_ACCESS_TTL_MINUTES',
  'AUTH_REFRESH_TTL_DAYS',
  'AUTH_REFRESH_GRACE_SECONDS',
  'ARGON2_MEMORY_KIB',
  'ARGON2_TIME_COST',
  'ARGON2_PARALLELISM',
] as const;

function loadEnvModule(): typeof EnvModule {
  let mod: typeof EnvModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../src/config/env') as typeof EnvModule;
  });
  return mod as typeof EnvModule;
}

describe('config/env — variáveis da fatia de acesso interno', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('aplica os defaults de COMP-003-001 quando as chaves estão ausentes do ambiente', () => {
    for (const key of NEW_ENV_KEYS) delete process.env[key];

    const { env } = loadEnvModule();

    expect(env.AUTH_ACCESS_TTL_MINUTES).toBe(15);
    expect(env.AUTH_REFRESH_TTL_DAYS).toBe(7);
    expect(env.AUTH_REFRESH_GRACE_SECONDS).toBe(10);
    expect(env.ARGON2_MEMORY_KIB).toBe(19456);
    expect(env.ARGON2_TIME_COST).toBe(2);
    expect(env.ARGON2_PARALLELISM).toBe(1);
    expect(typeof env.COOKIE_SECURE).toBe('boolean');
  });

  it('deriva o default de COOKIE_SECURE de NODE_ENV: false fora de produção', () => {
    for (const key of NEW_ENV_KEYS) delete process.env[key];
    process.env.NODE_ENV = 'test';

    const { env, isProduction } = loadEnvModule();

    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.COOKIE_SECURE).toBe(isProduction);
  });

  it('lê COOKIE_SECURE=false do ambiente como o booleano false', () => {
    for (const key of NEW_ENV_KEYS) delete process.env[key];
    process.env.COOKIE_SECURE = 'false';

    const { env } = loadEnvModule();

    expect(env.COOKIE_SECURE).toBe(false);
  });

  it('lê COOKIE_SECURE=true do ambiente como o booleano true', () => {
    for (const key of NEW_ENV_KEYS) delete process.env[key];
    process.env.COOKIE_SECURE = 'true';

    const { env } = loadEnvModule();

    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('derruba o boot quando COOKIE_SECURE vem vazio, citando só o nome da variável', () => {
    process.env.COOKIE_SECURE = '';

    let caught: Error | undefined;
    try {
      loadEnvModule();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('COOKIE_SECURE');
  });

  it('derruba o boot quando COOKIE_SECURE tem valor inválido, sem ecoar o valor', () => {
    const invalidValue = 'yes';

    process.env.COOKIE_SECURE = invalidValue;

    let caught: Error | undefined;
    try {
      loadEnvModule();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('COOKIE_SECURE');
    expect(caught?.message).not.toContain(invalidValue);
  });

  it('coage o TTL de acesso vindo do ambiente para número', () => {
    delete process.env.SEED_ADMIN_EMAIL;
    delete process.env.SEED_ADMIN_PASSWORD;
    process.env.AUTH_ACCESS_TTL_MINUTES = '30';

    const { env } = loadEnvModule();

    expect(env.AUTH_ACCESS_TTL_MINUTES).toBe(30);
  });

  it('recusa SEED_ADMIN_PASSWORD com menos de 12 caracteres, citando só o nome da variável', () => {
    const shortSecret = 'abcdefghijk'; // 11 caracteres

    process.env.SEED_ADMIN_PASSWORD = shortSecret;

    let caught: Error | undefined;
    try {
      loadEnvModule();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('SEED_ADMIN_PASSWORD');
    expect(caught?.message).not.toContain(shortSecret);
  });

  it('aceita SEED_ADMIN_PASSWORD com 12 caracteres ou mais', () => {
    process.env.SEED_ADMIN_PASSWORD = 'senha-de-bootstrap-ficticia';
    process.env.SEED_ADMIN_EMAIL = 'admin@example.com';

    const { env } = loadEnvModule();

    expect(env.SEED_ADMIN_PASSWORD).toBe('senha-de-bootstrap-ficticia');
    expect(env.SEED_ADMIN_EMAIL).toBe('admin@example.com');
  });
});

describe('.env.example — chaves da fatia de acesso interno', () => {
  it('lista cada uma das 9 chaves novas do envSchema', () => {
    const content = readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf8');

    for (const key of NEW_ENV_KEYS) {
      expect(content).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });
});

/**
 * `dotenv` não distingue chave ausente de `CHAVE=` sem valor — as duas chegam
 * como `''` em `process.env`. Todo campo `.optional()` que possa receber
 * string vazia do `.env` tem de tratá-la como ausente, nunca como valor
 * inválido — é uma condição da CLASSE inteira de campo opcional, não só dos
 * dois campos do EDITOR.
 */
describe('envSchema — string vazia em campo .optional() é tratada como ausente (dotenv não distingue os dois)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const OPTIONAL_STRING_KEYS = [
    'SEED_ADMIN_EMAIL',
    'SEED_ADMIN_PASSWORD',
    'SEED_EDITOR_EMAIL',
    'SEED_EDITOR_PASSWORD',
    'DIRECT_URL',
  ] as const;

  it.each(OPTIONAL_STRING_KEYS)(
    '%s = "" não derruba o boot — vira undefined, não string vazia',
    (key) => {
      process.env[key] = '';

      const { env } = loadEnvModule();

      expect(env[key]).toBeUndefined();
    },
  );
});

/**
 * O "nunca mais" da classe inteira: o `.env.example` **versionado** — o mesmo
 * que `cp .env.example .env` produz, com `SEED_EDITOR_EMAIL=`/`SEED_EDITOR_PASSWORD=`
 * vazios — tem de validar com sucesso contra o `envSchema` real. Mutante: reverter
 * a normalização de `optionalEmptyString` faz este teste voltar a falhar (o campo
 * vazio reprova `z.email()`/`z.string().min(12)`, que só perdoam ausência).
 */
describe('.env.example — carrega com sucesso no envSchema real (nunca derruba o boot de quem segue cp .env.example .env)', () => {
  it('envSchema.safeParse(.env.example) → success: true', () => {
    const content = readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf8');
    const parsedFile = dotenv.parse(content);

    let result: { success: boolean; error?: unknown } | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { envSchema } = require('../../src/config/env') as typeof EnvModule;
      result = envSchema.safeParse(parsedFile);
    });

    expect(result?.success).toBe(true);
  });
});
