import { Router } from 'express';

import { requireRole } from '../../http/middlewares/authorize';
import type {
  BacklogItem,
  ContentMetrics,
  ModuleAggregate,
  ReworkTotals,
  StagePeriod,
  StrategicPanelPayload,
  TimePerPageAggregate,
} from './strategic-panel-calculations';
import { buildStrategicPanel } from './strategic-panel.service';

/**
 * Superfície HTTP do Painel estratégico (COMP-035-016, TASK-035-006): único
 * endpoint, `GET /strategic-panel`. Sem `verifyOrigin` — padrão do projeto
 * para `GET` (mesmo de `content-versions.routes.ts`): a rota só lê, nunca
 * muta, e `verifyOrigin` protege mutação (DEC-003-004).
 */
export const strategicPanelRoutes = Router();

function toTimePerPageResponse(aggregate: TimePerPageAggregate) {
  if (aggregate.status === 'medido') {
    return {
      status: aggregate.status,
      average: aggregate.average,
      median: aggregate.median,
      n: aggregate.n,
      activeTotal: aggregate.activeTotal,
    };
  }
  return { status: aggregate.status, n: aggregate.n, activeTotal: aggregate.activeTotal };
}

function toModuleResponse(moduleAggregate: ModuleAggregate) {
  return {
    disciplineName: moduleAggregate.disciplineName,
    topicName: moduleAggregate.topicName,
    timePerPage: toTimePerPageResponse(moduleAggregate.timePerPage),
    completion: {
      active: moduleAggregate.completion.active,
      concluded: moduleAggregate.completion.concluded,
    },
  };
}

function toReworkResponse(rework: ReworkTotals) {
  return {
    byStage: { ...rework.byStage },
    contentsWithCorrection: rework.contentsWithCorrection,
  };
}

function toBacklogItemResponse(item: BacklogItem) {
  return {
    contentId: item.contentId,
    disciplineName: item.disciplineName,
    topicName: item.topicName,
    mostAdvancedStage: item.mostAdvancedStage,
    priority: item.priority,
    ageMs: item.ageMs,
    approvedButAltered: item.approvedButAltered,
  };
}

function toTotalTimeResponse(totalTime: ContentMetrics['totalTime']) {
  if ('ms' in totalTime) {
    return { ms: totalTime.ms, pageCount: totalTime.pageCount };
  }
  return { reason: totalTime.reason };
}

function toStagePeriodResponse(period: StagePeriod) {
  if (period.status === 'medido') {
    return { status: period.status, ms: period.ms, msPerPage: period.msPerPage };
  }
  return { status: period.status };
}

function toPerStageResponse(perStage: ContentMetrics['perStage']) {
  return {
    CONTEUDO_BRUTO: toStagePeriodResponse(perStage.CONTEUDO_BRUTO),
    QUEBRA_DA_REGRA: toStagePeriodResponse(perStage.QUEBRA_DA_REGRA),
    TIRA_MNEMONICA: toStagePeriodResponse(perStage.TIRA_MNEMONICA),
    ASSOCIACAO_VISUAL: toStagePeriodResponse(perStage.ASSOCIACAO_VISUAL),
    PUBLICACAO_PDF: toStagePeriodResponse(perStage.PUBLICACAO_PDF),
    MATERIAL_REFORCO: toStagePeriodResponse(perStage.MATERIAL_REFORCO),
    VERSAO_EDITORIAL: toStagePeriodResponse(perStage.VERSAO_EDITORIAL),
    APROVACAO_VERSAO: toStagePeriodResponse(perStage.APROVACAO_VERSAO),
  };
}

/**
 * Por Conteúdo (FR-034-004/005/006/011/025): mesma disciplina de allowlist
 * campo a campo — `totalTime`/`perStage` são uniões, cada ramo montado
 * explicitamente, nunca por spread.
 */
function toContentResponse(content: ContentMetrics) {
  return {
    contentId: content.contentId,
    disciplineName: content.disciplineName,
    topicName: content.topicName,
    totalTime: toTotalTimeResponse(content.totalTime),
    timePerPage: content.timePerPage,
    perStage: toPerStageResponse(content.perStage),
    reworkCountByStage: { ...content.reworkCountByStage },
    concluded: content.concluded,
    approvedButAltered: content.approvedButAltered,
    mostAdvancedStage: content.mostAdvancedStage,
    priority: content.priority,
    ageMs: content.ageMs,
  };
}

/**
 * Allowlist campo a campo (DEC-035-017, fricção deliberada): monta a resposta
 * a partir de `StrategicPanelPayload` (TASK-035-004) NOME A NOME — nenhuma
 * chave fora desta lista chega ao cliente, e um campo novo em
 * `StrategicPanelPayload`/`ContentMetrics` só sai daqui com edição consciente
 * desta função. Nunca `res.json(payload)` direto.
 */
export function toStrategicPanelResponse(payload: StrategicPanelPayload) {
  return {
    contents: payload.contents.map(toContentResponse),
    factory: { timePerPage: toTimePerPageResponse(payload.factory.timePerPage) },
    modules: payload.modules.map(toModuleResponse),
    rework: toReworkResponse(payload.rework),
    backlog: payload.backlog.map(toBacklogItemResponse),
  };
}

export type StrategicPanelResponse = ReturnType<typeof toStrategicPanelResponse>;

/**
 * GET /strategic-panel — Painel agregado por Módulo/fábrica/backlog
 * (FR-034-015/016: EDITOR/ADMIN only; NFR-034-003/004: a allowlist acima
 * nunca deixa passar texto normativo nem identidade de autor/aprovador).
 */
strategicPanelRoutes.get(
  '/strategic-panel',
  requireRole('GET', '/strategic-panel', 'EDITOR', 'ADMIN'),
  async (_req, res) => {
    const payload = await buildStrategicPanel(new Date());
    res.json(toStrategicPanelResponse(payload));
  },
);
