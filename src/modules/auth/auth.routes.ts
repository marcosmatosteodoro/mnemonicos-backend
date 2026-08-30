import {
  Router,
  type CookieOptions,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { env } from '../../config/env';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../http/cookies';
import { ForbiddenError, UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { changePasswordSchema, loginSchema } from './auth.schema';
import {
  changeOwnPassword,
  getSessionUser,
  type IssuedSession,
  login,
  logout,
  refresh,
  type RequestOrigin,
} from './auth.service';
import { loginRateLimiters } from './login-rate-limit';

/**
 * Superfície HTTP de auth (COMP-003-010 / NFR-002-008). Escreve e limpa os
 * cookies de sessão com as flags da DEC-003-004, aplica `requireRole` (que
 * também declara o par método+caminho em `ROUTE_ROLES` na montagem) nas rotas
 * protegidas e verifica `Origin`/`Host` nas rotas POST que mudam estado. Sem
 * `try/catch`: o Express 5 encaminha a rejeição ao `errorHandler`.
 *
 * As rotas são expostas em dois sub-routers para a montagem plana de TASK-003-011:
 * `publicAuthRoutes` (`POST /auth/login`, `POST /auth/refresh`) entra **antes** de
 * `requireAuth`; `protectedAuthRoutes` (`POST /auth/logout`,
 * `POST /auth/change-password`, `GET /auth/me`) entra **depois**. `authRoutes`
 * combina os dois — a superfície que os harnesses de teste montam atrás de um
 * único `requireAuth` (as públicas seguem pela allowlist de `requireAuth`). A
 * ordem × `requireAuth`, a allowlist pública e o `sealRouteRoles()` são de
 * TASK-003-011.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * 60_000;

/**
 * Flags do cookie de acesso `mnemo_access` (DEC-003-004): raiz do site,
 * inacessível a script, canal seguro conforme `env.COOKIE_SECURE` (NFR-002-008),
 * submissão same-site `lax` — `strict` deslogaria quem chega por link externo.
 * **Sem assinatura**: o valor já é opaco e validado por hash no servidor. `maxAge`
 * é ms na API do Express e sai como `Max-Age` em segundos.
 */
export function accessCookieOptions(): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    maxAge: env.AUTH_ACCESS_TTL_MINUTES * MS_PER_MINUTE,
  };
}

/**
 * Como `accessCookieOptions`, mas o refresh `mnemo_refresh` só trafega sob
 * `/api/v1/auth` (não acompanha toda requisição) e vive o TTL longo (DEC-003-004).
 */
export function refreshCookieOptions(): CookieOptions {
  return {
    path: '/api/v1/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    maxAge: env.AUTH_REFRESH_TTL_DAYS * MS_PER_DAY,
  };
}

/**
 * Verificação de `Origin`/`Host` nas rotas POST de auth que mudam estado
 * (DEC-003-004; TRISK-003-002). Route handlers não herdam proteção CSRF e o
 * cookie é `sameSite: 'lax'` — um POST cross-site forjado ainda leva o cookie
 * junto. Um navegador sempre envia `Origin` num POST cross-site; sem ele, cai no
 * host do `Referer`. Requisição sem nenhum dos dois (curl, servidor-a-servidor)
 * não é vetor de CSRF de navegador e segue — a mesma postura do CORS de
 * `src/app.ts`. F1 assume mesmo site (dev local + `CORS_ORIGINS`); cross-domain
 * exigirá `SameSite=None` + token anti-CSRF (o `Reabrir se:` da DEC-003-004).
 */
export const verifyOrigin: RequestHandler = (req, _res, next) => {
  const stated = req.get('origin') ?? originOf(req.get('referer'));
  if (stated === undefined || env.CORS_ORIGINS.includes(stated)) {
    next();
    return;
  }
  next(new ForbiddenError('Origem não permitida.'));
};

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    // Referer malformado → sem origem verificável; o chamador trata como ausente.
    return undefined;
  }
}

/** Origem da requisição a partir da conexão — nunca do corpo (NFR-002-002/005). */
function requestOrigin(req: Request): RequestOrigin {
  return { ip: req.ip ?? '', userAgent: req.get('user-agent') };
}

