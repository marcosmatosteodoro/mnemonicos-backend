import { Router } from 'express';

import { protectedAuthRoutes, publicAuthRoutes } from '../modules/auth/auth.routes';
import { contentsRoutes } from '../modules/contents/contents.routes';
import { disciplinesRoutes } from '../modules/disciplines/disciplines.routes';
import { healthRoutes } from '../modules/health/health.routes';
import { tiraRoutes } from '../modules/tira/tira.routes';
import { usersRoutes } from '../modules/users/users.routes';
import { requireAuth } from './middlewares/authenticate';
import { isPublicPath, PUBLIC_PATH_ALLOWLIST } from './public-paths';
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
 *      `disciplinesRoutes`, `contentsRoutes`, `tiraRoutes` — cada uma declara
 *      `"<MÉTODO> <caminho>"` em `ROUTE_ROLES` via `requireRole(...)` no ponto
 *      de montagem.
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
apiRoutes.use(contentsRoutes);
apiRoutes.use(tiraRoutes);

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
    visitLayer(layer, out);
  }
}

/** Rotas concretas de uma única camada do `stack` — rota direta ou sub-router sem prefixo. */
function visitLayer(layer: Record<string, unknown>, out: MountedRoute[]): void {
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
    return;
  }

  // Sub-router montado sem prefixo → a pilha dele já carrega os caminhos completos.
  const handle = layer.handle;
  if (handle !== undefined && Array.isArray((handle as { stack?: unknown[] }).stack)) {
    visit(handle, out);
  }
}

/**
 * Pares `"<MÉTODO> <caminho>"` das rotas montadas **antes** da camada `requireAuth`
 * no `stack` de `router` — as que, de fato, dispensam a barreira. `barrierFound`
 * distingue "nada antes da barreira" de "barreira ausente".
 */
function routesBeforeBarrier(router: unknown): { pairs: Set<string>; barrierFound: boolean } {
  const stack = (router as { stack?: unknown[] }).stack;
  const pairs = new Set<string>();
  let barrierFound = false;

  if (Array.isArray(stack)) {
    for (const layer of stack as Array<Record<string, unknown>>) {
      if ((layer as { handle?: unknown }).handle === requireAuth) {
        barrierFound = true;
        break;
      }
      const bucket: MountedRoute[] = [];
      visitLayer(layer, bucket);
      for (const route of bucket) pairs.add(`${route.method} ${route.path}`);
    }
  }

  return { pairs, barrierFound };
}

/**
 * Recusa o boot se a árvore montada viola o deny-by-default (DEC-003-005 +
 * EMENDA da Wave 6). Três condições, cada uma fail-closed:
 *
 *   1. rota não-pública sem declaração **exata** `"<MÉTODO> <caminho>"` em
 *      `ROUTE_ROLES` — fecha o resíduo em que `rolesForPath` casaria uma irmã
 *      estática contra o `:param` do vizinho do mesmo método;
 *   2. rota montada **antes** de `requireAuth` cujo par **não** está em
 *      `PUBLIC_PATH_ALLOWLIST` — ela escaparia da barreira sem ser uma exceção
 *      declarada (a allowlist é método-aware desde a EMENDA da Wave 6:
 *      `GET /auth/login` montada antes da barreira não é `POST /auth/login`);
 *   3. par de `PUBLIC_PATH_ALLOWLIST` que corresponde a uma rota montada mas está
 *      **depois** de `requireAuth` — a exceção declarada tem de estar onde a
 *      ordem de montagem a torna efetiva.
 *
 * "Rota nova nasce protegida" passa a ser verificável no boot, não só na suíte
 * de conformidade.
 */
export function assertDenyByDefault(router: unknown): void {
  const mounted = collectRoutes(router);

  const undeclared = mounted
    .filter((route) => !isPublicPath(route.method, route.path))
    .filter((route) => !ROUTE_ROLES.has(`${route.method} ${route.path}`))
    .map((route) => `${route.method} ${route.path}`);

  if (undeclared.length > 0) {
    throw new Error(
      `Montagem deny-by-default: rota(s) não-pública(s) sem declaração exata em ROUTE_ROLES: ${undeclared.join(', ')}`,
    );
  }

  const allowlist = PUBLIC_PATH_ALLOWLIST as readonly string[];
  const { pairs: beforeBarrier } = routesBeforeBarrier(router);

  const escapesBarrier = [...beforeBarrier].filter((pair) => !allowlist.includes(pair));
  if (escapesBarrier.length > 0) {
    throw new Error(
      `Montagem deny-by-default: rota(s) montada(s) antes de requireAuth fora de PUBLIC_PATH_ALLOWLIST: ${escapesBarrier.join(', ')}`,
    );
  }

  const mountedPairs = new Set(mounted.map((route) => `${route.method} ${route.path}`));
  const publicBehindBarrier = allowlist.filter(
    (pair) => mountedPairs.has(pair) && !beforeBarrier.has(pair),
  );
  if (publicBehindBarrier.length > 0) {
    throw new Error(
      `Montagem deny-by-default: par(es) de PUBLIC_PATH_ALLOWLIST montado(s) depois de requireAuth: ${publicBehindBarrier.join(', ')}`,
    );
  }
}

assertDenyByDefault(apiRoutes);
sealRouteRoles();
