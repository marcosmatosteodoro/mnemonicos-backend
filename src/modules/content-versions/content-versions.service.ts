import type { Prisma } from '../../generated/prisma/client';
import { ForbiddenError, NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import { assertRawContentReachable, type ContentActor } from '../contents/contents.service';
import { recordProductionStageEvent } from '../production-events/production-events.service';
import type { CloseContentVersionInput } from './content-versions.schema';
import {
  hasVersionedContentChanged,
  toVersionedContentFields,
  type VersionedContentFields,
} from './versioned-content-diff';

/**
 * Ciclo de vida de Versão editorial (COMP-029-004/005 / TASK-029-002):
 * `closeContentVersion` (escrita, ÚNICA — append-only, FR-028-004: nenhuma
 * função de update/delete existe neste módulo) e `listContentVersions`
 * (leitura do histórico completo). Guarda composta de `closeContentVersion`,
 * NESTA ORDEM (DEC-029-004/DEC-029-001, PLAN §6):
 *
 *   1. `tx.$queryRaw` `SELECT ... FOR UPDATE` trava a linha do `RawContent`
 *      pai — 1ª chamada do corpo, ANTES de qualquer decisão (molde
 *      `visual-associations.service.ts` `removeVisualAssociation`). Serializa
 *      fechamentos concorrentes do MESMO `rawContentId` (corrida de
 *      numeração, DEC-029-004).
 *   2. `assertRawContentReachable` (importado de `contents.service.ts`) —
 *      resolve inexistente/fora de alcance/soft-deleted na MESMA ordem e
 *      mensagens já estabelecidas por F2.
 *   3. Checagem explícita `actor.role === 'ADMIN' || rawContent.authorId ===
 *      actor.id` (DEC-029-001) — defesa em profundidade: para EDITOR,
 *      `assertRawContentReachable` já barraria um `rawContentId` de outro
 *      autor; este guard cobre ADMIN sempre passando, e é literal da DEC.
 *   4. `RuleBreakdown` precisa existir (FR-028-003/AC-028-004) — sem ela,
 *      recusa e informa o motivo, sem `INSERT`.
 *   5. Próximo `number` sequencial, dentro da MESMA transação, depois do lock
 *      do passo 1.
 *   6. Monta o `contentSnapshot` via `toVersionedContentFields`
 *      (`versioned-content-diff.ts`) — ALLOWLIST explícita dos campos
 *      versionados lidos nos passos 2/3 (RawContent) e 4 (RuleBreakdown),
 *      NUNCA espalhamento (`...rawContent`/`...ruleBreakdown`): o objeto
 *      inteiro carregaria campos não-versionados (ex.: `pegadinhaText`) para
 *      dentro do snapshot.
 *   7. `tx.contentVersion.create`.
 *   8. `recordProductionStageEvent(tx, { ..., transitionType: 'CONCLUSAO' })`
 *      — ÚLTIMA chamada do corpo, sempre `CONCLUSAO` direto, nunca via
 *      `decideStageTransition` (DEC-029-005).
 *
 * Qualquer falha nos passos 1-8 propaga sem gravar nada (fail-secure,
 * NFR-028-001/002).
 */

const CONTENT_VERSION_DETAIL_SELECT = {
  id: true,
  rawContentId: true,
  number: true,
  legislativeClosureDate: true,
  authorId: true,
  closedAt: true,
} as const satisfies Prisma.ContentVersionSelect;

export interface ContentVersionDetail {
  id: string;
  rawContentId: string;
  number: number;
  legislativeClosureDate: Date;
  authorId: string;
  closedAt: Date;
}

/**
 * Cliente Prisma injetável (mesmo padrão de `ContrastClient`): cobre
 * `contentVersion`, `rawContent` (exigido pelo tipo de `assertRawContentReachable`),
 * `ruleBreakdown` (leitura do par versionado), `$transaction` e
 * `productionStageEvent` (COMP-031-003/DEC-031-007 — `resolveAlterationSignal`
 * lê o evento de Tira emitido por `tira.service.ts`, sem importar nada desse
 * módulo além do valor do enum `stageType`).
 */
type ContentVersionClient = Pick<
  typeof prisma,
  'contentVersion' | 'rawContent' | 'ruleBreakdown' | 'productionStageEvent' | '$transaction'
>;

/**
 * Campos versionados do `RawContent` lidos na MESMA linha travada no passo 1
 * (nenhuma 3ª leitura de `RawContent`) — usados para a checagem autor-ou-ADMIN
 * (passo 3) e para montar o `contentSnapshot` (passo 6).
 */
const RAW_CONTENT_VERSIONED_SELECT = {
  authorId: true,
  rawText: true,
  radarClass: true,
  sourceType: true,
  sourceCitation: true,
  sourceUrl: true,
} as const satisfies Prisma.RawContentSelect;

/** Campos versionados da `RuleBreakdown` (passo 4/6) — os 5 blocos + a síntese. */
const RULE_BREAKDOWN_VERSIONED_SELECT = {
  concept: true,
  action: true,
  object: true,
  condition: true,
  exception: true,
  essence: true,
} as const satisfies Prisma.RuleBreakdownSelect;

/**
 * Fecha uma nova Versão editorial de `rawContentId` (FR-028-001 a 004/007,
 * NFR-028-001/002). Autor do `RawContent` ou ADMIN (DEC-029-001); recusa se o
 * pai estiver inalcançável/soft-deleted (`assertRawContentReachable`) ou sem
 * `RuleBreakdown` salva (FR-028-003).
 */
export async function closeContentVersion(
  rawContentId: string,
  input: CloseContentVersionInput,
  actor: ContentActor,
  db: ContentVersionClient = prisma,
): Promise<ContentVersionDetail> {
  return db.$transaction(async (tx) => {
    // Passo 1 (DEC-029-004): trava a linha do RawContent pai ANTES de
    // qualquer decisão — serializa fechamentos concorrentes do mesmo
    // rawContentId (molde visual-associations.service.ts:340-342).
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM raw_contents WHERE id = ${rawContentId} FOR UPDATE
    `;
    if (locked[0] === undefined) {
      throw new NotFoundError('Conteúdo bruto não encontrado.');
    }

    // Passo 2 (DEC-029-001 herdada): guarda de alcance por autoria.
    await assertRawContentReachable(rawContentId, actor, tx);

    // Passo 3: leitura de detalhe do RawContent — reaproveita a MESMA linha
    // travada no passo 1 (nenhuma 3ª leitura de RawContent).
    const rawContent = await tx.rawContent.findUniqueOrThrow({
      where: { id: rawContentId },
      select: RAW_CONTENT_VERSIONED_SELECT,
    });

    if (actor.role !== 'ADMIN' && rawContent.authorId !== actor.id) {
      throw new ForbiddenError('Você não tem permissão para fechar uma versão deste conteúdo.');
    }

    // Passo 4 (FR-028-003/AC-028-004): a Quebra da regra precisa existir.
    const ruleBreakdown = await tx.ruleBreakdown.findUnique({
      where: { rawContentId },
      select: RULE_BREAKDOWN_VERSIONED_SELECT,
    });
    if (ruleBreakdown === null) {
      throw new NotFoundError('Quebra da regra precisa existir antes do fechamento.');
    }

    // Passo 5 (DEC-029-004): próximo número, dentro da MESMA transação,
    // depois do lock do passo 1.
    const last = await tx.contentVersion.findFirst({
      where: { rawContentId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;

    // Passo 6 (DEC-029-003): allowlist explícita dos campos versionados, via
    // `toVersionedContentFields` — a MESMA função que `publication.service.ts`
    // usa para o lado "atual" da comparação (`versioned-content-diff.ts`,
    // único ponto de manutenção) — NUNCA espalhamento de
    // RawContent/RuleBreakdown (o objeto inteiro carregaria campos
    // não-versionados, ex. pegadinhaText, para dentro do snapshot).
    const contentSnapshot = toVersionedContentFields(rawContent, ruleBreakdown);

    const created = await tx.contentVersion.create({
      data: {
        rawContentId,
        number,
        legislativeClosureDate: new Date(input.legislativeClosureDate),
        authorId: actor.id,
        contentSnapshot,
      },
      select: CONTENT_VERSION_DETAIL_SELECT,
    });

    // Passo 8 (DEC-029-005): sempre CONCLUSAO direto, nunca via
    // decideStageTransition — ÚLTIMA chamada do corpo.
    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'VERSAO_EDITORIAL',
      transitionType: 'CONCLUSAO',
      actorId: actor.id,
      now: new Date(),
    });

    return created;
  });
}

/**
 * Lista o histórico completo de Versões editoriais de `rawContentId`, do
 * número mais antigo ao mais recente (FR-028-005). Mesma guarda de alcance de
 * `assertRawContentReachable` (DEC-029-002 herdada), SEM restrição adicional
 * por autoria da Versão — um EDITOR que alcança o próprio `RawContent` vê
 * TODAS as Versões nele, mesmo as fechadas por um ADMIN.
 *
 * Custo depende só de `N` (Versões daquele `RawContent`, NFR-028-003/AC-028-012)
 * — o índice `@@unique([rawContentId, number])` (TASK-029-001) serve o
 * `findMany` filtrado por `rawContentId`. Medido: 2 statements
 * (`assertRawContentReachable` + este `findMany`), nenhum dos 2 cresce com
 * `N` — nunca 1 único statement (a guarda de alcance é uma leitura própria).
 */
export async function listContentVersions(
  rawContentId: string,
  actor: ContentActor,
  db: ContentVersionClient = prisma,
): Promise<ContentVersionDetail[]> {
  await assertRawContentReachable(rawContentId, actor, db);

  return db.contentVersion.findMany({
    where: { rawContentId },
    orderBy: { number: 'asc' },
    select: CONTENT_VERSION_DETAIL_SELECT,
  });
}

/**
 * Sinal combinado de alteração pós-fechamento (DEC-031-007): OU lógico entre
 * `hasVersionedContentChanged` (CONTEÚDO/Quebra da regra) e o evento de Tira
 * mnemônica mais recente (`ProductionStageEvent`, `stageType:
 * 'TIRA_MNEMONICA'`) posterior a `version.closedAt`. Único ponto de
 * manutenção da combinação.
 *
 * Short-circuit (TRISK-031-002): CONTEÚDO alterado retorna sem consultar
 * `productionStageEvent`. `orderBy: { sequence: 'desc' }` (nunca
 * `occurredAt`) — desempate determinístico (AC-009-008).
 */
export async function resolveAlterationSignal(
  rawContentId: string,
  current: VersionedContentFields,
  version: { contentSnapshot: unknown; closedAt: Date },
  db: Pick<typeof prisma, 'productionStageEvent'>,
): Promise<boolean> {
  if (hasVersionedContentChanged(current, version.contentSnapshot as VersionedContentFields)) {
    return true;
  }

  const latestTiraEvent = await db.productionStageEvent.findFirst({
    where: { rawContentId, stageType: 'TIRA_MNEMONICA' },
    orderBy: { sequence: 'desc' },
    select: { occurredAt: true },
  });

  return latestTiraEvent !== null && latestTiraEvent.occurredAt > version.closedAt;
}
