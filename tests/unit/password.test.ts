import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { env } from '../../src/config/env';
import { hashPassword, verifyPassword } from '../../src/lib/password';

// Argon2id com m=19456 leva algumas dezenas de ms por chamada; a suíte encadeia
// vários hashes reais.
jest.setTimeout(20_000);

const PLAIN = 'senhaDe12chars!';

describe('hashPassword', () => {
  it('deriva um hash Argon2id — nunca a senha em claro', async () => {
    const hashed = await hashPassword(PLAIN);

    expect(hashed).toMatch(/^\$argon2id\$/);
    expect(hashed).not.toContain(PLAIN);
  });

  it('usa os parâmetros de custo de `env`, não valores embutidos', async () => {
    const hashed = await hashPassword(PLAIN);

    const params = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hashed);
    if (params === null) throw new Error(`hash sem parâmetros de custo legíveis: ${hashed}`);

    expect(Number(params[1])).toBe(env.ARGON2_MEMORY_KIB);
    expect(Number(params[2])).toBe(env.ARGON2_TIME_COST);
    expect(Number(params[3])).toBe(env.ARGON2_PARALLELISM);
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
