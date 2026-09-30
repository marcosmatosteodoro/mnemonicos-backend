import { isVersionAltered } from '../content-versions/version-alteration';
import type { VersionedContentFields } from '../content-versions/versioned-content-diff';
import {
  derivePresentationPriority,
  type PresentationPriority,
} from '../../domain/presentation-priority';
import type {
  ProductionEventTransition,
  ProductionStageType,
  ProofRadarClass,
} from '../../domain/types';

/**
 * Núcleo de cálculo do Painel estratégico (COMP-035-010/011, FEAT-034-002) — 2 funções
 * puras, sem I/O: `computeContentMetrics` (por Conteúdo) e `aggregateStrategicPanel`
 * (Módulo/fábrica/backlog). A leitura em lote (TASK-035-005) monta o `ContentMetricsInput`
 * a partir do banco; a orquestração (TASK-035-006) chama as duas em sequência.
 */

export interface ContentMetricsStageEvent {
  stageType: ProductionStageType;
  transitionType: ProductionEventTransition;
  sequence: bigint;
  occurredAt: Date;
}

export interface ContentMetricsTiraPublication {
  occurredAt: Date;
  pageCount: number | null;
}

export interface ContentLatestVersion {
  closedAt: Date;
  approvedById: string | null;
  contentSnapshot: unknown;
}

export interface ContentMetricsInput {
  content: {
    id: string;
    radarClass: ProofRadarClass;
    disciplineName: string;
    topicName: string;
  };
  /** Todos os eventos de etapa do Conteúdo (as 8 etapas) — ordem não é premissa: esta
   * função ordena por `sequence` internamente antes de calcular. */
  stageEvents: ContentMetricsStageEvent[];
  /** Só Variante TIRA — o chamador (TASK-035-005) já filtrou por Variante. */
  tiraPublications: ContentMetricsTiraPublication[];
  latestVersion: ContentLatestVersion | null;
  /** Só presente quando `latestVersion.approvedById !== null` (TASK-035-005, 2º `IN`). */
  currentVersionedFields?: VersionedContentFields;
}

export type StagePeriod =
  | { status: 'medido'; ms: number; msPerPage: number | null }
  | { status: 'em-aberto' | 'nao-percorrida' | 'sem-duracao-medida' };

/** As 5 etapas de conteúdo cujo retrabalho pós-fechamento conta como "correção após
 * revisão" (A-034-002) — exclui Publicação, Versão editorial e Aprovação. */
const CONTENT_STAGE_TYPES = [
  'CONTEUDO_BRUTO',
  'QUEBRA_DA_REGRA',
  'TIRA_MNEMONICA',
  'ASSOCIACAO_VISUAL',
  'MATERIAL_REFORCO',
] as const;

export type ContentStageType = (typeof CONTENT_STAGE_TYPES)[number];

function isContentStageType(stageType: ProductionStageType): stageType is ContentStageType {
  return CONTENT_STAGE_TYPES.some((candidate) => candidate === stageType);
}

/** Ordem fixa do fluxo canônico para "etapa mais avançada" — Publicação fica fora
 * (DEC-035-008, A-034-008): a Exportação de rascunho pode ocorrer em qualquer ponto
 * após a Quebra da regra, então não marca avanço de produção. */
const MOST_ADVANCED_STAGE_ORDER: readonly ProductionStageType[] = [
  'CONTEUDO_BRUTO',
  'QUEBRA_DA_REGRA',
  'TIRA_MNEMONICA',
  'ASSOCIACAO_VISUAL',
  'MATERIAL_REFORCO',
  'VERSAO_EDITORIAL',
  'APROVACAO_VERSAO',
];

export interface ContentMetrics {
  contentId: string;
  disciplineName: string;
  topicName: string;
  /** Nunca `null`/`0`: ausência de medida é sempre `{ reason }`, nunca um valor numérico.
   * `reason` distingue os 2 motivos do FR-034-026/007. */
  totalTime: { ms: number; pageCount: number } | { reason: 'sem-medida' | 'sem-registro' };
  timePerPage: number | null;
  perStage: Record<ProductionStageType, StagePeriod>;
  reworkCountByStage: Partial<Record<ContentStageType, number>>;
  concluded: boolean;
  approvedButAltered: boolean;
  mostAdvancedStage: ProductionStageType | 'sem-registro';
  priority: PresentationPriority;
  ageMs: number | null;
}

