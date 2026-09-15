import { env } from '../../config/env';
import type { Prisma } from '../../generated/prisma/client';
import { GenerationTimeoutError, NothingToExportError, NotFoundError } from '../../http/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import type { PublicationVariant } from '../../domain/types';
import { ACTIVE_RAW_CONTENT_WHERE, type ContentActor } from '../contents/contents.service';
import { recordProductionStageEvent } from '../production-events/production-events.service';
import { openMnemonicStrip, type MnemonicFrameDetail } from '../tira/tira.service';
import { detectImageSignature } from '../visual-associations/image-signature';
import { getVisualAssociationBinary } from '../visual-associations/visual-associations.service';
import {
  buildStripPdf,
  buildSummaryPdf,
  type ImageSkippedInfo,
  type PublicationPdfMeta,
  type StripFrameForPdf,
} from './pdf-composer';

/**
 * Orquestração da exportação (COMP-025-005, PLAN-025 §3): função central que combina a
 * guarda nova de alcance (DEC-025-007), a leitura de baixo nível da Quebra/Tira, a
 * composição do PDF (`pdf-composer.ts`, TASK-025-007) sob teto de duração (DEC-025-002) e
 * a gravação transacional do evento genérico + log dedicado por Variante (DEC-025-005), só
 * depois do `Buffer` do PDF já estar pronto em memória (fail-secure).
 */

export interface ExportPublicationInput {
  variant: PublicationVariant;
}

export interface PublicationResult {
  buffer: Buffer;
  filename: string;
}

/**
 * Cliente Prisma injetável (PLAN-025 §3): superconjunto do cliente privado de
 * `tira.service.ts` (precisa cobrir tudo que `openMnemonicStrip` exige), mais
 * `publicationEvent` (DEC-025-005).
 */
type PublicationClient = Pick<
  typeof prisma,
  | 'rawContent'
  | 'ruleBreakdown'
  | 'mnemonicStrip'
  | 'mnemonicFrame'
  | 'visualAssociation'
  | 'visualAssociationLinkEvent'
  | 'productionStageEvent'
  | 'publicationEvent'
  | '$transaction'
>;

const RULE_BREAKDOWN_FOR_PUBLICATION_SELECT = {
  id: true,
  concept: true,
  action: true,
  object: true,
  condition: true,
  exception: true,
  essence: true,
} as const satisfies Prisma.RuleBreakdownSelect;

type RuleBreakdownForPublication = Prisma.RuleBreakdownGetPayload<{
  select: typeof RULE_BREAKDOWN_FOR_PUBLICATION_SELECT;
}>;

/**
 * Passo 1 (DEC-025-007): guarda NOVA, comum a todo EDITOR/ADMIN — existe + não
 * soft-deleted (`ACTIVE_RAW_CONTENT_WHERE`, reusado de `contents.service.ts`), **sem**
 * `scopeWhere`/checagem de autoria (é a diferença deliberada de
 * `assertRawContentReachable`). Mesma mensagem de `assertRawContentReachable` para não
 * abrir um oráculo de distinção entre os dois mecanismos. Um único `findFirst` já resolve
 * "não existe" e "soft-deleted" como o MESMO caso (nenhuma checagem de autoria caberia
 * entre os dois, então a precedência de guarda de AC-024-019 é garantida por construção).
 */
async function assertRawContentExportable(
  rawContentId: string,
  db: Pick<PublicationClient, 'rawContent'>,
): Promise<void> {
  const row = await db.rawContent.findFirst({
    where: { id: rawContentId, ...ACTIVE_RAW_CONTENT_WHERE },
    select: { id: true },
  });
  if (row === null) {
    throw new NotFoundError('Conteúdo bruto não encontrado.');
  }
}

/**
 * Passo 5 (DEC-025-002): teto de duração interno, com folga, abaixo do teto duro da
 * function serverless — `Promise.race` entre a composição do PDF e um temporizador. O
 * temporizador vencendo lança `GenerationTimeoutError` com a mensagem DEFAULT genérica
 * (nunca a mensagem crua de uma exceção do motor de composição — só o CANAL de falha é
 * compartilhado, não o texto).
 */
