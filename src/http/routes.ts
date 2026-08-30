import { Router } from 'express';

import { protectedAuthRoutes, publicAuthRoutes } from '../modules/auth/auth.routes';
import { disciplinesRoutes } from '../modules/disciplines/disciplines.routes';
import { healthRoutes } from '../modules/health/health.routes';
import { usersRoutes } from '../modules/users/users.routes';
import { requireAuth } from './middlewares/authenticate';
import { isPublicPath } from './public-paths';
import { ROUTE_ROLES, sealRouteRoles, type HttpMethod } from './route-roles';

/**
 * Árvore de rotas da API, montada sob o prefixo versionado em `createApp()`.
 * A ORDEM AQUI É A BARREIRA (DEC-003-005 · perfil §6.3 — "ordem de middleware é
 * semântica em Express"):
 *
 *   1. rotas públicas — `healthRoutes` e as rotas de sessão (`POST /auth/login`,
 *      `POST /auth/refresh`) — montadas **antes** de `requireAuth`;
 *   2. `requireAuth` — piso de autorização: resolve a sessão no servidor e nega
 *      todo caminho fora de `PUBLIC_PATH_ALLOWLIST` que não declare papel em
 *      `ROUTE_ROLES` (403, mesmo com sessão válida — falha fechada);
 *   3. rotas protegidas — `protectedAuthRoutes`, `usersRoutes`,
 *      `disciplinesRoutes` — cada uma declara `"<MÉTODO> <caminho>"` em
 *      `ROUTE_ROLES` via `requireRole(...)` no ponto de montagem.
 *
 * Árvore **plana**: nenhum `apiRoutes.use('/prefixo', subRouter)`. O caminho que
 * `requireRole` declara tem de ser o mesmo `req.path` que `requireAuth` compara —
 * um mount com prefixo dessincronizaria os dois.
 *
 * `assertDenyByDefault` + `sealRouteRoles()` fecham a montagem: uma rota
 * não-pública sem declaração exata derruba o boot, e nenhuma declaração nova é
 * aceita depois dele.
 */
export const apiRoutes = Router();

// 1. Público — antes da barreira.
apiRoutes.use(healthRoutes);
apiRoutes.use(publicAuthRoutes);

// 2. A barreira.
apiRoutes.use(requireAuth);

// 3. Protegido — cada rota declara seus papéis; a barreira nega o resto.
apiRoutes.use(protectedAuthRoutes);
apiRoutes.use(usersRoutes);
apiRoutes.use(disciplinesRoutes);

/** Par `<MÉTODO> <caminho-completo>` de uma rota concreta da árvore plana. */
export interface MountedRoute {
  method: HttpMethod;
  path: string;
  /** Handlers da rota, na ordem da cadeia — para asserção estrutural (ex.: `verifyOrigin`). */
  handlers: unknown[];
}

/**
 * Enumera as rotas concretas de `router`, descendo nos sub-routers montados sem
 * prefixo (Express 5 removeu `app._router`; a pilha é `router.stack`). Enumerador
 * único: o passo de boot abaixo e a suíte de conformidade `route-authz-matrix`
 * consomem este mesmo caminho.
 */
export function collectRoutes(router: unknown): MountedRoute[] {
  const out: MountedRoute[] = [];
  visit(router, out);
  return out;
}

function visit(node: unknown, out: MountedRoute[]): void {
  const stack = (node as { stack?: unknown[] }).stack;
  if (!Array.isArray(stack)) return;

  for (const layer of stack as Array<Record<string, unknown>>) {
    const route = layer.route as
      | { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }
      | undefined;

    if (route !== undefined) {
      for (const [method, enabled] of Object.entries(route.methods)) {
        if (!enabled) continue;
        out.push({
          method: method.toUpperCase() as HttpMethod,
          path: route.path,
          handlers: route.stack.map((entry) => entry.handle),
        });
      }
      continue;
    }

    // Sub-router montado sem prefixo → a pilha dele já carrega os caminhos completos.
    const handle = layer.handle;
    if (handle !== undefined && Array.isArray((handle as { stack?: unknown[] }).stack)) {
      visit(handle, out);
    }
  }
}

/**
 * Recusa o boot se alguma rota não-pública montada não tiver declaração
 * **exata** `"<MÉTODO> <caminho-completo>"` em `ROUTE_ROLES` (DEC-003-005 EMENDA
 * — fecha o resíduo em que `rolesForPath` casaria uma irmã estática contra o
 * `:param` do vizinho do mesmo método). "Rota nova nasce protegida" passa a ser
 * verificável no boot, não só na suíte de conformidade.
 */
export function assertDenyByDefault(router: unknown): void {
  const undeclared = collectRoutes(router)
    .filter((route) => !isPublicPath(route.path))
    .filter((route) => !ROUTE_ROLES.has(`${route.method} ${route.path}`))
    .map((route) => `${route.method} ${route.path}`);

  if (undeclared.length > 0) {
    throw new Error(
      `Montagem deny-by-default: rota(s) não-pública(s) sem declaração exata em ROUTE_ROLES: ${undeclared.join(', ')}`,
    );
  }
}

assertDenyByDefault(apiRoutes);
sealRouteRoles();