/** Resultado de comparador para "sem diferença de ordem" — nomeado, nunca um zero cru
 * de retorno, para não se confundir com um valor de tempo/idade individual. */
const NO_ORDER_DIFFERENCE = 0;

function compareBySequence<T extends { sequence: bigint }>(a: T, b: T): number {
  if (a.sequence < b.sequence) return -1;
  if (a.sequence > b.sequence) return 1;
  return NO_ORDER_DIFFERENCE;
}

function findFirstBySequence<T extends { sequence: bigint }>(events: T[]): T | null {
  return events.reduce<T | null>((earliest, event) => {
    if (earliest === null || event.sequence < earliest.sequence) return event;
    return earliest;
  }, null);
}

function findLatestBySequence<T extends { sequence: bigint }>(events: T[]): T | null {
  return events.reduce<T | null>((latest, event) => {
    if (latest === null || event.sequence > latest.sequence) return event;
    return latest;
  }, null);
}

function groupStageEventsByType(
  sortedEvents: ContentMetricsStageEvent[],
): Map<ProductionStageType, ContentMetricsStageEvent[]> {
  const grouped = new Map<ProductionStageType, ContentMetricsStageEvent[]>();
  for (const event of sortedEvents) {
    const bucket = grouped.get(event.stageType);
    if (bucket === undefined) {
      grouped.set(event.stageType, [event]);
    } else {
      bucket.push(event);
    }
  }
  return grouped;
}

/**
 * Exportação de referência (Fluxo 3, FR-034-003/020): entre os `PUBLICACAO_PDF` com
 * `sequence` maior que a do 1º fechamento, a de MENOR `sequence` cuja correlação
 * `(rawContentId, occurredAt)` — já reduzida a `occurredAt` porque `tiraPublications` é
 * de um único Conteúdo — casa com uma Exportação Tira. Sem 1º fechamento (nenhum
 * `VERSAO_EDITORIAL`), não há "depois do fechamento" a comparar: nenhuma Exportação
 * qualifica.
 */
