import type { VersionedContentFields } from './versioned-content-diff';
import { hasVersionedContentChanged } from './versioned-content-diff';

/**
 * Predicado único de "alterado pós-fechamento" (COMP-035-008, DEC-035-015) — combina
 * CONTEÚDO (`hasVersionedContentChanged`, curto-circuito) com TIRA (comparação de
 * `sequence`, resolvida pelo CHAMADOR — esta função só recebe o instante já escolhido,
 * nunca decide a query). 4 consumidores: `approveContentVersion`, `listContentVersions`,
 * `resolveVersionStampForPdf` (via `resolveAlterationSignal`, F9) e o Painel estratégico
 * (TASK-035-004, chamada direta em memória sobre N Conteúdos). Mudar a regra aqui muda os
 * 4 juntos — nunca uma cópia local.
 */
export function isVersionAltered(
  current: VersionedContentFields,
  version: { contentSnapshot: unknown; closedAt: Date },
  latestTiraOccurredAt: Date | null,
): boolean {
  if (hasVersionedContentChanged(current, version.contentSnapshot as VersionedContentFields)) {
    return true;
  }
  return latestTiraOccurredAt !== null && latestTiraOccurredAt > version.closedAt;
}
