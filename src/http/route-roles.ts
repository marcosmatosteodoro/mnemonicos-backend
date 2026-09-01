import type { UserRole } from '../domain/types';

/**
 * Registro central `"<MÉTODO> <caminho>" → papéis` — a segunda metade do
 * deny-by-default (DEC-003-005, "leitura B"): um par método+caminho ausente
 * **deste registro e** de `PUBLIC_PATH_ALLOWLIST` é negado por `requireAuth` com
 * 403, mesmo com sessão válida.
 *
 * A chave inclui o método HTTP: `DELETE /users/:id` e `GET /users/:id` são
 * declarações independentes, com conjuntos de papéis próprios. Casar só pelo
 * caminho deixaria `DELETE` herdar o papel do `GET` do mesmo recurso.
 *
 * O caminho declarado é **sempre o caminho completo visto por `requireAuth`** a
 * partir da raiz de `apiRoutes` (o mesmo `req.path` que o middleware compara) —
 * a suíte de conformidade de TASK-003-011 enumera `router.stack` e falha o boot
 * se alguma rota montada não tiver declaração exata `método+caminho-completo`.
 *
 * A forma canônica de declaração é `requireRole(method, path, ...roles)`
 * (`middlewares/authorize.ts`), avaliada **no ponto de montagem** — antes de
 * qualquer requisição. `sealRouteRoles()` fecha o registro após o boot
 * (TASK-003-011); `declareRouteRoles` posterior lança.
 *
 * É estado de módulo, como a pilha de rotas do próprio Express: reconstruído de
 * forma idêntica a cada boot a partir das mesmas definições de rota — não é
 * cache de request (nenhuma chave é derivada de dado de requisição), então não
 * recai na proibição do §4 do perfil.
 */

/** Métodos HTTP que uma rota declara — a parte antes do espaço na chave do registro. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const registry = new Map<string, ReadonlySet<UserRole>>();
let sealed = false;

/** Visão de leitura do registro. Escrita só por `declareRouteRoles`. */
export const ROUTE_ROLES: ReadonlyMap<string, ReadonlySet<UserRole>> = registry;

function keyOf(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Declara (idempotente para os mesmos papéis) o conjunto que alcança
 * `método+caminho`. Chamado por `requireRole` na avaliação da chamada (montagem).
 *
 * - Redeclarar o mesmo par com papéis **diferentes** é erro de montagem → lança.
 * - Declarar após `sealRouteRoles()` → lança (o registro é imutável pós-boot).
 * - Sem nenhum papel → lança (uma rota não nasce sem papel declarado).
 */
export function declareRouteRoles(
  method: HttpMethod,
  path: string,
  roles: readonly UserRole[],
): void {
  if (sealed) {
    throw new Error(
      `ROUTE_ROLES: registro selado — "${keyOf(method, path)}" não pode ser declarado após sealRouteRoles()`,
    );
  }
  if (roles.length === 0) {
    throw new Error(`ROUTE_ROLES: "${keyOf(method, path)}" declarado sem nenhum papel`);
  }

  const incoming: ReadonlySet<UserRole> = new Set(roles);
  const key = keyOf(method, path);
  const current = registry.get(key);

  if (current !== undefined && !sameRoles(current, incoming)) {
    throw new Error(
      `ROUTE_ROLES: declaração conflitante para "${key}" ` +
        `(${[...current].sort().join(',')} vs ${[...incoming].sort().join(',')})`,
    );
  }

  registry.set(key, incoming);
}

/**
 * Papéis declarados para `método+caminho`, ou `undefined` se o par não foi
 * declarado. Igualdade exata na chave primeiro; senão casa `path` concreto
 * (`/users/42`) contra os padrões registrados (`/users/:id`) segmento a segmento
 * — um segmento `:x` casa qualquer segmento concreto — **apenas entre chaves do
 * mesmo método**. `DELETE /users/42` nunca cai num padrão registrado sob `GET`.
 */
export function rolesForPath(method: string, path: string): ReadonlySet<UserRole> | undefined {
  const exact = registry.get(keyOf(method, path));
  if (exact !== undefined) return exact;

  const prefix = `${method} `;
  const actual = path.split('/');
  for (const [key, roles] of registry) {
    if (!key.startsWith(prefix)) continue;
    const pattern = key.slice(prefix.length).split('/');
    if (matchesPattern(pattern, actual)) return roles;
  }
  return undefined;
}

/**
 * Sela o registro: nenhuma declaração nova é aceita depois disto. TASK-003-011
 * chama uma vez após montar a árvore de rotas, para que uma rota adicionada em
 * runtime não possa se autorizar.
 */
export function sealRouteRoles(): void {
  sealed = true;
}

/**
 * Esvazia o registro **e o dessela**. Usado ao (re)montar a árvore de rotas e
 * para isolar casos de teste — sem o dessela, um teste que selou envenenaria os
 * seguintes.
 */
export function resetRouteRoles(): void {
  registry.clear();
  sealed = false;
}

function matchesPattern(pattern: string[], actual: string[]): boolean {
  if (pattern.length !== actual.length) return false;
  return pattern.every((segment, i) => segment.startsWith(':') || segment === actual[i]);
}

function sameRoles(a: ReadonlySet<UserRole>, b: ReadonlySet<UserRole>): boolean {
  return a.size === b.size && [...a].every((role) => b.has(role));
}
