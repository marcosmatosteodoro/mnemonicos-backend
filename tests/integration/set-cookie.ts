import type { Response } from 'supertest';

/**
 * Leitura estrutural de cabeçalhos `Set-Cookie` — infra compartilhada pelas
 * suítes de rota de auth (`auth.routes*.test.ts`). Não é `*.test.ts` nem
 * `*.integration.test.ts`, então nenhum runner a recolhe.
 */
export interface ParsedCookie {
  name: string;
  value: string;
  /** Atributos com a chave em minúsculas (`path`, `max-age`, `httponly`, `samesite`, `expires`, `secure`). */
  attrs: Record<string, string | true>;
}

export function parseSetCookie(header: string): ParsedCookie {
  const parts = header.split(';').map((part) => part.trim());
  const pair = parts[0] ?? '';
  const rest = parts.slice(1);
  const eq = pair.indexOf('=');
  const attrs: Record<string, string | true> = {};
  for (const part of rest) {
    const i = part.indexOf('=');
    if (i === -1) attrs[part.toLowerCase()] = true;
    else attrs[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

export function setCookies(res: Response): ParsedCookie[] {
  const raw = res.headers['set-cookie'] as string[] | undefined;
  return (raw ?? []).map(parseSetCookie);
}

/** O cookie de nome `name` no `Set-Cookie` da resposta; lança se ausente. */
export function cookie(res: Response, name: string): ParsedCookie {
  const found = setCookies(res).find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`Set-Cookie ausente: ${name}`);
  return found;
}
