import type { RequestHandler } from 'express';

import { recordAuthEvent } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { resolveAccessSession } from '../../modules/auth/auth.service';
import { ACCESS_COOKIE } from '../cookies';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { isPublicPath } from '../public-paths';
import { rolesForPath } from '../route-roles';

/**
 * Barreira de autenticação, deny-by-default (DEC-003-005 · §6.3 do perfil).
 * Montada em `apiRoutes` **antes** de qualquer router protegido (TASK-003-011).
 *
 * 1. Par `req.method`+`req.path` em `PUBLIC_PATH_ALLOWLIST` → segue sem tocar sessão.
 * 2. Senão resolve a sessão pelo cookie `ACCESS_COOKIE`, no servidor, a cada
 *    requisição — `now` é `new Date()` do servidor, nunca de header/query. Não
 *    resolveu (ou o cookie falta / não é string) → 401, e nada da rota roda.
 * 3. Sessão válida, mas o par `req.method`+`req.path` **não declara papel** em
 *    `ROUTE_ROLES` (nem é público) **ou** o papel da sessão **não está no
 *    conjunto declarado** → auditoria `authz.denied` + 403, falha fechada
 *    (AC-002-014 · DEC-003-005), mesmo com sessão boa. Este é o **piso de
 *    autorização**: nega o não-declarado **e** o papel errado sem depender de
 *    `requireRole` estar montado na rota.
 * 4. Caso contrário anexa `req.auth` e segue; o guard de `requireRole` do router
 *    é defesa em profundidade sobre a mesma decisão.
 *
 * Precedência: sem sessão (401) é avaliado **antes** da consulta a `ROUTE_ROLES`
 * (403) — uma requisição anônima a um caminho não declarado recebe 401, não 403.
 *
 * Toda recusa é `next(err)` seguido de `return`: sem o `return` o corpo abaixo
 * continua executando com a requisição já negada (§6.3).
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  if (isPublicPath(req.method, req.path)) {
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

  const roles = rolesForPath(req.method, req.path);
  if (roles === undefined || !roles.has(auth.role)) {
    const userAgent = req.get('user-agent');
    recordAuthEvent({
      type: 'authz.denied',
      at: new Date(),
      outcome: 'failure',
      subject: auth.userId,
      ip: req.ip ?? '',
      ...(userAgent === undefined ? {} : { userAgent }),
    });
    next(new ForbiddenError());
    return;
  }

  req.auth = auth;
  next();
};