async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GenerationTimeoutError()), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Passo 4: mapeia 1 `MnemonicFrameDetail` para `StripFrameForPdf` — `visualAssociationId
 * === null` (sem vínculo) OU `getVisualAssociationBinary` devolvendo `null` (associação
 * removida entre a leitura da Tira e esta chamada) OU formato detectado `'WEBP'`/`null`
 * (não detectado) caem TODOS no mesmo caminho "só texto" (`image: null`) — é AQUI, neste
 * arquivo, que o mapeamento `WEBP`/indetectável → `null` acontece (`pdf-composer.ts` só
 * recebe `'PNG'|'JPEG'` ou `null`, nunca `'WEBP'`).
 */
async function buildFrameForPdf(
  frame: Pick<MnemonicFrameDetail, 'text' | 'visualAssociationId'>,
  db: Pick<PublicationClient, 'visualAssociation'>,
): Promise<StripFrameForPdf> {
  if (frame.visualAssociationId === null) {
    return { text: frame.text, image: null };
  }

  const binary = await getVisualAssociationBinary(frame.visualAssociationId, db);
  if (binary === null) {
    return { text: frame.text, image: null };
  }

  const format = detectImageSignature(binary.imageData);
  if (format !== 'PNG' && format !== 'JPEG') {
    return { text: frame.text, image: null };
  }

  return { text: frame.text, image: { buffer: binary.imageData, format } };
}

/**
 * Passo 4 (Variante `TIRA`) — resolve os Quadros a compor, respeitando a MESMA
 * distinção de DEC-025-007 entre LEITURA de material já existente (comum a todo
 * EDITOR/ADMIN) e AUTO-GERAÇÃO (delegada a `openMnemonicStrip`, com a guarda de autoria
 * ORIGINAL dele, intocada): a Tira já aberta é lida por uma consulta de baixo nível
 * própria deste arquivo (`mnemonicStrip.findUnique` a partir do `ruleBreakdownId` já
 * confirmado no Passo 2), SEM passar pela guarda de autoria de `openMnemonicStrip`
 * (`assertRawContentReachable`, sempre a 1ª checagem dela, incondicional) — satisfaz
 * AC-024-018 (EDITOR B exporta "tira" já aberta de EDITOR A). Só quando a Tira AINDA não
 * existe (`null`) é que a auto-geração é delegada a `openMnemonicStrip` (get-or-generate
 * idempotente reusado sem duplicar lógica, `suppressOpeningEvent: true`) — aí sim sujeita
 * à guarda de autoria dele, intencionalmente (DEC-025-007, PLAN §6: auto-geração por
 * não-autor recusa, caso não testado como sucesso por nenhum AC desta TASK).
 */
async function resolveOrderedFramesForStrip(
  rawContentId: string,
  ruleBreakdownId: string,
  actor: ContentActor,
  db: PublicationClient,
): Promise<Array<Pick<MnemonicFrameDetail, 'text' | 'visualAssociationId'>>> {
  // Relação de LISTA (`frames`) — `relationLoadStrategy: 'join'` fixado explicitamente
  // (perfil node-22.md §10; mesma relação de `tira.service.ts:MNEMONIC_STRIP_DETAIL_SELECT`).
  // Medido contra o Postgres real: 1 round-trip com `join` (LATERAL JOIN +
  // JSONB_AGG) contra 2 com `query` (1 SELECT em `mnemonic_strips` + 1 em `mnemonic_frames`).
  const existingStrip = await db.mnemonicStrip.findUnique({
    where: { ruleBreakdownId },
    relationLoadStrategy: 'join',
    select: {
      frames: {
        orderBy: { position: 'asc' },
        select: { text: true, visualAssociationId: true },
      },
    },
  });
  if (existingStrip !== null) {
    return existingStrip.frames;
  }

  const generated = await openMnemonicStrip(rawContentId, actor, db, {
    suppressOpeningEvent: true,
  });
  return generated.frames;
}

/**
 * Passos 3/4 — composição em si, escopada à Variante. `RESUMO` compõe direto sobre a
 * Quebra lida no Passo 2 (nenhuma leitura adicional); `TIRA` resolve os Quadros
 * (`resolveOrderedFramesForStrip` acima) e embute a imagem de cada um vinculado a uma
 * Associação visual, chamando `buildStripPdf` com o callback `onImageSkipped` que loga
 * (nunca lança) o descarte de uma imagem recusada por `buildStripPdf`/`embedFrameImage`
 * (TASK-025-007) — SÓ metadado (índice, formato, motivo enum), nunca `buffer`/bytes da
 * imagem nem texto do Quadro.
 */
