import { Router } from 'express';

import { requireRole } from '../../http/middlewares/authorize';
import type {
  BacklogItem,
  ModuleAggregate,
  ReworkTotals,
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

/**
 * Allowlist campo a campo (DEC-035-017, fricção deliberada — mesma classe de
 * vazamento já ocorrida neste slug em F9, `contentSnapshot`, lição "select
 * exposto que lê campo interno prova as chaves do payload"): monta a resposta
 * a partir de `StrategicPanelPayload` (TASK-035-004) NOME A NOME — nenhuma
 * chave fora desta lista chega ao cliente, e um campo novo em
 * `StrategicPanelPayload`/`ContentMetrics` só sai daqui com edição consciente
 * desta função. Nunca `res.json(payload)` direto.
 */
export function toStrategicPanelResponse(payload: StrategicPanelPayload) {
  return {
    factory: { timePerPage: toTimePerPageResponse(payload.factory.timePerPage) },
    modules: payload.modules.map(toModuleResponse),
    rework: toReworkResponse(payload.rework),
    backlog: payload.backlog.map(toBacklogItemResponse),
  };
}

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
