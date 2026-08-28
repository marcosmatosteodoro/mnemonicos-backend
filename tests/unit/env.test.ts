import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
