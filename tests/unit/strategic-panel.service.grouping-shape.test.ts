import type {
  PanelContentRow,
  PanelPublicationEventRow,
  PanelStageEventRow,
  StrategicPanelClient,
} from '../../src/modules/strategic-panel/strategic-panel.service';
import { buildStrategicPanel } from '../../src/modules/strategic-panel/strategic-panel.service';

/**
 * Prova COMPORTAMENTAL, agnóstica de forma — nunca lê nem interpreta o código-fonte.
 * Conta as leituras da propriedade `rawContentId` feitas por `buildStrategicPanel` ao
 * agrupar eventos de etapa e Publicações Tira: com o mesmo total de linhas (E) e o
 * mesmo número de Conteúdos distintos que recebem linha (D), a contagem de leituras é
 * a mesma para N=2 e N=10 Conteúdos ativos — uma redistribuição por Conteúdo dentro do
 * laço (ex.: `.filter`/`.flatMap` sobre a coleção inteira, uma vez por Conteúdo) faria a
 * contagem crescer com N para o mesmo E; um agrupamento em `Map` (uma única passada,
 * O(N+E)) não.
 */

/** Getter contado: cada leitura de `rawContentId` incrementa `counter.reads`. */
function attachCountedRawContentId<T>(
  base: Omit<T, 'rawContentId'>,
  rawContentId: string,
  counter: { reads: number },
): T {
  return Object.defineProperty({ ...base }, 'rawContentId', {
    enumerable: true,
    get(): string {
      counter.reads += 1;
      return rawContentId;
    },
  }) as T;
}

function buildContentRow(id: string): PanelContentRow {
  return {
    id,
    radarClass: 'ALTA',
    topic: { name: 'Tema', discipline: { name: 'Disciplina' } },
  };
}

function buildStageEventRow(
  rawContentId: string,
  sequence: bigint,
  counter: { reads: number },
): PanelStageEventRow {
  return attachCountedRawContentId<PanelStageEventRow>(
    {
      stageType: 'CONTEUDO_BRUTO',
      transitionType: 'ABERTURA',
      sequence,
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    },
    rawContentId,
    counter,
  );
}

function buildPublicationEventRow(
  rawContentId: string,
  counter: { reads: number },
): PanelPublicationEventRow {
  return attachCountedRawContentId<PanelPublicationEventRow>(
    {
      occurredAt: new Date('2026-01-02T00:00:00Z'),
      pageCount: 10,
    },
    rawContentId,
    counter,
  );
}

/**
 * `db` dublê estrutural: `contentVersion`/`ruleBreakdown` sempre vazios — nenhuma Versão vigente aprovada, então
 * `buildStrategicPanel` nunca soma as 2 leituras extra de aprovadas. `strategic-panel-calculations.ts`
 * não declara `rawContentId` nos tipos de entrada do cálculo puro (`ContentMetricsStageEvent`/
 * `ContentMetricsTiraPublication`) — só o agrupamento em lote lê essa propriedade.
 */
function buildStubDb(
  contents: PanelContentRow[],
  stageEvents: PanelStageEventRow[],
  tiraPublications: PanelPublicationEventRow[],
): StrategicPanelClient {
  return {
    rawContent: { findMany: () => Promise.resolve(contents) },
    productionStageEvent: { findMany: () => Promise.resolve(stageEvents) },
    publicationEvent: { findMany: () => Promise.resolve(tiraPublications) },
    contentVersion: { findMany: () => Promise.resolve([]) },
    ruleBreakdown: { findMany: () => Promise.resolve([]) },
  } as unknown as StrategicPanelClient;
}

/**
 * E=10 linhas fixas (6 eventos de etapa + 4 Publicações), sempre atribuídas às 2
 * primeiras Contents ids (`content-0`/`content-1`) — D=2 grupos distintos em CADA
 * coleção, independente de N: os demais Conteúdos (quando N=10) não recebem nenhuma
 * linha. Um agrupamento em `Map` de uma passada lê `rawContentId` no máximo 2 vezes por
 * linha (1 para `.get`, +1 só no 1º elemento de cada grupo distinto, para `.set`) —
 * nunca por Conteúdo inteiro: o total não escala com N e fica dentro do teto 2·E.
 */
async function countRawContentIdReads(contentCount: number): Promise<number> {
  const counter = { reads: 0 };
  const contents = Array.from({ length: contentCount }, (_, i) => buildContentRow(`content-${i}`));

  const stageEvents = [
    buildStageEventRow('content-0', 1n, counter),
    buildStageEventRow('content-0', 2n, counter),
    buildStageEventRow('content-0', 3n, counter),
    buildStageEventRow('content-1', 4n, counter),
    buildStageEventRow('content-1', 5n, counter),
    buildStageEventRow('content-1', 6n, counter),
  ];
  const tiraPublications = [
    buildPublicationEventRow('content-0', counter),
    buildPublicationEventRow('content-0', counter),
    buildPublicationEventRow('content-1', counter),
    buildPublicationEventRow('content-1', counter),
  ];

  const db = buildStubDb(contents, stageEvents, tiraPublications);
  await buildStrategicPanel(new Date('2026-01-03T00:00:00Z'), db);

  return counter.reads;
}

const TOTAL_ROW_COUNT = 10; // E: 6 eventos de etapa + 4 Publicações Tira, ver countRawContentIdReads acima

describe('buildStrategicPanel — leituras de rawContentId ao agrupar são O(E), independentes de N (comportamental)', () => {
  it('N=2 e N=10 Conteúdos ativos, mesmo E/D acima → MESMO número de leituras de rawContentId (não escala com N)', async () => {
    // Falsificável: `.filter`/`.flatMap` por Conteúdo dentro de `contents.map` releria as
    // linhas de cada coleção para CADA Conteúdo — a contagem em N=10 divergiria da em N=2.
    // Um agrupamento em `Map` de uma passada não.
    const readsAtN2 = await countRawContentIdReads(2);
    const readsAtN10 = await countRawContentIdReads(10);

    expect(readsAtN10).toBe(readsAtN2);
  });

  it('leituras de rawContentId ficam dentro do teto linear 2·E (no máximo 2 por linha, nunca 1 leitura extra por Conteúdo inteiro)', async () => {
    const reads = await countRawContentIdReads(2);

    expect(reads).toBeLessThanOrEqual(2 * TOTAL_ROW_COUNT);
  });
});
