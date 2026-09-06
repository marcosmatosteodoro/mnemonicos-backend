import type { ProductionEventTransition, ProductionStageType } from '../../domain/types';
import type { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../lib/prisma';

/**
 * Mecanismo genérico de evento de etapa de produção (COMP-010-002 / SPEC-009):
 * regra de decisão pura (abertura/conclusão/retrabalho), emissão transacional
 * e leitura ordenada. Módulo **sem** `.schema.ts` nem `.routes.ts` — nunca
 * chamado a partir de uma rota, só de outro `.service.ts` (DEC-010-004).
 *
 * Nenhuma função aqui atualiza ou apaga uma linha de `ProductionStageEvent`
 * (FR-009-007) — a garantia é a AUSÊNCIA de método de update/delete.
 */

/**
 * Decide a transição a partir do histórico já registrado para um par
 * (`rawContentId`, `stageType`) — pura, sem I/O (DEC-010-005): 0 eventos →
 * abertura; existe `ABERTURA` mas nenhuma `CONCLUSAO` → conclusão; existe
 * `CONCLUSAO` → retrabalho (para sempre a partir daí). Usa `includes`, nunca
 * posição/índice do array de entrada — AC-009-008 exige indiferença à ordem
 * de leitura do histórico.
 */
export function decideStageTransition(
  existingTransitions: readonly ProductionEventTransition[],
): ProductionEventTransition {
  if (existingTransitions.includes('CONCLUSAO')) return 'RETRABALHO';
  if (existingTransitions.includes('ABERTURA')) return 'CONCLUSAO';
  return 'ABERTURA';
}

export interface ProductionStageEventInput {
  rawContentId: string;
  stageType: ProductionStageType;
  actorId: string;
  /** Instante do registro, injetado pelo chamador — nunca `new Date()`/`now()` do banco (DEC-010-002). */
  now: Date;
}

/** Cliente Prisma injetável — recebe o `tx` da transação interativa do chamador (DEC-010-003). */
type ProductionStageEventClient = Pick<typeof prisma, 'productionStageEvent'>;

/**
 * Nunca abre transação própria — quem chama já está numa (o `tx` é do
 * chamador, DEC-010-003).
 */
export async function recordProductionStageEvent(
  tx: ProductionStageEventClient,
  input: ProductionStageEventInput,
): Promise<void> {
  const existing = await tx.productionStageEvent.findMany({
    where: { rawContentId: input.rawContentId, stageType: input.stageType },
    select: { transitionType: true },
  });

  const transitionType = decideStageTransition(existing.map((event) => event.transitionType));

  await tx.productionStageEvent.create({
    data: {
      rawContentId: input.rawContentId,
      stageType: input.stageType,
      transitionType,
      actorId: input.actorId,
      occurredAt: input.now,
    },
  });
}

const PRODUCTION_STAGE_EVENT_SELECT = {
  id: true,
  rawContentId: true,
  stageType: true,
  transitionType: true,
  actorId: true,
  occurredAt: true,
} as const satisfies Prisma.ProductionStageEventSelect;

export interface ProductionStageEventRecord {
  id: string;
  rawContentId: string;
  stageType: ProductionStageType;
  transitionType: ProductionEventTransition;
  actorId: string;
  occurredAt: Date;
}

/**
 * Devolve os eventos de etapa de um conteúdo em ordem determinística de
 * registro (`orderBy: sequence asc`, DEC-010-002) — leitura interna pura, sem
 * `include`/agregação/cálculo (FR-009-010). `select` explícito: só os campos
 * que `ProductionStageEventRecord` expõe, nunca a linha inteira (perfil §10).
 */
export async function listProductionStageEvents(
  rawContentId: string,
  db: ProductionStageEventClient = prisma,
): Promise<ProductionStageEventRecord[]> {
  return db.productionStageEvent.findMany({
    where: { rawContentId },
    orderBy: { sequence: 'asc' },
    select: PRODUCTION_STAGE_EVENT_SELECT,
  });
}
