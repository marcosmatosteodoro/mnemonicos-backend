import { PDFDocument } from 'pdf-lib';

import { env } from '../../config/env';
import type { Prisma } from '../../generated/prisma/client';
import { GenerationTimeoutError, NothingToExportError, NotFoundError } from '../../http/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import type { PublicationVariant } from '../../domain/types';
import { resolveAlterationSignal } from '../content-versions/content-versions.service';
import {
  toVersionedContentFields,
  type VersionedContentFields,
} from '../content-versions/versioned-content-diff';
import { ACTIVE_RAW_CONTENT_WHERE, type ContentActor } from '../contents/contents.service';
import { recordProductionStageEvent } from '../production-events/production-events.service';
import { openMnemonicStrip, type MnemonicFrameDetail } from '../tira/tira.service';
import { detectImageSignature } from '../visual-associations/image-signature';
import { getVisualAssociationBinary } from '../visual-associations/visual-associations.service';
import {
  buildStripPdf,
  buildSummaryPdf,
  buildSupplementaryPagesPdf,
  type ImageSkippedInfo,
  type PublicationPdfMeta,
  type StripFrameForPdf,
  type SupplementarySections,
  type VersionStampForPdf,
} from './pdf-composer';
import { getReviewProtocolMarks } from './review-protocol';

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
 * `publicationEvent` (DEC-025-005). Inclui `'contrast' | 'productionFlashcard'`
 * (COMP-027-018, PLAN-027 §3): leitura suplementar da Exportação (F7). Inclui
 * `'contentVersion'` (COMP-029-007, TASK-029-003): leitura da Versão editorial mais
 * recente para o carimbo do PDF — nunca escrita, esse módulo só lê.
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
  | 'contrast'
  | 'productionFlashcard'
  | 'contentVersion'
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
 *
 * `select` inclui `pegadinhaText` (COMP-027-018, PLAN-027 §3): mesmo round-trip da guarda,
 * sem I/O adicional — devolvido ao chamador para compor `SupplementarySections` sem uma
 * 2ª leitura de `RawContent`. Ganha os 5 campos versionados de `RawContent`
 * (`rawText`/`radarClass`/`sourceType`/`sourceCitation`/`sourceUrl`, TASK-029-003): mesmo
 * round-trip, sem I/O adicional — devolvidos para `resolveVersionStampForPdf` montar o
 * lado ATUAL da comparação (A-028-002/DEC-029-003), sem uma 3ª leitura de `RawContent`.
 */
async function assertRawContentExportable(
  rawContentId: string,
  db: Pick<PublicationClient, 'rawContent'>,
): Promise<{
  pegadinhaText: string | null;
  rawText: string;
  radarClass: VersionedContentFields['radarClass'];
  sourceType: VersionedContentFields['sourceType'];
  sourceCitation: string | null;
  sourceUrl: string | null;
}> {
  const row = await db.rawContent.findFirst({
    where: { id: rawContentId, ...ACTIVE_RAW_CONTENT_WHERE },
    select: {
      id: true,
      pegadinhaText: true,
      rawText: true,
      radarClass: true,
      sourceType: true,
      sourceCitation: true,
      sourceUrl: true,
    },
  });
  if (row === null) {
    throw new NotFoundError('Conteúdo bruto não encontrado.');
  }
  return {
    pegadinhaText: row.pegadinhaText,
    rawText: row.rawText,
    radarClass: row.radarClass,
    sourceType: row.sourceType,
    sourceCitation: row.sourceCitation,
    sourceUrl: row.sourceUrl,
  };
}

/**
 * Passo 2b: a Versão editorial MAIS RECENTE já fechada (`orderBy: { number: 'desc' }`,
 * DEC-029-006 — histórico de datas não implica ordem cronológica, então a busca é por
 * `number`, nunca por `closedAt`/`legislativeClosureDate`) — `null` = nenhuma Versão
 * fechada ainda (FR-028-009). Quando existe, `resolveAlterationSignal` compara o estado
 * ATUAL (`current`, já lido nos Passos 1/2 sem 3ª consulta) contra o `contentSnapshot`/
 * `closedAt` da Versão, combinando o sinal de CONTEÚDO com o da Tira mnemônica.
 */