function findReferenceTiraExport(
  sortedStageEvents: ContentMetricsStageEvent[],
  tiraPublications: ContentMetricsTiraPublication[],
  closureSequence: bigint | null,
): ContentMetricsTiraPublication | null {
  if (closureSequence === null) {
    return null;
  }
  const candidates = sortedStageEvents.filter(
    (event) => event.stageType === 'PUBLICACAO_PDF' && event.sequence > closureSequence,
  );
  for (const candidate of candidates) {
    const match = tiraPublications.find(
      (publication) => publication.occurredAt.getTime() === candidate.occurredAt.getTime(),
    );
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}

interface ContentTimeResult {
  totalTime: ContentMetrics['totalTime'];
  timePerPage: number | null;
  /** Páginas da Exportação de referência, para dividir o tempo de cada etapa
   * (FR-034-025) — `null` quando não há tempo por página medido. */
  referenceExportPageCount: number | null;
}

function resolveContentTime(
  startEvent: ContentMetricsStageEvent | null,
  referenceExport: ContentMetricsTiraPublication | null,
): ContentTimeResult {
  if (startEvent === null) {
    return {
      totalTime: { reason: 'sem-registro' },
      timePerPage: null,
      referenceExportPageCount: null,
    };
  }
  if (referenceExport === null || referenceExport.pageCount === null) {
    return {
      totalTime: { reason: 'sem-medida' },
      timePerPage: null,
      referenceExportPageCount: null,
    };
  }
  const ms = referenceExport.occurredAt.getTime() - startEvent.occurredAt.getTime();
  const timePerPage = ms / referenceExport.pageCount;
  return {
    totalTime: { ms, pageCount: referenceExport.pageCount },
    timePerPage,
    referenceExportPageCount: referenceExport.pageCount,
  };
}

/**
 * Tempo por etapa (FR-034-006/022/023/024): "não percorrida" sem evento; "sem duração
 * medida" quando o 1º evento cronológico não é `ABERTURA` (ex.: Tira auto-gerada na
 * Exportação, sem abertura correspondente); "em aberto" com abertura e sem nenhuma
 * `CONCLUSAO`; senão "medido", do 1º ao ÚLTIMO evento (retrabalho incluso, mesmo um
 * `RETRABALHO` posterior a uma `CONCLUSAO` que reabre a etapa).
 */
function resolveStagePeriod(
  events: ContentMetricsStageEvent[],
  referenceExportPageCount: number | null,
): StagePeriod {
  const first = events[0];
  if (first === undefined) {
    return { status: 'nao-percorrida' };
  }
  if (first.transitionType !== 'ABERTURA') {
    return { status: 'sem-duracao-medida' };
  }
  const last = events[events.length - 1];
  const hasConclusao = events.some((event) => event.transitionType === 'CONCLUSAO');
  if (last === undefined || !hasConclusao) {
    return { status: 'em-aberto' };
  }
  const ms = last.occurredAt.getTime() - first.occurredAt.getTime();
  const msPerPage = referenceExportPageCount === null ? null : ms / referenceExportPageCount;
  return { status: 'medido', ms, msPerPage };
}

function buildPerStage(
  stageEventsByType: Map<ProductionStageType, ContentMetricsStageEvent[]>,
  referenceExportPageCount: number | null,
): Record<ProductionStageType, StagePeriod> {
  const resolve = (stageType: ProductionStageType): StagePeriod =>
    resolveStagePeriod(stageEventsByType.get(stageType) ?? [], referenceExportPageCount);
  return {
    CONTEUDO_BRUTO: resolve('CONTEUDO_BRUTO'),
    QUEBRA_DA_REGRA: resolve('QUEBRA_DA_REGRA'),
    TIRA_MNEMONICA: resolve('TIRA_MNEMONICA'),
    ASSOCIACAO_VISUAL: resolve('ASSOCIACAO_VISUAL'),
    PUBLICACAO_PDF: resolve('PUBLICACAO_PDF'),
    MATERIAL_REFORCO: resolve('MATERIAL_REFORCO'),
    VERSAO_EDITORIAL: resolve('VERSAO_EDITORIAL'),
    APROVACAO_VERSAO: resolve('APROVACAO_VERSAO'),
  };
}

/**
 * Correções após revisão (FR-034-010/031, A-034-002): `RETRABALHO` de uma etapa de
 * conteúdo com `sequence` maior que a do 1º `VERSAO_EDITORIAL`. `sequence` é uma única
 * coluna globalmente monotônica (autoincrement) em TODO `ProductionStageEvent` — um
 * `RETRABALHO` e o fechamento nunca colidem em `sequence` (linhas distintas, mesma
 * sequência global), então `>` estrito nunca precisa de desempate por `>=`.
 */
function resolveReworkCountByStage(
  sortedStageEvents: ContentMetricsStageEvent[],
  closureSequence: bigint | null,
): Partial<Record<ContentStageType, number>> {
  if (closureSequence === null) {
    return {};
  }
  const counts: Partial<Record<ContentStageType, number>> = {};
  for (const event of sortedStageEvents) {
    if (event.transitionType !== 'RETRABALHO') continue;
    if (!isContentStageType(event.stageType)) continue;
    if (event.sequence > closureSequence) {
      counts[event.stageType] = (counts[event.stageType] ?? 0) + 1;
    }
  }
  return counts;
}

function resolveMostAdvancedStage(
  startEvent: ContentMetricsStageEvent | null,
  stageEventsByType: Map<ProductionStageType, ContentMetricsStageEvent[]>,
): ProductionStageType | 'sem-registro' {
  if (startEvent === null) {
    return 'sem-registro';
  }
  let mostAdvanced: ProductionStageType = 'CONTEUDO_BRUTO';
  for (const stageType of MOST_ADVANCED_STAGE_ORDER) {
    const events = stageEventsByType.get(stageType);
    if (events !== undefined && events.length > 0) {
      mostAdvanced = stageType;
    }
  }
  return mostAdvanced;
}

interface ApprovalStatus {
  concluded: boolean;
  approvedButAltered: boolean;
}

/**
 * `Concluído` (F9/DEC-035-007): Versão vigente aprovada E não alterada depois — mesma
 * regra única de `isVersionAltered` (COMP-035-008), aqui o 4º uso, em memória.
 * `currentVersionedFields` ausente com `approvedById !== null` é o chamador violando o
 * contrato de `ContentMetricsInput` (TASK-035-005 só omite quando não aprovada) — falha
 * fechada: nunca marca Concluído sem poder provar ausência de alteração (Art. 2).
 */
function resolveApprovalStatus(
  latestVersion: ContentLatestVersion | null,
  currentVersionedFields: VersionedContentFields | undefined,
  latestTiraOccurredAt: Date | null,
): ApprovalStatus {
  if (latestVersion === null || latestVersion.approvedById === null) {
    return { concluded: false, approvedButAltered: false };
  }
  if (currentVersionedFields === undefined) {
    return { concluded: false, approvedButAltered: false };
  }
  const altered = isVersionAltered(currentVersionedFields, latestVersion, latestTiraOccurredAt);
  return { concluded: !altered, approvedButAltered: altered };
}

/**
 * Métricas de um único Conteúdo (COMP-035-010): tempo total/por página, tempo por etapa
 * (8), correções após revisão, Concluído/alterado, etapa mais avançada, prioridade e
 * idade — tudo em memória, sem I/O.
 */
export function computeContentMetrics(now: Date, input: ContentMetricsInput): ContentMetrics {
  const sortedStageEvents = [...input.stageEvents].sort(compareBySequence);
  const stageEventsByType = groupStageEventsByType(sortedStageEvents);

  const startEvent = findFirstBySequence(stageEventsByType.get('CONTEUDO_BRUTO') ?? []);
  const firstClosureEvent = findFirstBySequence(stageEventsByType.get('VERSAO_EDITORIAL') ?? []);
  const closureSequence = firstClosureEvent === null ? null : firstClosureEvent.sequence;

  const referenceExport = findReferenceTiraExport(
    sortedStageEvents,
    input.tiraPublications,
    closureSequence,
  );
  const { totalTime, timePerPage, referenceExportPageCount } = resolveContentTime(
    startEvent,
    referenceExport,
  );

  // Paridade com F9 (`resolveAlterationSignal`, `orderBy: { sequence: 'desc' }`):
  // escolhe o evento TIRA_MNEMONICA de MAIOR `sequence`, nunca o de maior `occurredAt`.
  const latestTiraEvent = findLatestBySequence(stageEventsByType.get('TIRA_MNEMONICA') ?? []);
  const latestTiraOccurredAt = latestTiraEvent === null ? null : latestTiraEvent.occurredAt;

  const { concluded, approvedButAltered } = resolveApprovalStatus(
    input.latestVersion,
    input.currentVersionedFields,
    latestTiraOccurredAt,
  );

  return {
    contentId: input.content.id,
    disciplineName: input.content.disciplineName,
    topicName: input.content.topicName,
    totalTime,
    timePerPage,
    perStage: buildPerStage(stageEventsByType, referenceExportPageCount),
    reworkCountByStage: resolveReworkCountByStage(sortedStageEvents, closureSequence),
    concluded,
    approvedButAltered,
    mostAdvancedStage: resolveMostAdvancedStage(startEvent, stageEventsByType),
    priority: derivePresentationPriority(input.content.radarClass),
    ageMs: startEvent === null ? null : now.getTime() - startEvent.occurredAt.getTime(),
  };
}

export type TimePerPageAggregate =
  | { status: 'medido'; average: number; median: number; n: number; activeTotal: number }
  | { status: 'sem-medida'; n: number; activeTotal: number };

function computeAverage(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Assume `values` não vazio — só chamada quando `n > 0` (ver `aggregateTimePerPage`). */
function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middleIndex = Math.floor(sorted.length / 2);
  const middleValue = sorted[middleIndex];
  if (middleValue === undefined) {
    throw new Error('computeMedian chamado com lista vazia');
  }
  if (sorted.length % 2 === 1) {
    return middleValue;
  }
  const previousValue = sorted[middleIndex - 1];
  if (previousValue === undefined) {
    throw new Error('computeMedian chamado com lista vazia');
  }
  return (previousValue + middleValue) / 2;
}

function aggregateTimePerPage(metrics: ContentMetrics[]): TimePerPageAggregate {
  const measured = metrics
    .map((metric) => metric.timePerPage)
    .filter((value): value is number => value !== null);
  const activeTotal = metrics.length;
  if (measured.length === 0) {
    return { status: 'sem-medida', n: measured.length, activeTotal };
  }
  return {
    status: 'medido',
    average: computeAverage(measured),
    median: computeMedian(measured),
    n: measured.length,
    activeTotal,
  };
}

export interface ModuleAggregate {
  disciplineName: string;
  topicName: string;
  timePerPage: TimePerPageAggregate;
  completion: { active: number; concluded: number };
}

interface ModuleGroup {
  disciplineName: string;
  topicName: string;
  metrics: ContentMetrics[];
}

function groupByModule(metrics: ContentMetrics[]): ModuleGroup[] {
  const groups = new Map<string, ModuleGroup>();
  for (const metric of metrics) {
    const key = `${metric.disciplineName}\u0000${metric.topicName}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        disciplineName: metric.disciplineName,
        topicName: metric.topicName,
        metrics: [metric],
      });
    } else {
      existing.metrics.push(metric);
    }
  }
  return [...groups.values()];
}

function aggregateModule(group: ModuleGroup): ModuleAggregate {
  return {
    disciplineName: group.disciplineName,
    topicName: group.topicName,
    timePerPage: aggregateTimePerPage(group.metrics),
    completion: {
      active: group.metrics.length,
      concluded: group.metrics.filter((metric) => metric.concluded).length,
    },
  };
}

export interface ReworkTotals {
  byStage: Partial<Record<ContentStageType, number>>;
  contentsWithCorrection: number;
}

function aggregateRework(metrics: ContentMetrics[]): ReworkTotals {
  const byStage: Partial<Record<ContentStageType, number>> = {};
  let contentsWithCorrection = 0;
  for (const metric of metrics) {
    let metricHasCorrection = false;
    for (const stage of CONTENT_STAGE_TYPES) {
      const count = metric.reworkCountByStage[stage];
      if (count === undefined) continue;
      metricHasCorrection = true;
      byStage[stage] = (byStage[stage] ?? 0) + count;
    }
    if (metricHasCorrection) {
      contentsWithCorrection += 1;
    }
  }
  return { byStage, contentsWithCorrection };
}

export interface BacklogItem {
  contentId: string;
  disciplineName: string;
  topicName: string;
  mostAdvancedStage: ProductionStageType | 'sem-registro';
  priority: PresentationPriority;
  ageMs: number | null;
  approvedButAltered: boolean;
}

/** Alta→Média→Baixa, pela posição no array (nunca um mapa de rank numérico literal). */
const PRESENTATION_PRIORITY_ORDER: readonly PresentationPriority[] = ['ALTA', 'MEDIA', 'BAIXA'];

/** Alta→Média→Baixa e, dentro da prioridade, do mais antigo (idade maior) para o mais
 * novo; idade "sem medida" (`null`) sempre depois de idade numérica (FR-034-013/030). */
function compareBacklogItems(a: BacklogItem, b: BacklogItem): number {
  const priorityDelta =
    PRESENTATION_PRIORITY_ORDER.indexOf(a.priority) -
    PRESENTATION_PRIORITY_ORDER.indexOf(b.priority);
  if (priorityDelta !== NO_ORDER_DIFFERENCE) {
    return priorityDelta;
  }
  if (a.ageMs === null && b.ageMs === null) {
    return NO_ORDER_DIFFERENCE;
  }
  if (a.ageMs === null) {
    return 1;
  }
  if (b.ageMs === null) {
    return -1;
  }
  return b.ageMs - a.ageMs;
}

function buildBacklog(metrics: ContentMetrics[]): BacklogItem[] {
  return metrics
    .filter((metric) => !metric.concluded)
    .map((metric) => ({
      contentId: metric.contentId,
      disciplineName: metric.disciplineName,
      topicName: metric.topicName,
      mostAdvancedStage: metric.mostAdvancedStage,
      priority: metric.priority,
      ageMs: metric.ageMs,
      approvedButAltered: metric.approvedButAltered,
    }))
    .sort(compareBacklogItems);
}

export interface StrategicPanelPayload {
  factory: { timePerPage: TimePerPageAggregate };
  modules: ModuleAggregate[];
  rework: ReworkTotals;
  backlog: BacklogItem[];
}

/**
 * Agregação por Módulo/fábrica e backlog (COMP-035-011). `_now` integra a assinatura
 * pública por simetria com `computeContentMetrics` (COMP-035-011 declara os dois com a
 * mesma forma) — a idade de cada item já vem calculada em `metrics[].ageMs`; nada aqui
 * lê o relógio.
 */
export function aggregateStrategicPanel(
  _now: Date,
  metrics: ContentMetrics[],
): StrategicPanelPayload {
  return {
    factory: { timePerPage: aggregateTimePerPage(metrics) },
    modules: groupByModule(metrics).map(aggregateModule),
    rework: aggregateRework(metrics),
    backlog: buildBacklog(metrics),
  };
}
