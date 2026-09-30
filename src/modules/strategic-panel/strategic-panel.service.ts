import type { Prisma } from '../../generated/prisma/client';
import {
  RAW_CONTENT_VERSIONED_SELECT,
  RULE_BREAKDOWN_VERSIONED_SELECT,
} from '../content-versions/content-versions.service';
import {
  toVersionedContentFields,
  type VersionedContentFields,
} from '../content-versions/versioned-content-diff';
import { ACTIVE_RAW_CONTENT_WHERE } from '../contents/contents.service';
import { prisma } from '../../lib/prisma';

/**
 * Leitura em lote do Painel estratégico (COMP-035-004/005/006/007, TASK-035-005):
 * 6 funções — 5 fazem 1 `findMany`/consulta `IN (...)` cada, 1
 * (`listCurrentVersionedFieldsForApprovedContents`) faz 2 — (NFR-034-001 — nunca 1
 * por Conteúdo), que alimentam o cálculo puro (`strategic-panel-calculations.ts`,
 * TASK-035-004). Leitura FACTORY-WIDE deliberada (DEC-035-013): nenhuma das 6 aplica
 * `scopeWhere(actor)` — o Painel agrega por Módulo/fábrica/backlog, não por autoria
 * (a persona "conclusão do meu módulo" refere-se ao Tema, não a quem produziu). A
 * orquestração que soma as leituras e chama o cálculo puro é TASK-035-006; este
 * módulo cobre só a camada de leitura.
 */

/** Cliente Prisma injetável — cobre os 5 models lidos pelas 6 funções abaixo. */
type PanelClient = Pick<
  typeof prisma,
  'rawContent' | 'productionStageEvent' | 'publicationEvent' | 'contentVersion' | 'ruleBreakdown'
>;

/**
 * `select` PRÓPRIO (nunca `RAW_CONTENT_SUMMARY_SELECT` de `contents.service.ts`):
 * este módulo não precisa de `sourceCitation`/`breakdown`, que aquele inclui e o
 * Painel não usa. Nunca `rawText`/`sourceCitation`/`pegadinhaText` (NFR-034-003).
 */
const PANEL_CONTENT_SELECT = {
  id: true,
  radarClass: true,
  topic: { select: { name: true, discipline: { select: { name: true } } } },
} as const satisfies Prisma.RawContentSelect;

export type PanelContentRow = Prisma.RawContentGetPayload<{
  select: typeof PANEL_CONTENT_SELECT;
}>;

/**
 * Conteúdos ativos (FR-034-014, AC-034-011): reusa `ACTIVE_RAW_CONTENT_WHERE`
 * (`contents.service.ts`, DEC-006-001) — o mesmo filtro de remoção reversível de
 * F2 — e **sem** `scopeWhere(actor)` (DEC-035-013): assinatura de 1 parâmetro
 * (`db`), nunca recebe `actor`/`authorId`.
 */
export async function listActiveContentsForPanel(
  db: PanelClient = prisma,
): Promise<PanelContentRow[]> {
  return db.rawContent.findMany({
    where: ACTIVE_RAW_CONTENT_WHERE,
    select: PANEL_CONTENT_SELECT,
  });
}

/** `select` sem `actorId` (NFR-034-004): o Painel não agrega por pessoa, o dado nem entra em memória. */
const PANEL_STAGE_EVENT_SELECT = {
  rawContentId: true,
  stageType: true,
  transitionType: true,
  sequence: true,
  occurredAt: true,
} as const satisfies Prisma.ProductionStageEventSelect;

export type PanelStageEventRow = Prisma.ProductionStageEventGetPayload<{
  select: typeof PANEL_STAGE_EVENT_SELECT;
}>;

/** Eventos de etapa dos Conteúdos em `rawContentIds`, 1 `findMany` `IN (...)`. */
export async function listStageEventsForPanel(
  rawContentIds: string[],
  db: PanelClient = prisma,
): Promise<PanelStageEventRow[]> {
  return db.productionStageEvent.findMany({
    where: { rawContentId: { in: rawContentIds } },
    orderBy: { sequence: 'asc' },
    select: PANEL_STAGE_EVENT_SELECT,
  });
}

const PANEL_PUBLICATION_EVENT_SELECT = {
  rawContentId: true,
  occurredAt: true,
  pageCount: true,
} as const satisfies Prisma.PublicationEventSelect;

export type PanelPublicationEventRow = Prisma.PublicationEventGetPayload<{
  select: typeof PANEL_PUBLICATION_EVENT_SELECT;
}>;

/**
 * Publicações da Variante Tira dos Conteúdos em `rawContentIds`, 1 `findMany`
 * `IN (...)` filtrado por `variant: 'TIRA'` — `pageCount` (coluna nova da
 * TASK-035-001, `null` para Exportação anterior a ela).
 */
