/**
 * Conjunto **fechado** de pares `"<MÉTODO> <caminho>"` que dispensam sessão — a
 * exceção declarada ao deny-by-default (§6.3 do perfil; DEC-003-005 + EMENDA da
 * Wave 6). `requireAuth` compara `"${req.method} ${req.path}"` contra esta lista
 * por igualdade **exata**, antes de qualquer resolução de sessão: `GET /health` /
 * `GET /health/db` (liveness/readiness) e os dois `POST` que estabelecem ou
 * renovam a sessão.
 *
 * A chave inclui o método porque a barreira (`ROUTE_ROLES`) já o inclui desde a
 * EMENDA da Wave 4: quando a chave de uma decisão de autorização ganha uma
 * dimensão, **todos** os leitores dessa decisão ganham a mesma — inclusive a
 * allowlist de exceção, que é a superfície mais larga. `DELETE /health` ou
 * `GET /auth/login` **não** são públicos.
 *
 * Crescer esta lista é ato deliberado — TASK-003-011 fixa o snapshot na suíte de
 * conformidade; TASK-003-009 e TASK-003-011 importam a constante, nunca a grafia
 * solta.
 */
export const PUBLIC_PATH_ALLOWLIST = [
  'GET /health',
  'GET /health/db',
  'POST /auth/login',
  'POST /auth/refresh',
] as const;

/** `true` se o par `"<method> <path>"` (comparação exata) está na allowlist pública. */
export function isPublicPath(method: string, path: string): boolean {
  return (PUBLIC_PATH_ALLOWLIST as readonly string[]).includes(`${method} ${path}`);
}
