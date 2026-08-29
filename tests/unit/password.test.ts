import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { env } from '../../src/config/env';
import type * as PasswordModule from '../../src/lib/password';
import { hashPassword, verifyPassword } from '../../src/lib/password';

// Argon2id com m=19456 leva algumas dezenas de ms por chamada; a suíte encadeia
// vários hashes reais.
jest.setTimeout(20_000);

const PLAIN = 'senhaDe12chars!';

interface Argon2Cost {
  memoryKib: number;
  timeCost: number;
  parallelism: number;
}

/** Lê `m=/t=/p=` do digest Argon2 (PHC string). */
function costParamsOf(hashed: string): Argon2Cost {
  const params = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hashed);
  if (params === null) throw new Error(`hash sem parâmetros de custo legíveis: ${hashed}`);

  return {
    memoryKib: Number(params[1]),
    timeCost: Number(params[2]),
    parallelism: Number(params[3]),
  };
}

/**
 * Recarrega `password.ts` (e o `env` que ele lê) sob parâmetros de custo Argon2
 * diferentes dos de `tests/setup-env.ts` — mesma técnica de `tokens.test.ts`.
 */
function loadPasswordWithCost(cost: Argon2Cost): typeof PasswordModule {
  const previous = {
    memoryKib: process.env.ARGON2_MEMORY_KIB,
    timeCost: process.env.ARGON2_TIME_COST,
    parallelism: process.env.ARGON2_PARALLELISM,
  };
  process.env.ARGON2_MEMORY_KIB = String(cost.memoryKib);
  process.env.ARGON2_TIME_COST = String(cost.timeCost);
  process.env.ARGON2_PARALLELISM = String(cost.parallelism);
  let mod: typeof PasswordModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../src/lib/password') as typeof PasswordModule;
  });
  process.env.ARGON2_MEMORY_KIB = previous.memoryKib;
  process.env.ARGON2_TIME_COST = previous.timeCost;
  process.env.ARGON2_PARALLELISM = previous.parallelism;
  if (mod === undefined) throw new Error('falha ao recarregar src/lib/password');
  return mod;
}

describe('hashPassword', () => {
  it('deriva um hash Argon2id — nunca a senha em claro', async () => {
    const hashed = await hashPassword(PLAIN);

    expect(hashed).toMatch(/^\$argon2id\$/);
    expect(hashed).not.toContain(PLAIN);
  });

  it('grava no digest os parâmetros de custo configurados no ambiente', async () => {
    const cost = costParamsOf(await hashPassword(PLAIN));

    expect(cost).toEqual({
      memoryKib: env.ARGON2_MEMORY_KIB,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    });
  });

  it('lê o custo de `env` a cada carga do módulo — não são valores embutidos', async () => {
    // Custo distinto do `setup-env` (19456/2/1): se `password.ts` fixasse um
    // literal, o digest ignoraria estes valores e o `toEqual` abaixo falharia.
    const { hashPassword: hashUnderCost } = loadPasswordWithCost({
      memoryKib: 8192,
      timeCost: 3,
      parallelism: 2,
    });

    const cost = costParamsOf(await hashUnderCost(PLAIN));

    expect(cost).toEqual({ memoryKib: 8192, timeCost: 3, parallelism: 2 });
  });

  it('produz hashes distintos para a mesma senha (salt aleatório)', async () => {
    const a = await hashPassword(PLAIN);
    const b = await hashPassword(PLAIN);

    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('confirma a senha correta contra o próprio hash', async () => {
    const hashed = await hashPassword(PLAIN);

    await expect(verifyPassword(PLAIN, hashed)).resolves.toBe(true);
  });

  it('rejeita uma senha errada', async () => {
    const hashed = await hashPassword(PLAIN);

    await expect(verifyPassword('outraSenha!!', hashed)).resolves.toBe(false);
  });

  it('devolve false para hash malformado, sem lançar', async () => {
    await expect(verifyPassword('x', 'isto-nao-e-um-hash-argon2')).resolves.toBe(false);
  });
});

describe('src/lib/password.ts — sem API bloqueante', () => {
  it('não referencia nenhuma variante *Sync do argon2 (event loop — perfil §10)', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'password.ts'), 'utf8');

    expect(source).not.toMatch(/\b(hashSync|verifySync|hashRawSync)\b/);
  });
});
