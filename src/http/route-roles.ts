import type { UserRole } from '../domain/types';

/**
 * Registro central caminho → papéis que podem alcançá-lo — a segunda metade do
 * deny-by-default (DEC-003-005, "leitura B"): um caminho ausente **deste
 * registro e** de `PUBLIC_PATH_ALLOWLIST` é negado por `requireAuth` com 403,
 * mesmo com sessão válida.
 *
 * A forma canônica de declaração é `requireRole(...)` (`middlewares/authorize.ts`),
 * aplicado a toda rota não-pública no registro do seu router; TASK-003-011 monta
 * a árvore e a suíte de conformidade enumera o resultado.
 *
 * É estado de módulo, como a pilha de rotas do próprio Express: reconstruído de
 * forma idêntica a cada boot a partir das mesmas definições de rota — não é cache
 * de request, então não recai na proibição do §4 do perfil.
 */
const registry = new Map<string, ReadonlySet<UserRole>>();

/** Visão de leitura do registro caminho → papéis. Escrita só por `declareRouteRoles`. */
export const ROUTE_ROLES: ReadonlyMap<string, ReadonlySet<UserRole>> = registry;

/**
 * Declara (idempotente) o conjunto de papéis que alcança `path`. Chamado por
 * `requireRole` no registro da rota. Uma segunda declaração com papéis
 * **diferentes** para o mesmo caminho é erro de montagem — lança, não
 * sobrescreve em silêncio (o registro é por caminho, não por método HTTP).
 */
export function declareRouteRoles(path: string, roles: readonly UserRole[]): void {
  const incoming = new Set(roles);
  const current = registry.get(path);

  if (current !== undefined && !sameRoles(current, incoming)) {
    throw new Error(
      `ROUTE_ROLES: declaração conflitante para "${path}" ` +
        `(${[...current].sort().join(',')} vs ${[...incoming].sort().join(',')})`,
    );
  }

  registry.set(path, incoming);
}

/**
 * Papéis declarados para `path`, ou `undefined` se o caminho não foi declarado.
 * Tenta a igualdade exata primeiro; senão casa `path` concreto (`/users/42`)
 * contra cada padrão registrado (`/users/:id`) segmento a segmento — um segmento
 * `:x` no padrão casa qualquer segmento concreto.
 */
export function rolesForPath(path: string): ReadonlySet<UserRole> | undefined {
  const exact = registry.get(path);
  if (exact !== undefined) return exact;

  const actual = path.split('/');
  for (const [pattern, roles] of registry) {
    if (matchesPattern(pattern.split('/'), actual)) return roles;
  }
  return undefined;
}

/**
 * Esvazia o registro. Usado ao (re)montar a árvore de rotas — a montagem de
 * TASK-003-011 e o isolamento entre casos de teste.
 */
export function resetRouteRoles(): void {
  registry.clear();
}

function matchesPattern(pattern: string[], actual: string[]): boolean {
  if (pattern.length !== actual.length) return false;
  return pattern.every((segment, i) => segment.startsWith(':') || segment === actual[i]);
}

function sameRoles(a: ReadonlySet<UserRole>, b: ReadonlySet<UserRole>): boolean {
  return a.size === b.size && [...a].every((role) => b.has(role));
}