export async function listTiraPublicationEventsForPanel(
  rawContentIds: string[],
  db: PanelClient = prisma,
): Promise<PanelPublicationEventRow[]> {
  return db.publicationEvent.findMany({
    where: { rawContentId: { in: rawContentIds }, variant: 'TIRA' },
    select: PANEL_PUBLICATION_EVENT_SELECT,
  });
}

/**
 * Sem `contentSnapshot` (DEC-035-014 — coluna larga fora da leitura do
 * histórico): esta leitura serve para o CHAMADOR (TASK-035-006) agrupar por
 * `rawContentId` e achar a Versão vigente; `id` é o que ele repassa a
 * `listApprovedVersionSnapshots` (abaixo) para buscar o snapshot só das
 * aprovadas.
 */
const PANEL_VERSION_SELECT = {
  id: true,
  rawContentId: true,
  number: true,
  closedAt: true,
  approvedById: true,
} as const satisfies Prisma.ContentVersionSelect;

export type PanelVersionRow = Prisma.ContentVersionGetPayload<{
  select: typeof PANEL_VERSION_SELECT;
}>;

/**
 * Todas as Versões dos Conteúdos em `rawContentIds`, 1 `findMany` `IN (...)`,
 * `orderBy: number asc` — o CHAMADOR (TASK-035-006) agrupa em memória por
 * `rawContentId` (última entrada de cada grupo = vigente), nunca 1 `findFirst`
 * por Conteúdo.
 */
export async function listLatestVersionsForPanel(
  rawContentIds: string[],
  db: PanelClient = prisma,
): Promise<PanelVersionRow[]> {
  return db.contentVersion.findMany({
    where: { rawContentId: { in: rawContentIds } },
    orderBy: { number: 'asc' },
    select: PANEL_VERSION_SELECT,
  });
}

const PANEL_VERSION_SNAPSHOT_SELECT = {
  id: true,
  contentSnapshot: true,
} as const satisfies Prisma.ContentVersionSelect;

export type PanelVersionSnapshotRow = Prisma.ContentVersionGetPayload<{
  select: typeof PANEL_VERSION_SNAPSHOT_SELECT;
}>;

/**
 * `contentSnapshot` só das Versões em `versionIds`, 1 `findMany` `id: { in }`
 * (DEC-035-014): separada de `listLatestVersionsForPanel` porque o Painel só
 * precisa do snapshot das Versões APROVADAS (para `resolveApprovalStatus`,
 * TASK-035-004) — o CHAMADOR (TASK-035-006) resolve esse subconjunto de
 * `id`s e passa aqui.
 */
export async function listApprovedVersionSnapshots(
  versionIds: string[],
  db: PanelClient = prisma,
): Promise<PanelVersionSnapshotRow[]> {
  return db.contentVersion.findMany({
    where: { id: { in: versionIds } },
    select: PANEL_VERSION_SNAPSHOT_SELECT,
  });
}

/**
 * Campos versionados ATUAIS dos Conteúdos cuja Versão vigente já está aprovada —
 * 2 `findMany` `IN (...)` (`RawContent`/`RuleBreakdown`, custo fixo) com o
 * `select` versionado IMPORTADO de `content-versions.service.ts` (reuso, nunca
 * redeclarado) e `toVersionedContentFields` (F9, `versioned-content-diff.ts`,
 * único ponto de manutenção). O CHAMADOR (TASK-035-006) resolve o subconjunto de
 * Conteúdos aprovados e passa `rawContentIds` aqui — esta função aceita qualquer
 * lista e só devolve o que existe: um id sem `RawContent` ou sem `RuleBreakdown`
 * correspondente simplesmente não entra no `Map` resultante (nunca lança, nunca
 * inclui campos vazios).
 */
export async function listCurrentVersionedFieldsForApprovedContents(
  rawContentIds: string[],
  db: PanelClient = prisma,
): Promise<Map<string, VersionedContentFields>> {
  const [rawContents, ruleBreakdowns] = await Promise.all([
    db.rawContent.findMany({
      where: { id: { in: rawContentIds } },
      select: { id: true, ...RAW_CONTENT_VERSIONED_SELECT },
    }),
    db.ruleBreakdown.findMany({
      where: { rawContentId: { in: rawContentIds } },
      select: { rawContentId: true, ...RULE_BREAKDOWN_VERSIONED_SELECT },
    }),
  ]);

  const ruleBreakdownByRawContentId = new Map(
    ruleBreakdowns.map((ruleBreakdown) => [ruleBreakdown.rawContentId, ruleBreakdown]),
  );

  const result = new Map<string, VersionedContentFields>();
  for (const rawContent of rawContents) {
    const ruleBreakdown = ruleBreakdownByRawContentId.get(rawContent.id);
    if (ruleBreakdown === undefined) continue;
    result.set(rawContent.id, toVersionedContentFields(rawContent, ruleBreakdown));
  }
  return result;
}
