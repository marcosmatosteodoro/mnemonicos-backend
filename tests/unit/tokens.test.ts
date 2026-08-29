import { createHash, createHmac } from 'node:crypto';

import { env } from '../../src/config/env';
import type * as TokensModule from '../../src/lib/tokens';
import { generateToken, hashToken, tokensMatch } from '../../src/lib/tokens';

/** HMAC-SHA256(token, secret) em base64url, calculado sem passar por `tokens.ts`. */
function independentHmac(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('base64url');
}

/** Recarrega `tokens.ts` (e o `env` que ele lê) sob um `JWT_SECRET` diferente. */
function loadTokensWithSecret(secret: string): typeof TokensModule {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  let mod: typeof TokensModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../src/lib/tokens') as typeof TokensModule;
  });
  process.env.JWT_SECRET = previous;
  if (mod === undefined) throw new Error('falha ao recarregar src/lib/tokens');
  return mod;
}

describe('generateToken', () => {
  it('devolve 43 caracteres base64url (32 bytes de entropia)', () => {
    const token = generateToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('devolve um valor diferente a cada chamada', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));

    expect(tokens.size).toBe(50);
  });
});

describe('hashToken', () => {
  it('é HMAC-SHA256(token, JWT_SECRET) em base64url — não sha256(token + segredo)', () => {
    const token = generateToken();

    const hmac = independentHmac(token, env.JWT_SECRET);
    const naiveConcat = createHash('sha256')
      .update(token + env.JWT_SECRET)
      .digest('base64url');

    expect(hashToken(token)).toBe(hmac);
    expect(hashToken(token)).not.toBe(naiveConcat);
  });

  it('é determinístico para o mesmo token', () => {
    const token = generateToken();

    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('muda quando JWT_SECRET muda', () => {
    const token = generateToken();
    const secretA = 'segredo-de-teste-A-com-mais-de-32-caracteres';
    const secretB = 'segredo-de-teste-B-com-mais-de-32-caracteres';

    const underA = loadTokensWithSecret(secretA).hashToken(token);
    const underB = loadTokensWithSecret(secretB).hashToken(token);

    expect(underA).toBe(independentHmac(token, secretA));
    expect(underB).toBe(independentHmac(token, secretB));
    expect(underA).not.toBe(underB);
  });
});

describe('tokensMatch', () => {
  it('confirma um token contra o seu próprio hash', () => {
    const token = generateToken();

    expect(tokensMatch(token, hashToken(token))).toBe(true);
  });

  it('rejeita um token que não corresponde ao hash guardado', () => {
    const token = generateToken();

    expect(tokensMatch('outro-token', hashToken(token))).toBe(false);
  });

  it('rejeita — sem lançar — um hash guardado de tamanho inesperado', () => {
    const token = generateToken();

    expect(tokensMatch(token, 'hash-curto')).toBe(false);
  });
});
