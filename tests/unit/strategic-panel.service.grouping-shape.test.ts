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
 * `db` dublê estrutural (molde `content-versions.service.resolve-alteration-signal.test.ts`):
 * `contentVersion`/`ruleBreakdown` sempre vazios — nenhuma Versão vigente aprovada, então
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
 * linha. Um agrupamento em `Map` de uma passada lê `rawContentId` 1 vez por linha (E) e
 * mais 1 vez por 1º elemento de cada grupo distinto (D por coleção): E + D_stage +
 * D_tira = 10 + 2 + 2 = 14 leituras — constante, não escala com N.
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

const EXPECTED_READS = 14; // E(10) + D_stage(2) + D_tira(2), ver countRawContentIdReads acima

describe('buildStrategicPanel — leituras de rawContentId ao agrupar são O(E), independentes de N (comportamental)', () => {
  it('N=2 Conteúdos ativos, mesmo E/D acima → 14 leituras de rawContentId', async () => {
    const reads = await countRawContentIdReads(2);
    expect(reads).toBe(EXPECTED_READS);
  });

  it('N=10 Conteúdos ativos, mesmo E/D acima → MESMAS 14 leituras (não cresce com N)', async () => {
    // Falsificável: `.filter`/`.flatMap` por Conteúdo dentro de `contents.map` releria as
    // 10 linhas para CADA um dos 10 Conteúdos (até 100 leituras) — a contagem divergiria
    // da rodada com N=2 acima. Um agrupamento em `Map` de uma passada não.
    const reads = await countRawContentIdReads(10);
    expect(reads).toBe(EXPECTED_READS);
  });
});
