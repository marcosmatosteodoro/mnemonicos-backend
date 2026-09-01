import type { RequestHandler } from 'express';

import type { UserRole } from '../../domain/types';
import { recordAuthEvent } from '../../lib/audit';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { declareRouteRoles, type HttpMethod } from '../route-roles';

/**
 * Restringe uma rota autenticada a um conjunto de papéis **e** é a forma canônica
 * de declaração do deny-by-default.
 *
 * `method` e `path` são literais no ponto de montagem — `requireRole('GET',
 * '/gestao', 'ADMIN')`. A declaração em `ROUTE_ROLES` acontece **na avaliação da
 * chamada** (antes de qualquer requisição), não dentro do guard: `requireAuth`
 * roda antes deste middleware na cadeia, então uma declaração feita em tempo de
 * request chegaria tarde e o deny-by-default degeneraria em deny-tudo.
 *
 * O `path` declarado é o caminho completo visto por `requireAuth` (o mesmo
 * `req.path`), não `req.route.path` — este último é relativo ao router e não
 * bate com o que o middleware de autenticação compara.
 *
 * Runtime (guard de defesa em profundidade — `requireAuth` já barra pelo
 * registro): sem `req.auth` → 401; papel da sessão fora de `roles` → auditoria
 * `authz.denied` + 403; senão segue. `return` após todo `next(err)` — §6.3.
 * Nenhuma escrita no registro dentro do handler; nenhuma chave derivada de
 * dado de requisição.
 *
 * A identidade conferida é a de `req.auth` — a sessão resolvida no servidor —,
 * nunca um `:userId`/`?userId` da requisição (NFR-002-002).
 */
export function requireRole(
  method: HttpMethod,
  path: string,
  ...roles: UserRole[]
): RequestHandler {
  if (roles.length === 0) {
    throw new Error('requireRole exige ao menos um papel');
  }

  declareRouteRoles(method, path, roles);
  const allowed = new Set(roles);

  return (req, _res, next) => {
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
