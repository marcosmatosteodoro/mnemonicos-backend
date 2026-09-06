import { Prisma } from '../../generated/prisma/client';
import { ConflictError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import {
  assertRawContentReachable,
  type ContentActor,
  type RuleBreakdownDetail,
} from '../contents/contents.service';
import { recordProductionStageEvent } from '../production-events/production-events.service';

/**
 * Núcleo do módulo Tira mnemônica (COMP-012-004 / TASK-012-005): geração
 * inicial (regra pura, `buildInitialFrames`) e abertura get-or-generate
 * idempotente (`openMnemonicStrip`). CRUD/reordenação de Quadro ficam fora
 * desta TASK (TASK-012-007 a TASK-012-010, fora desta lista).
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
 * `rawContentId`), `mnemonicStrip` (a própria Tira) e `$transaction`.
 */
type MnemonicStripClient = Pick<
  typeof prisma,
  'rawContent' | 'ruleBreakdown' | 'mnemonicStrip' | '$transaction'
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
