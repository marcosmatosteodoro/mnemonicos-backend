import type { RequestHandler } from 'express';

import { resolveAccessSession } from '../../modules/auth/auth.service';
import { logger } from '../../lib/logger';
import { ACCESS_COOKIE } from '../cookies';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { isPublicPath } from '../public-paths';
import { rolesForPath } from '../route-roles';

/**
 * Barreira de autenticação, deny-by-default (DEC-003-005 · §6.3 do perfil).
 * Montada em `apiRoutes` **antes** de qualquer router protegido (TASK-003-011).
 *
 * 1. Caminho em `PUBLIC_PATH_ALLOWLIST` → segue sem tocar sessão.
 * 2. Senão resolve a sessão pelo cookie `ACCESS_COOKIE`, no servidor, a cada
 *    requisição — `now` é `new Date()` do servidor, nunca de header/query. Não
 *    resolveu (ou o cookie falta / não é string) → 401, e nada da rota a seguir
 *    roda.
 * 3. Sessão válida mas o caminho não declara papel em `ROUTE_ROLES` (nem é
 *    público) → 403, falha fechada (AC-002-014), mesmo com sessão boa.
 * 4. Caso contrário anexa `req.auth` e segue; `requireRole` do router decide o
 *    papel.
 *
 * Toda recusa é `next(err)` seguido de `return`: sem o `return` o corpo abaixo
 * continua executando com a requisição já negada (§6.3).
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  if (isPublicPath(req.path)) {
    next();
    return;
  }

  const cookieJar: unknown = req.cookies;
  const rawToken =
    typeof cookieJar === 'object' && cookieJar !== null
      ? (cookieJar as Record<string, unknown>)[ACCESS_COOKIE]
      : undefined;
  const accessToken = typeof rawToken === 'string' ? rawToken : '';

  let auth: Awaited<ReturnType<typeof resolveAccessSession>>;
  try {
    auth = await resolveAccessSession(accessToken, new Date());
  } catch (cause) {
    // Fail secure (§6.3): resolver a sessão nunca pode abrir por erro.
    // `resolveAccessSession` é documentada como não-lançante; se lançar mesmo
    // assim (ex.: banco fora), nega — e loga a causa, que o 401 não carrega.
    logger.error({ err: cause, path: req.path }, 'falha ao resolver a sessão — negando');
    auth = null;
  }

  if (auth === null) {
    next(new UnauthorizedError());
    return;
  }

  if (rolesForPath(req.path) === undefined) {
    next(new ForbiddenError());
    return;
  }

  req.auth = auth;
  next();
};
