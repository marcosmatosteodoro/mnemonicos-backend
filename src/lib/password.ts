import { hash, type Options, verify } from '@node-rs/argon2';

import { env } from '../config/env';

/**
 * `Algorithm.Argon2id` do pacote vale `2`. O enum é um `const enum` ambiente e
 * não pode ser lido como valor sob `isolatedModules` (TS2748), então o literal é
 * fixado com o tipo do próprio pacote — se a lib mudar o enum, o typecheck acusa.
 * Fixar o algoritmo explicitamente evita depender do default da biblioteca numa
 * superfície sensível (nunca Argon2i/Argon2d — DEC-003-001).
 */
const ARGON2ID: NonNullable<Options['algorithm']> = 2;

/**
 * Custo do Argon2id lido de `env` (DEC-003-001), afinável sem redeploy. Ponto de
 * partida OWASP: m = 19456 KiB, t = 2, p = 1.
 */
const ARGON2_OPTIONS = {
  memoryCost: env.ARGON2_MEMORY_KIB,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
  algorithm: ARGON2ID,
};

/**
 * Deriva o hash Argon2id de uma senha em claro. Sempre assíncrono (a variante
 * `*Sync` bloquearia o event loop — perfil §10). O digest carrega o identificador
 * do algoritmo e os parâmetros de custo, permitindo re-hash transparente depois.
 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Confere uma senha em claro contra um hash Argon2id. Devolve `false` — nunca
 * lança — quando o hash está malformado ou corrompido: quem chama não deve
 * precisar de um `try/catch` para decidir "não libera".
 */
export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
