import { Prisma } from '../../generated/prisma/client';
import { ConflictError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import {
  assertRawContentReachable,
  type ContentActor,
  type RuleBreakdownDetail,
} from '../contents/contents.service';
import { recordProductionStageEvent } from '../production-events/production-events.service';
import type { ReorderMnemonicFramesInput } from './tira.schema';

/**
 * Núcleo do módulo Tira mnemônica (COMP-012-004): geração inicial (regra
 * pura, `buildInitialFrames`), abertura get-or-generate idempotente
 * (`openMnemonicStrip`), reindexação atômica em 2 fases (`reassignPositions`)
 * e reordenação de Quadros (`reorderMnemonicFrames`). CRUD de Quadro
 * (adicionar/editar/remover) fica fora desta TASK (TASK-012-007, que reusa
 * `reassignPositions` sem recriá-la).
 */

export interface MnemonicFrameDetail {
  id: string;
  text: string;
  position: number;
  originBlock: string | null;
}

export interface MnemonicStripDetail {
  id: string;
  frames: MnemonicFrameDetail[];
}

/**
 * Ordem canônica do método (FR-011-001): 1 item por Bloco não-vazio, posições
 * 1..N sem lacuna. Pura, sem I/O — testável isoladamente (mesmo espírito de
 * `decideStageTransition`). `condition`/`exception` em branco ("não se
 * aplica", `null` ou `''`) não geram Quadro (AC-011-002).
 */
export function buildInitialFrames(
  breakdown: Pick<RuleBreakdownDetail, 'concept' | 'action' | 'object' | 'condition' | 'exception'>,
): Array<{ text: string; position: number; originBlock: string }> {
  const canonicalOrder: Array<{ originBlock: string; text: string | null }> = [
    { originBlock: 'concept', text: breakdown.concept },
    { originBlock: 'action', text: breakdown.action },
    { originBlock: 'object', text: breakdown.object },
    { originBlock: 'condition', text: breakdown.condition },
    { originBlock: 'exception', text: breakdown.exception },
  ];

  const nonEmpty = canonicalOrder.filter(
    (block): block is { originBlock: string; text: string } =>
      block.text !== null && block.text !== undefined && block.text !== '',
  );

  return nonEmpty.map((block, index) => ({
    text: block.text,
    position: index + 1,
    originBlock: block.originBlock,
  }));
}

/**
 * `select` explícito de `MnemonicStripDetail`, incluindo os Quadros ordenados
 * por posição (FR-011-007). Relação de LISTA (`frames`) — `relationLoadStrategy:
 * 'join'` fixado explicitamente (lição [Performance], ressalva 2: relação de
 * lista nem sempre resolve por `join` de graça; medido em
 * `tira.service.integration.test.ts`, "round-trips fixados" — 1 round-trip
 * tanto no `findUnique` de reabertura quanto no `create` da geração inicial,
 * contra 2 fixos de `relationLoadStrategy: 'query'`).
 */
const MNEMONIC_STRIP_DETAIL_SELECT = {
  id: true,
  frames: {
    orderBy: { position: 'asc' },
    select: { id: true, text: true, position: true, originBlock: true },
  },
} as const satisfies Prisma.MnemonicStripSelect;

type MnemonicStripRow = Prisma.MnemonicStripGetPayload<{
  select: typeof MNEMONIC_STRIP_DETAIL_SELECT;
}>;

/**
 * Cliente Prisma injetável (mesmo padrão de `RawContentClient`/
 * `RuleBreakdownClient` de `contents.service.ts`): cobre `rawContent`
 * (para `assertRawContentReachable`), `ruleBreakdown` (localizar a Quebra do
 * `rawContentId`), `mnemonicStrip` (a própria Tira), `mnemonicFrame`
 * (validar/reindexar Quadros) e `$transaction`.
 */
type MnemonicStripClient = Pick<
  typeof prisma,
  'rawContent' | 'ruleBreakdown' | 'mnemonicStrip' | 'mnemonicFrame' | '$transaction'
>;

const RULE_BREAKDOWN_FOR_STRIP_SELECT = {
  id: true,
  concept: true,
  action: true,
  object: true,
  condition: true,
  exception: true,
} as const satisfies Prisma.RuleBreakdownSelect;

/**
 * Abre a Tira mnemônica de uma Quebra da regra — get-or-generate idempotente
 * (FR-011-001/FR-011-002): gera a Tira + 1 Quadro por Bloco não-vazio na 1ª
 * abertura (emite só ABERTURA, DEC-012-006); reabre a Tira já existente sem
 * gerar de novo nem emitir evento novo (AC-011-003, AC-011-013, AC-011-021).
 * 409 (`ConflictError`) se a Quebra da regra do `rawContentId` ainda não foi
 * salva (AC-011-023, parte — regra recusa; o mapeamento HTTP é da TASK de
 * rotas).
 *
 * **Alcance por autoria** (NFR-011-001, NFR-011-006): `assertRawContentReachable`
 * é a 1ª chamada, sempre — herda a mesma ordem de guardas (inexistente → fora
 * do alcance → soft-deleted) e a mesma mensagem de `contents.service.ts`, sem
 * reescrevê-la (DEC-012-007).
 *
 * **Concorrência real sob 1ª abertura** (AC-011-025, DEC-012-008): depois de
 * `findUnique` confirmar que a Tira ainda não existe, o `create` pode colidir
 * com o `@unique(ruleBreakdownId)` se outra transação venceu a corrida no
 * meio do caminho — a violação (`P2002`) é deixada propagar para FORA do
 * `$transaction` (nunca capturada dentro dele): uma vez que o Postgres marca
 * a transação como abortada por causa da violação de constraint, qualquer
 * tentativa de LER dentro da MESMA transação falharia ("current transaction
 * is aborted"); o `$transaction` do Prisma já faz o ROLLBACK automático da
 * transação perdedora quando o callback lança. O `catch` externo então lê a
 * Tira da transação vencedora numa consulta NOVA (fora de qualquer
 * transação), sem emitir um 2º evento de abertura — a vencedora já gravou o
 * seu.
 *
 * Fail-secure (NFR-011-003, AC-011-015): a criação da Tira/Quadros e a
 * emissão do evento de abertura rodam na MESMA `$transaction` interativa —
 * falha na emissão reverte a criação inteira, nenhum estado meio-salvo.
 */
export async function openMnemonicStrip(
  rawContentId: string,
  actor: ContentActor,
  db: MnemonicStripClient = prisma,
): Promise<MnemonicStripDetail> {
  let ruleBreakdownId: string | undefined;

  try {
    return await db.$transaction(async (tx) => {
      await assertRawContentReachable(rawContentId, actor, tx);

      const breakdown = await tx.ruleBreakdown.findUnique({
        where: { rawContentId },
        select: RULE_BREAKDOWN_FOR_STRIP_SELECT,
      });
      if (breakdown === null) {
        throw new ConflictError('Conclua a Quebra da regra antes de abrir a Tira mnemônica.');
      }
      ruleBreakdownId = breakdown.id;

      const existing: MnemonicStripRow | null = await tx.mnemonicStrip.findUnique({
        where: { ruleBreakdownId: breakdown.id },
        relationLoadStrategy: 'join',
        select: MNEMONIC_STRIP_DETAIL_SELECT,
      });
      // Reabertura simples (FR-011-007, AC-011-003, AC-011-012): a Tira já
      // existe — devolve os Quadros na ordem de `position` persistida, sem
      // tentar `create` nem emitir evento novo (3º ramo da árvore de decisão,
      // §4 F-1.6 do PLAN-012).
      if (existing !== null) return existing;

      const created = await tx.mnemonicStrip.create({
        data: {
          ruleBreakdownId: breakdown.id,
          frames: { create: buildInitialFrames(breakdown) },
        },
        relationLoadStrategy: 'join',
        select: MNEMONIC_STRIP_DETAIL_SELECT,
      });

      // 0 eventos existentes para o par (rawContentId, 'TIRA_MNEMONICA') →
      // decide ABERTURA (FR-011-008/AC-011-013) — nunca conclusão no mesmo
      // instante (correção do PO, DEC-012-006): a conclusão só ocorre na 1ª
      // mutação humana de Quadro, fora desta TASK.
      await recordProductionStageEvent(tx, {
        rawContentId,
        stageType: 'TIRA_MNEMONICA',
        actorId: actor.id,
        now: new Date(),
      });

      return created;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      ruleBreakdownId !== undefined
    ) {
      const winner = await db.mnemonicStrip.findUniqueOrThrow({
        where: { ruleBreakdownId },
        relationLoadStrategy: 'join',
        select: MNEMONIC_STRIP_DETAIL_SELECT,
      });
      return winner;
    }
    throw error;
  }
}

/** Cliente Prisma injetável exigido só pelas ESCRITAS de posição (`reassignPositions`). */
type MnemonicFrameWriteClient = Pick<typeof prisma, 'mnemonicFrame'>;

/**
 * Grava, em sequência, a posição de cada Quadro listado — sempre escopado por
 * `stripId` (defesa em profundidade contra substituição de id — mesma cautela
 * de A01 já aplicada por `assertRawContentReachable`/COMP-012-005, mesmo que o
 * chamador já tenha validado o conjunto de ids antes de chegar aqui).
 *
 * Confere o `count` devolvido por cada `updateMany`: se o `frameId` deixar de
 * casar o WHERE (`id` + `stripId`) entre a leitura do conjunto e esta escrita
 * — corrida concorrente, ex.: remoção do Quadro no meio do caminho —, o
 * `updateMany` do Prisma não lança, só devolve `count: 0`, o que persistiria
 * posições lacunosas em silêncio. Lançar aqui propaga para dentro da
 * `$transaction` do chamador e reverte a operação inteira (fail-secure),
 * nunca um commit parcial.
 */
async function applyPositions(
  tx: MnemonicFrameWriteClient,
  stripId: string,
  assignments: ReadonlyArray<{ frameId: string; position: number }>,
): Promise<void> {
  for (const { frameId, position } of assignments) {
    const result = await tx.mnemonicFrame.updateMany({
      where: { id: frameId, stripId },
      data: { position },
    });
    if (result.count !== 1) {
      throw new Error(
        `reindexação falhou: Quadro ${frameId} não casou stripId ${stripId} (count=${result.count}).`,
      );
    }
  }
}

/**
 * Reindexação atômica em 2 fases (DEC-012-003) —
 * primitiva reusada por `reorderMnemonicFrames` (F-5) e, fora desta TASK, por
 * `addMnemonicFrame`/`removeMnemonicFrame` (TASK-012-007, F-2/F-4). Nunca abre
 * transação própria — o `tx` já vem aberto pelo chamador (mesmo padrão de
 * `recordProductionStageEvent`, DEC-010-003).
 *
 * **Fase 1 (offset)**: desloca a posição atual de TODOS os ids de
 * `orderedFrameIds` para um intervalo temporário fora de 1..N (negativo) —
 * inclusive os que já estão na posição final correta. Pular um id "porque já
 * está certo" é exatamente o bug que RISK-011-003 nomeia: se esse id não for
 * deslocado, a Fase 2 pode tentar gravar em outro Quadro (ainda não deslocado)
 * a MESMA posição que esse id já ocupa, colidindo com
 * `@@unique([stripId, position])` a meio caminho.
 *
 * **Fase 2 (final)**: grava, para cada id de `orderedFrameIds` NA ORDEM DADA,
 * `position = índice + 1` — sem lacuna, sem duplicidade, mesmo quando a
 * operação troca a posição relativa de 2 ou mais Quadros (AC-011-010).
 *
 * Lista vazia é no-op (F-4, remover o último Quadro restante).
 */
export async function reassignPositions(
  tx: MnemonicFrameWriteClient,
  stripId: string,
  orderedFrameIds: readonly string[],
): Promise<void> {
  await applyPositions(
    tx,
    stripId,
    orderedFrameIds.map((frameId, index) => ({ frameId, position: -(index + 1) })),
  );

  await applyPositions(
    tx,
    stripId,
    orderedFrameIds.map((frameId, index) => ({ frameId, position: index + 1 })),
  );
}

/**
 * `true` só quando `order` é EXATAMENTE o conjunto de ids de `existingIds` —
 * mesmo tamanho, sem id duplicado, todo id pertencente ao conjunto existente.
 * As 3 condições separadas cobrem 3 mutantes distintos: array maior/menor
 * (tamanho), id repetido substituindo um id ausente (duplicidade sob mesmo
 * tamanho) e id de outra Tira (pertencimento).
 */
function isExactFrameSet(order: readonly string[], existingIds: ReadonlySet<string>): boolean {
  return (
    order.length === existingIds.size &&
    new Set(order).size === order.length &&
    order.every((id) => existingIds.has(id))
  );
}

/**
 * Reordena os Quadros da Tira (FR-011-006), dentro de `$transaction`:
 * 1. `assertRawContentReachable` — 1ª chamada, sempre (NFR-011-001/006,
 *    DEC-012-007).
 * 2. Localiza o `stripId` a partir do `rawContentId` (`ruleBreakdown` →
 *    `mnemonicStrip`) — 409 (`ConflictError`) se a Quebra da regra ou a
 *    própria Tira ainda não existem (pré-condições de domínio, mesma família
 *    de recusa de `openMnemonicStrip`).
 * 3. Valida que `input.order` é EXATAMENTE o conjunto de ids de Quadro
 *    existentes da Tira (nem falta, nem sobra, nem duplicidade) — 409 caso
 *    contrário; nenhuma escrita acontece antes desta validação (defesa contra
 *    vazamento de escrita cross-tenant, A01).
 * 4. `reassignPositions` — reindexação atômica em 2 fases (DEC-012-003); a
 *    prova de atomicidade REAL contra falha no meio do caminho é
 *    `tira.service.integration.test.ts`, AC-011-011/RISK-011-003.
 * 5. `recordProductionStageEvent` — decide CONCLUSAO (1ª mutação humana) ou
 *    RETRABALHO (demais), puramente pelo histórico já registrado
 *    (DEC-012-006); este código não precisa saber qual é qual.
 * 6. Devolve `MnemonicStripDetail` com os Quadros ordenados por `position`.
 *
 * Fail-secure (NFR-011-003, AC-011-015): toda a validação, a reindexação e a
 * emissão do evento rodam na MESMA `$transaction` interativa — falha em
 * qualquer passo reverte a operação inteira, nenhuma posição parcial
 * persiste.
 */
export async function reorderMnemonicFrames(
  rawContentId: string,
  input: ReorderMnemonicFramesInput,
  actor: ContentActor,
  db: MnemonicStripClient = prisma,
): Promise<MnemonicStripDetail> {
  return db.$transaction(async (tx) => {
    await assertRawContentReachable(rawContentId, actor, tx);

    const breakdown = await tx.ruleBreakdown.findUnique({
      where: { rawContentId },
      select: { id: true },
    });
    if (breakdown === null) {
      throw new ConflictError('Conclua a Quebra da regra antes de abrir a Tira mnemônica.');
    }

    const strip = await tx.mnemonicStrip.findUnique({
      where: { ruleBreakdownId: breakdown.id },
      select: { id: true },
    });
    if (strip === null) {
      throw new ConflictError('Abra a Tira mnemônica antes de reordenar os quadros.');
    }

    const existingFrames = await tx.mnemonicFrame.findMany({
      where: { stripId: strip.id },
      select: { id: true },
    });
    const existingIds = new Set(existingFrames.map((frame) => frame.id));

    if (!isExactFrameSet(input.order, existingIds)) {
      throw new ConflictError(
        'A lista de quadros informada não corresponde aos quadros existentes na Tira.',
      );
    }

    await reassignPositions(tx, strip.id, input.order);

    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'TIRA_MNEMONICA',
      actorId: actor.id,
      now: new Date(),
    });

    return tx.mnemonicStrip.findUniqueOrThrow({
      where: { id: strip.id },
      relationLoadStrategy: 'join',
      select: MNEMONIC_STRIP_DETAIL_SELECT,
    });
  });
}
