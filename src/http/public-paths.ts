/**
 * Conjunto **fechado** de caminhos que dispensam sessão — a exceção declarada ao
 * deny-by-default (§6.3 do perfil; DEC-003-005). `requireAuth` compara `req.path`
 * contra esta lista por igualdade **exata**, antes de qualquer resolução de
 * sessão: `health`/`health/db` (liveness/readiness) e as duas rotas que
 * estabelecem ou renovam a sessão.
 *
 * Crescer esta lista é ato deliberado — TASK-003-011 fixa o snapshot na suíte de
 * conformidade; TASK-003-009 e TASK-003-011 importam a constante, nunca a grafia
 * solta.
 */
export const PUBLIC_PATH_ALLOWLIST = [
  '/health',
  '/health/db',
  '/auth/login',
  '/auth/refresh',
] as const;

/** `true` se `path` (comparação exata) está na allowlist pública. */
export function isPublicPath(path: string): boolean {
  return (PUBLIC_PATH_ALLOWLIST as readonly string[]).includes(path);
}