async function composePublicationBuffer(
  rawContentId: string,
  variant: PublicationVariant,
  actor: ContentActor,
  breakdown: RuleBreakdownForPublication,
  meta: PublicationPdfMeta,
  db: PublicationClient,
): Promise<Buffer> {
  if (variant === 'RESUMO') {
    return buildSummaryPdf(breakdown, meta);
  }

  const orderedFrames = await resolveOrderedFramesForStrip(rawContentId, breakdown.id, actor, db);
  // Variante TIRA depende dos Quadros: lista vazia (Tira sem Quadros) não tem conteúdo
  // real para compor — recusa antes de chamar `buildStripPdf` (que aceitaria `[]` sem
  // erro e produziria um PDF sem página de conteúdo). `RESUMO` nunca passa por aqui: usa
  // a Quebra direto (`concept`/`action`/`object` obrigatórios no schema garantem que ela
  // nunca fica vazia).
  if (orderedFrames.length === 0) {
    throw new NothingToExportError();
  }
  const frames = await Promise.all(orderedFrames.map((frame) => buildFrameForPdf(frame, db)));

  return buildStripPdf(frames, meta, (info: ImageSkippedInfo) => {
    logger.warn(
      {
        rawContentId,
        frameIndex: info.frameIndex,
        format: info.format,
        reason: info.reason,
      },
      'Imagem de Quadro descartada da exportação',
    );
  });
}

/**
 * `exportPublication` (COMP-025-005) — ordem exata:
 * 1. `assertRawContentExportable` — guarda nova de alcance (DEC-025-007).
 * 2. Leitura de BAIXO NÍVEL da Quebra da regra, direto no `db` — `NotFoundError` se ainda
 *    não foi salva (FR-024-002/AC-024-001), sem herdar a guarda de autoria de
 *    `getRuleBreakdown`.
 * 3/4. Composição do PDF por Variante (`composePublicationBuffer`), sob o teto de duração
 *    interno (`withDeadline`, DEC-025-002/FR-024-015).
 * 6. Sucesso: MESMA `$transaction` grava o evento de etapa genérico
 *    (`recordProductionStageEvent`) E o log dedicado por Variante
 *    (`publicationEvent.create`, DEC-025-005) — só DEPOIS do `Buffer` já pronto em
 *    memória (fail-secure, nunca antes).
 * 7. Nome do arquivo (FR-024-008/A-024-007): só caracteres ASCII seguros (uuid +
 *    literal), sem input do usuário.
 *
 * Fail-secure: qualquer exceção nos passos 1-5 propaga sem gravar nada — o passo 6 só
 * roda depois de (5) resolver com sucesso.
 */
export async function exportPublication(
  rawContentId: string,
  input: ExportPublicationInput,
  actor: ContentActor,
  db: PublicationClient = prisma,
): Promise<PublicationResult> {
  await assertRawContentExportable(rawContentId, db);

  const breakdown = await db.ruleBreakdown.findUnique({
    where: { rawContentId },
    select: RULE_BREAKDOWN_FOR_PUBLICATION_SELECT,
  });
  if (breakdown === null) {
    throw new NotFoundError('Quebra da regra não encontrada.');
  }

  const meta: PublicationPdfMeta = { variant: input.variant, generatedAt: new Date() };

  const buffer = await withDeadline(
    composePublicationBuffer(rawContentId, input.variant, actor, breakdown, meta, db),
    env.PUBLICATION_PDF_TIMEOUT_MS,
  );

  await db.$transaction(async (tx) => {
    const now = new Date();
    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'PUBLICACAO_PDF',
      actorId: actor.id,
      now,
    });
    await tx.publicationEvent.create({
      data: { rawContentId, variant: input.variant, occurredAt: now },
    });
  });

  const filename = `${rawContentId}-${input.variant.toLowerCase()}-rascunho.pdf`;
  return { buffer, filename };
}