function readCookie(req: Request, name: string): string | undefined {
  const jar: unknown = req.cookies;
  if (typeof jar !== 'object' || jar === null) return undefined;
  const value = (jar as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function setSessionCookies(res: Response, issued: IssuedSession): void {
  res.cookie(ACCESS_COOKIE, issued.access.value, accessCookieOptions());
  res.cookie(REFRESH_COOKIE, issued.refresh.value, refreshCookieOptions());
}

function clearSessionCookies(res: Response): void {
  // `clearCookie` do Express 5 descarta `maxAge` e força `Expires` no passado; só
  // o `path` precisa casar com o do `res.cookie` para o navegador remover o certo.
  res.clearCookie(ACCESS_COOKIE, accessCookieOptions());
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
}

/**
 * Rotas públicas de sessão — entram **antes** de `requireAuth` na árvore de
 * TASK-003-011 (e estão em `PUBLIC_PATH_ALLOWLIST`).
 */
export const publicAuthRoutes = Router();

/**
 * Rotas de auth que exigem sessão — entram **depois** de `requireAuth`. Cada uma
 * declara seu par método+caminho em `ROUTE_ROLES` via `requireRole(...)` na
 * montagem.
 */
export const protectedAuthRoutes = Router();

/**
 * POST /auth/login — pública (em `PUBLIC_PATH_ALLOWLIST`; precedida pelos freios
 * de taxa). Sucesso: escreve os dois cookies de sessão e devolve o `SessionUser`
 * (sem valor de token — NFR-002-004). Credencial inválida → `login` lança
 * `UnauthorizedError` genérico, que o `errorHandler` traduz em 401.
 */
publicAuthRoutes.post('/auth/login', verifyOrigin, ...loginRateLimiters, async (req, res) => {
  const credentials = loginSchema.parse(req.body);
  const issued = await login({ ...credentials, ...requestOrigin(req) });
  setSessionCookies(res, issued);
  res.json(issued.user);
});

/**
 * POST /auth/refresh — pública. Lê o refresh do cookie, rotaciona e reemite os
 * dois cookies. Token ausente/inválido/reusado → `refresh` lança
 * `UnauthorizedError` (mesma recusa genérica do login).
 */
publicAuthRoutes.post('/auth/refresh', verifyOrigin, async (req, res) => {
  const issued = await refresh(readCookie(req, REFRESH_COOKIE), requestOrigin(req), new Date());
  setSessionCookies(res, issued);
  res.json(issued.user);
});

/**
 * POST /auth/logout — protegida. `requireRole` declara `"POST /auth/logout" →
 * {EDITOR, ADMIN}` em `ROUTE_ROLES` na montagem. Revoga a família no servidor e
 * limpa os dois cookies; token ausente → `logout` é no-op e os cookies são
 * limpos de todo modo.
 */
protectedAuthRoutes.post(
  '/auth/logout',
  verifyOrigin,
  requireRole('POST', '/auth/logout', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    await logout(readCookie(req, REFRESH_COOKIE), requestOrigin(req));
    clearSessionCookies(res);
    res.status(204).end();
  },
);

/**
 * POST /auth/change-password — protegida. A identidade é sempre a da sessão
 * resolvida (`req.auth`), nunca do corpo (NFR-002-002). Senha atual errada →
 * `changeOwnPassword` lança `UnauthorizedError` sem alterar nada.
 */
protectedAuthRoutes.post(
  '/auth/change-password',
  verifyOrigin,
  requireRole('POST', '/auth/change-password', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    if (req.auth === undefined) throw new UnauthorizedError();
    const body = changePasswordSchema.parse(req.body);
    await changeOwnPassword(req.auth.userId, body, req.auth.sessionId);
    res.status(204).end();
  },
);

/**
 * GET /auth/me — protegida. `getSessionUser` (COMP-003-008) traz
 * `{id,name,email,role}` da conta da sessão; conta desativada no meio da sessão
 * → `null` → 401.
 */
protectedAuthRoutes.get(
  '/auth/me',
  requireRole('GET', '/auth/me', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    if (req.auth === undefined) throw new UnauthorizedError();
    const sessionUser = await getSessionUser(req.auth.userId);
    if (sessionUser === null) throw new UnauthorizedError();
    res.json(sessionUser);
  },
);

/**
 * Router combinado — `publicAuthRoutes` + `protectedAuthRoutes` na mesma
 * superfície. A montagem de produção (TASK-003-011) usa os dois sub-routers
 * separados pela barreira; este combinado serve os harnesses de teste que montam
 * auth atrás de um único `requireAuth`.
 */
export const authRoutes = Router();
authRoutes.use(publicAuthRoutes);
authRoutes.use(protectedAuthRoutes);
