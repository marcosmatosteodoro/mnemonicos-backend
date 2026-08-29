import type { RequestHandler } from 'express';

import type { UserRole } from '../../domain/types';
import { recordAuthEvent } from '../../lib/audit';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { declareRouteRoles } from '../route-roles';

/**
 * Restringe uma rota autenticada a um conjunto de papéis **e** é a forma canônica
 * de declaração do deny-by-default: no registro do router grava `roles` em
 * `ROUTE_ROLES` sob o caminho da rota (`req.route.path`, que inclui os `:params`;
 * cai para `req.path` quando aplicado via `router.use`). É o que `requireAuth`
 * consulta para negar o caminho não declarado (DEC-003-005).
 *
 * Runtime: sem `req.auth` (não passou por `requireAuth`, ou rota pública mal
 * montada) → 401; papel da sessão fora de `roles` → auditoria `authz.denied` +
 * 403; senão segue. `return` após todo `next(err)` — §6.3.
 *
 * A identidade conferida é a de `req.auth` — a sessão resolvida no servidor —,
 * nunca um `:userId`/`?userId` da requisição (NFR-002-002).
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  if (roles.length === 0) {
    throw new Error('requireRole exige ao menos um papel');
  }

  const allowed = new Set(roles);

  return (req, _res, next) => {
    const declared: unknown = (req.route as { path?: unknown } | undefined)?.path;
    declareRouteRoles(typeof declared === 'string' ? declared : req.path, roles);

    if (req.auth === undefined) {
      next(new UnauthorizedError());
      return;
    }

    if (!allowed.has(req.auth.role)) {
      const userAgent = req.get('user-agent');
      recordAuthEvent({
        type: 'authz.denied',
        at: new Date(),
        outcome: 'failure',
        subject: req.auth.userId,
        ip: req.ip ?? '',
        ...(userAgent === undefined ? {} : { userAgent }),
      });
      next(new ForbiddenError());
      return;
    }

    next();
  };
}
