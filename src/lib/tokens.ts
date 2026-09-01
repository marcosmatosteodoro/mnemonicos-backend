import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from '../config/env';

/**
 * Gera um token opaco de 256 bits de entropia criptográfica, codificado em
 * base64url (43 caracteres, sem padding). `crypto.randomBytes` — nunca
 * `Math.random`, que não é criptográfico (perfil §6.4).
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Deriva o valor persistível de um token: HMAC-SHA256 com `JWT_SECRET` como
 * chave (DEC-003-002). É HMAC, **nunca** `sha256(token + segredo)` — essa
 * construção ingênua é exatamente o que o HMAC existe para substituir. O token
 * em claro nunca é guardado; só este digest.
 */
export function hashToken(token: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(token).digest('base64url');
}

/**
 * Confere um token candidato contra o hash guardado, em tempo constante.
 * `crypto.timingSafeEqual` exige buffers de mesmo tamanho e lança se diferirem —
 * por isso a comparação é feita sobre os digests (SHA-256, sempre 32 bytes) e a
 * diferença de tamanho é tratada como "não confere" (fail secure), nunca
 * propagada como exceção.
 */
export function tokensMatch(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), 'base64url');
  const stored = Buffer.from(storedHash, 'base64url');

  if (candidate.length !== stored.length) return false;

  return timingSafeEqual(candidate, stored);
}
