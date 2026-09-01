/**
 * Nomes dos cookies de sessão — e só os nomes. As opções (flags `httpOnly`,
 * `secure` em produção, `sameSite`, `path`, `maxAge`) são da TASK-003-009
 * (DEC-003-004). `requireAuth` lê `ACCESS_COOKIE`; TASK-003-009 escreve e limpa
 * os dois, importando estes símbolos em vez de repetir a grafia.
 */
export const ACCESS_COOKIE = 'mnemo_access';
export const REFRESH_COOKIE = 'mnemo_refresh';
