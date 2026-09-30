import { isVersionAltered } from '../../src/modules/content-versions/version-alteration';
import type { VersionedContentFields } from '../../src/modules/content-versions/versioned-content-diff';

/**
 * Prova UNITÁRIA (TASK-035-002, COMP-035-008) do predicado puro extraído de
 * `resolveAlterationSignal` (F9) — sem I/O, sem dublê de `db`: os 5 cenários
 * cobrem as 2 combinações de CONTEÚDO × as 3 relações temporais de TIRA (antes/
 * depois/igual a `closedAt`) que o `>` estrito distingue.
 *
 * Mutantes-alvo:
 *  - remover o curto-circuito de `hasVersionedContentChanged` faz (a) falhar
 *    (passaria a depender de `latestTiraOccurredAt`, que é `null` em (a));
 *  - trocar `>` por `>=` faz (e) falhar (fronteira: mesmo instante → `false`);
 *  - trocar `>` por `<` faz (b)/(c) falharem.
 */
const BASE_FIELDS: VersionedContentFields = {
  rawText: 'texto',
  radarClass: 'ALTA',
  sourceType: null,
  sourceCitation: null,
  sourceUrl: null,
  concept: 'conceito',
  action: 'ação',
  object: 'objeto',
  condition: null,
  exception: null,
  essence: 'essência',
};

const CLOSED_AT = new Date('2026-01-01T00:00:00Z');

describe('isVersionAltered (TASK-035-002)', () => {
  it('(a) conteúdo alterado, Tira nunca reexportada (latestTiraOccurredAt: null) → true', () => {
    const current: VersionedContentFields = { ...BASE_FIELDS, rawText: 'texto mudou' };
    const version = { contentSnapshot: BASE_FIELDS, closedAt: CLOSED_AT };

    expect(isVersionAltered(current, version, null)).toBe(true);
  });

  it('(b) conteúdo intacto, latestTiraOccurredAt depois de closedAt → true', () => {
    const version = { contentSnapshot: BASE_FIELDS, closedAt: CLOSED_AT };
    const latestTiraOccurredAt = new Date('2026-01-02T00:00:00Z');

    expect(isVersionAltered(BASE_FIELDS, version, latestTiraOccurredAt)).toBe(true);
  });

  it('(c) conteúdo intacto, latestTiraOccurredAt antes de closedAt → false', () => {
    const version = { contentSnapshot: BASE_FIELDS, closedAt: CLOSED_AT };
    const latestTiraOccurredAt = new Date('2025-12-31T00:00:00Z');

    expect(isVersionAltered(BASE_FIELDS, version, latestTiraOccurredAt)).toBe(false);
  });

  it('(d) conteúdo intacto, latestTiraOccurredAt: null → false', () => {
    const version = { contentSnapshot: BASE_FIELDS, closedAt: CLOSED_AT };

    expect(isVersionAltered(BASE_FIELDS, version, null)).toBe(false);
  });

  it('(e) fronteira — latestTiraOccurredAt === closedAt (mesmo instante) → false', () => {
    const version = { contentSnapshot: BASE_FIELDS, closedAt: CLOSED_AT };
    const latestTiraOccurredAt = new Date(CLOSED_AT.getTime());

    expect(isVersionAltered(BASE_FIELDS, version, latestTiraOccurredAt)).toBe(false);
  });
});