async function resolveVersionStampForPdf(
  rawContentId: string,
  current: VersionedContentFields,
  db: Pick<PublicationClient, 'contentVersion' | 'productionStageEvent'>,
): Promise<VersionStampForPdf | null> {
  const latest = await db.contentVersion.findFirst({
    where: { rawContentId },
    orderBy: { number: 'desc' },
    select: {
      number: true,
      legislativeClosureDate: true,
      contentSnapshot: true,
      closedAt: true,
      approvedById: true,
    },
  });
  if (latest === null) return null;

  const alteredAfterClosure = await resolveAlterationSignal(rawContentId, current, latest, db);

  return {
    number: latest.number,
    legislativeClosureDate: latest.legislativeClosureDate,
    alteredAfterClosure,
    approvedAndValid: latest.approvedById !== null && !alteredAfterClosure,
  };
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
 * Passos 3/4 — composição do PDF PRINCIPAL, escopada à Variante. `RESUMO` compõe direto
 * sobre a Quebra lida no Passo 2 (nenhuma leitura adicional); `TIRA` resolve os Quadros
 * (`resolveOrderedFramesForStrip` acima) e embute a imagem de cada um vinculado a uma
 * Associação visual, chamando `buildStripPdf` com o callback `onImageSkipped` que loga
 * (nunca lança) o descarte de uma imagem recusada por `buildStripPdf`/`embedFrameImage`
 * (TASK-025-007) — SÓ metadado (índice, formato, motivo enum), nunca `buffer`/bytes da
 * imagem nem texto do Quadro. Chamada por `composePublicationBuffer` (COMP-027-018), que
 * soma a esta a composição suplementar antes de devolver o documento final.
 */
async function composeVariantBuffer(
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
 * Leitura suplementar (COMP-027-018, PLAN-027 §3/§4 Fluxo 5): Contrastes e
 * `ProductionFlashcard`s do `rawContentId`, ordenados por `createdAt asc` (AC-026-012,
 * mesma ordem de `listContrasts`/`listFlashcards`) — `Promise.all` (NFR-026-003, 2
 * `findMany` locais a mais, sem `scopeWhere`: a guarda comum já foi resolvida pelo Passo 1
 * de `exportPublication`, DEC-025-007, não redecidida aqui). `pegadinhaText` chega pronto
 * (já lido no Passo 1, não uma 2ª consulta) e o Protocolo é sempre gerado
 * (`getReviewProtocolMarks`, COMP-027-016 — FR-026-021, não depende de nenhum registro).
 */
async function loadSupplementarySections(
  rawContentId: string,
  pegadinhaText: string | null,
  db: PublicationClient,
): Promise<SupplementarySections> {
  const [contrasts, flashcards] = await Promise.all([
    db.contrast.findMany({
      where: { rawContentId },
      orderBy: { createdAt: 'asc' },
      select: { confusableText: true, distinctionText: true },
    }),
    db.productionFlashcard.findMany({
      where: { rawContentId },
      orderBy: { createdAt: 'asc' },
      select: { question: true, answer: true },
    }),
  ]);

  return {
    contrasts,
    pegadinhaText,
    flashcards,
    protocol: getReviewProtocolMarks(),
  };
}

/**
 * Funde as páginas do PDF suplementar ao final do PDF principal (DEC-027-006):
 * `PDFDocument.load` dos 2 `Buffer`s já prontos, `copyPages` de TODAS as páginas do
 * suplementar para o principal, `.save()` de novo — 1 único documento final, em AMBAS as
 * Variantes.
 */
async function mergeSupplementaryPages(
  primaryBuffer: Buffer,
  supplementaryBuffer: Buffer,
): Promise<Buffer> {
  const primaryDoc = await PDFDocument.load(primaryBuffer);
  const supplementaryDoc = await PDFDocument.load(supplementaryBuffer);

  const copiedPages = await primaryDoc.copyPages(
    supplementaryDoc,
    supplementaryDoc.getPageIndices(),
  );
  for (const page of copiedPages) {
    primaryDoc.addPage(page);
  }

  const bytes = await primaryDoc.save();
  return Buffer.from(bytes);
}

/**
 * Orquestração da composição completa (COMP-027-018, DEC-027-006): o PDF principal
 * (`composeVariantBuffer`) e a leitura suplementar (`loadSupplementarySections`) rodam em
 * `Promise.all` — a leitura de Contraste/Flashcard não soma latência sequencial ao que já
 * é composto (NFR-026-003). A composição suplementar em si (`buildSupplementaryPagesPdf`)
 * só pode rodar DEPOIS da leitura (precisa do resultado) e a fusão
 * (`mergeSupplementaryPages`) só depois dos 2 `Buffer`s prontos — nessa ordem, para AMBAS
 * as Variantes (A-026-007).
 */
async function composePublicationBuffer(
  rawContentId: string,
  variant: PublicationVariant,
  actor: ContentActor,
  breakdown: RuleBreakdownForPublication,
  pegadinhaText: string | null,
  meta: PublicationPdfMeta,
  db: PublicationClient,
): Promise<Buffer> {
  const [primaryBuffer, sections] = await Promise.all([
    composeVariantBuffer(rawContentId, variant, actor, breakdown, meta, db),
    loadSupplementarySections(rawContentId, pegadinhaText, db),
  ]);

  const supplementaryBuffer = await buildSupplementaryPagesPdf(sections, meta);

  return mergeSupplementaryPages(primaryBuffer, supplementaryBuffer);
}

/**
 * `exportPublication` (COMP-025-005) — ordem exata:
 * 1. `assertRawContentExportable` — guarda nova de alcance (DEC-025-007).
 * 2. Leitura de BAIXO NÍVEL da Quebra da regra, direto no `db` — `NotFoundError` se ainda
 *    não foi salva (FR-024-002/AC-024-001), sem herdar a guarda de autoria de
 *    `getRuleBreakdown`.
 * 2b. `resolveVersionStampForPdf` (COMP-029-007, TASK-029-003) — reusa os campos já lidos
 *    nos passos 1/2 (nenhuma consulta nova de `RawContent`/`RuleBreakdown`), resolve a
 *    Versão vigente (ou `null`, FR-028-009) para o carimbo do PDF.
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
  const rawContent = await assertRawContentExportable(rawContentId, db);

  const breakdown = await db.ruleBreakdown.findUnique({
    where: { rawContentId },
    select: RULE_BREAKDOWN_FOR_PUBLICATION_SELECT,
  });
  if (breakdown === null) {
    throw new NotFoundError('Quebra da regra não encontrada.');
  }

  const version = await resolveVersionStampForPdf(
    rawContentId,
    toVersionedContentFields(rawContent, breakdown),
    db,
  );

  const meta: PublicationPdfMeta = { variant: input.variant, generatedAt: new Date(), version };

  const buffer = await withDeadline(
    composePublicationBuffer(
      rawContentId,
      input.variant,
      actor,
      breakdown,
      rawContent.pegadinhaText,
      meta,
      db,
    ),
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
