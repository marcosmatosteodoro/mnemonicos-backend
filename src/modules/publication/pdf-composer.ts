import { PageSizes, PDFDocument, StandardFonts } from 'pdf-lib';
import type { PDFFont, PDFImage, PDFPage } from 'pdf-lib';

import type { RuleBreakdownDetail } from '../contents/contents.service';
import { CANONICAL_RULE_BREAKDOWN_ORDER } from '../tira/tira.service';
import {
  exceedsPixelBudget,
  hasAnimatedPngChunk,
  readImageDimensions,
} from '../visual-associations/image-signature';
import type { PublicationVariant } from '../../domain/types';
import { wrapTextToLines } from './pdf-layout';
import type { ReviewProtocolMark } from './review-protocol';

/**
 * Motor de composição do PDF (COMP-025-003, DEC-025-001 — `pdf-lib`): desenha texto e
 * imagem por coordenada explícita, sem template/HTML e sem I/O de rede — as duas
 * superfícies que NFR-024-001/002 pedem para mitigar somem por construção (a biblioteca
 * não abre socket, e não existe camada de interpolação entre o dado e a página:
 * `page.drawText(...)` sempre recebe a string do usuário literal).
 */

export interface PublicationPdfMeta {
  variant: PublicationVariant;
  generatedAt: Date;
  /** Carimbo de Versão editorial vigente (COMP-029-007/008, TASK-029-003) — `null` =
   * nenhuma Versão fechada para este `RawContent` ainda (FR-028-009). */
  version: VersionStampForPdf | null;
}

/** Carimbo de Versão vigente a desenhar no cabeçalho (FR-028-008/009/011, FR-030-010/011):
 * a Versão de MAIOR `number` já fechada, se o Conteúdo/Quebra ou a Tira mnemônica foram
 * alterados depois desse fechamento (`alteredAfterClosure`), e se ela está aprovada e sem
 * esse sinal aceso (`approvedAndValid` — controla se `resolveHeaderLabel` desenha a marca
 * de aprovação ou `DRAFT_LABEL`). */
export interface VersionStampForPdf {
  number: number;
  legislativeClosureDate: Date;
  alteredAfterClosure: boolean;
  approvedAndValid: boolean;
}

export interface StripFrameForPdf {
  text: string;
  /** `null` = sem Associação visual vinculada, formato não suportado (ex.: WEBP) OU
   * falha de decodificação — os 3 casos renderizam só o texto (decisão de
   * `publication.service.ts`, TASK-025-008, para os 2 primeiros; o 3º é tratado aqui). */
  image: { buffer: Buffer; format: 'PNG' | 'JPEG' } | null;
}

/** Motivo pelo qual um Quadro perdeu a imagem e caiu no caminho "só texto" — reportado por
 * `onImageSkipped` (`buildStripPdf`), nunca logado aqui dentro (o módulo continua sem I/O;
 * quem loga é o chamador, COMP-025-005/TASK-025-008). */
export type ImageSkipReason = 'decode-failed' | 'pixel-budget-exceeded' | 'apng-not-supported';

export interface ImageSkippedInfo {
  frameIndex: number;
  format: 'PNG' | 'JPEG';
  reason: ImageSkipReason;
}

/** 1 Contraste (Confundível + distinção) a compor nas páginas suplementares (COMP-027-017). */
export interface ContrastForPdf {
  confusableText: string;
  distinctionText: string;
}

/** 1 Flashcard (pergunta/resposta) a compor nas páginas suplementares (COMP-027-017). */
export interface FlashcardForPdf {
  question: string;
  answer: string;
}

/**
 * Composição suplementar (COMP-027-017, DEC-027-006) — Contraste(s) + Pegadinha +
 * Flashcard(s) + Protocolo impresso, fundida ao PDF principal via `PDFDocument.copyPages`
 * em `publication.service.ts`. Cada campo com 0 itens (`length === 0` ou
 * `pegadinhaText === null`) omite a seção correspondente (FR-026-028/023) — o Protocolo é o
 * único sempre presente (FR-026-021).
 */
export interface SupplementarySections {
  contrasts: ContrastForPdf[];
  pegadinhaText: string | null;
  flashcards: FlashcardForPdf[];
  protocol: ReviewProtocolMark[];
}

const [PAGE_WIDTH, PAGE_HEIGHT] = PageSizes.A4;

const MARGIN_X = 50;
const MARGIN_TOP = 100; // reserva o cabeçalho de rascunho (4 linhas, TASK-029-003) fora da área de conteúdo
const MARGIN_BOTTOM = 50;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;
const CONTENT_TOP_Y = PAGE_HEIGHT - MARGIN_TOP;
const CONTENT_BOTTOM_Y = MARGIN_BOTTOM;

const BODY_FONT_SIZE = 12;
const LINE_HEIGHT = 16;
const PARAGRAPH_GAP = LINE_HEIGHT;

const LABEL_FONT_SIZE = 9;
const LABEL_LINE_Y = PAGE_HEIGHT - 30;
const VARIANT_LINE_Y = PAGE_HEIGHT - 45;
const GENERATED_AT_LINE_Y = PAGE_HEIGHT - 60;
/** 4ª linha do cabeçalho (TASK-029-003) — mesmo espaçamento de 15pt das 3 anteriores. */
const VERSION_LINE_Y = PAGE_HEIGHT - 75;

/** Nunca "fechamento"/"aprovação" (AC-024-005) — é rótulo de RASCUNHO/geração, não de
 * decisão editorial sobre o conteúdo. */
const DRAFT_LABEL = 'RASCUNHO — documento gerado automaticamente, sujeito a revisão.';

const IMAGE_MAX_WIDTH = 300;
const IMAGE_MAX_HEIGHT = 300;

function formatGeneratedAt(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

/**
 * Formata `DD/MM/AAAA` a partir dos componentes UTC do `Date` (TASK-029-003) — NUNCA
 * `Intl.DateTimeFormat` sem `timeZone: 'UTC'` explícito nem os getters locais
 * (`getDate`/`getMonth`): `legislativeClosureDate` é construído a partir de uma string ISO
 * `YYYY-MM-DD` sem componente de hora (meia-noite UTC, TASK-029-002) — formatar pelo fuso
 * LOCAL do servidor pode exibir o dia ANTERIOR (ex.: servidor em `America/Sao_Paulo`,
 * UTC-3: meia-noite UTC de 01/09 vira 21h de 31/08 local).
 */
export function formatLegislativeClosureDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

/** Texto da 4ª linha do cabeçalho (FR-028-008/009/011) — o carimbo de Versão vigente, a
 * marca de ausência, ou a marca de alteração posterior, sempre ao lado do rótulo
 * "Rascunho" já existente, sem alterá-lo (FR-028-010). */
function versionStampText(version: VersionStampForPdf | null): string {
  if (version === null) return 'Sem versão fechada.';

  const base = `Versão ${version.number} — verificado até ${formatLegislativeClosureDate(version.legislativeClosureDate)}`;
  if (!version.alteredAfterClosure) return base;

  return `${base} — alterado após o fechamento da Versão ${version.number}`;
}

/** 1ª linha do cabeçalho (FR-030-010/011): a marca de alcance explícito quando a Versão
 * vigente está aprovada e sem sinal de alteração aceso; em qualquer outro caso —
 * `version === null`, nunca aprovada, ou sinal de alteração aceso —, `DRAFT_LABEL`
 * inalterado. */
export function resolveHeaderLabel(version: VersionStampForPdf | null): string {
  if (version?.approvedAndValid === true) {
    return `Conteúdo normativo e Tira mnemônica — Versão ${version.number} aprovada`;
  }
  return DRAFT_LABEL;
}

/**
 * Rótulo do cabeçalho (rascunho ou aprovação, `resolveHeaderLabel`) + Variante
 * (`meta.variant`, lida do valor — nunca hardcoded, AC-024-005 exige que o rótulo diga
 * TAMBÉM qual Variante a página representa) + `meta.generatedAt` (FR-024-001/AC-024-005) +
 * carimbo de Versão (`meta.version`, FR-028-008/009/011) — chamada uma vez por página
 * recém-criada, nunca só na 1ª (tanto no laço de `buildStripPdf` quanto na(s) página(s) de
 * `buildSummaryPdf`); as 3 linhas seguintes são desenhadas SEMPRE, sem mudança de posição
 * (mesmo padrão já existente — nunca condicionalmente omitidas).
 */
function drawDraftHeader(page: PDFPage, font: PDFFont, meta: PublicationPdfMeta): void {
  page.drawText(resolveHeaderLabel(meta.version), {
    x: MARGIN_X,
    y: LABEL_LINE_Y,
    size: LABEL_FONT_SIZE,
    font,
  });
  page.drawText(`Variante: ${meta.variant}`, {
    x: MARGIN_X,
    y: VARIANT_LINE_Y,
    size: LABEL_FONT_SIZE,
    font,
  });
  page.drawText(`Gerado em: ${formatGeneratedAt(meta.generatedAt)}`, {
    x: MARGIN_X,
    y: GENERATED_AT_LINE_Y,
    size: LABEL_FONT_SIZE,
    font,
  });
  page.drawText(versionStampText(meta.version), {
    x: MARGIN_X,
    y: VERSION_LINE_Y,
    size: LABEL_FONT_SIZE,
    font,
  });
}

function measureWidthFor(font: PDFFont): (word: string) => number {
  return (word: string) => font.widthOfTextAtSize(`${word} `, BODY_FONT_SIZE);
}

/** Escala (sem nunca ampliar além do tamanho intrínseco) para caber numa caixa máxima,
 * preservando proporção — só afeta o TAMANHO DESENHADO na página; o XObject embutido
 * mantém os pixels/bytes originais (NFR-024-004 é sobre a fonte da imagem, não o layout). */
function fitWithinBox(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return { width: width * scale, height: height * scale };
}

function createPage(doc: PDFDocument, font: PDFFont, meta: PublicationPdfMeta): PDFPage {
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawDraftHeader(page, font, meta);
  return page;
}

/**
 * `pdf-lib@1.17.1` (`JpegEmbedder.for`) faz `new DataView(buffer.buffer)` SEM
 * `byteOffset`/`length` — se o `ArrayBuffer` subjacente do `Buffer` for MAIOR que o
 * próprio buffer (qualquer `Buffer` pequeno fatiado do pool interno do Node —
 * `Buffer.concat`/`Buffer.from` para payload abaixo de `Buffer.poolSize >>> 1`, caso
 * REALISTA de produção: `Buffer.from(row.imageData)` vindo do Prisma para uma imagem
 * pequena — `Buffer.from(outroBuffer)` copia o CONTEÚDO mas não garante `ArrayBuffer`
 * exato), a leitura fica deslocada e um JPEG genuinamente válido é rejeitado como
 * corrompido ("SOI not found") — silenciosamente, pelo mesmo `catch` de AC-024-016.
 * `buffer.buffer.byteLength === buffer.length` só é verdade quando `byteOffset === 0` E
 * não sobra bytes do pool depois do fim do buffer (a condição implica as duas coisas);
 * quando falha, copia para um `ArrayBuffer` de tamanho exato — o CONTEÚDO não muda
 * (NFR-024-004 continua valendo, provado por `Buffer.compare` no teste), só o
 * `ArrayBuffer` que o carrega. Buffer real do banco, tipicamente grande, não paga esse
 * custo (`return buffer` direto).
 */
function toExactArrayBufferBuffer(buffer: Buffer): Buffer {
  if (buffer.buffer.byteLength === buffer.length) return buffer;
  return Buffer.from(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
}

type EmbedFrameImageResult = { image: PDFImage } | { skipReason: ImageSkipReason };

/**
 * Embute a imagem de 1 Quadro, ou devolve o motivo da recusa — nunca lança (AC-024-016: a
 * falha de 1 Quadro nunca derruba o documento inteiro). 3 recusas ANTES de qualquer
 * decode pesado (`exceedsPixelBudget`/`hasAnimatedPngChunk` só leem cabeçalho — o decoder
 * de `embedPng`/`embedJpg` aloca memória proporcional à dimensão DECODIFICADA, não ao
 * tamanho comprimido do arquivo, então o teto tem que vir antes da chamada, não dentro do
 * `catch`), mais o `try/catch` em torno do embed em si para qualquer outra falha de
 * decodificação (buffer corrompido/irrenderizável).
 */
async function embedFrameImage(
  doc: PDFDocument,
  image: NonNullable<StripFrameForPdf['image']>,
): Promise<EmbedFrameImageResult> {
  if (image.format === 'PNG' && hasAnimatedPngChunk(image.buffer)) {
    return { skipReason: 'apng-not-supported' };
  }

  const dimensions = readImageDimensions(image.buffer, image.format);
  if (dimensions === null) return { skipReason: 'decode-failed' };
  if (exceedsPixelBudget(dimensions)) return { skipReason: 'pixel-budget-exceeded' };

  try {
    const safeBuffer = toExactArrayBufferBuffer(image.buffer);
    const embedded =
      image.format === 'PNG' ? await doc.embedPng(safeBuffer) : await doc.embedJpg(safeBuffer);
    return { image: embedded };
  } catch {
    return { skipReason: 'decode-failed' };
  }
}

/**
 * Variante "resumo" (FR-024-003/A-024-006): texto corrido na ordem canônica
 * `CANONICAL_RULE_BREAKDOWN_ORDER` (CONCEITO→AÇÃO→OBJETO→CONDIÇÃO→EXCEÇÃO), Blocos vazios
 * pulados, mais a Síntese ao final. Transborda para nova página (com o mesmo cabeçalho de
 * rascunho) quando o texto não cabe numa só — nunca um-Quadro-por-página, que é o
 * diagrama da Variante "tira".
 */
export async function buildSummaryPdf(
  breakdown: Pick<
    RuleBreakdownDetail,
    'concept' | 'action' | 'object' | 'condition' | 'exception' | 'essence'
  >,
  meta: PublicationPdfMeta,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const measureWidth = measureWidthFor(font);

  let page = createPage(doc, font, meta);
  let y = CONTENT_TOP_Y;

  const paragraphs: string[] = [];
  for (const item of CANONICAL_RULE_BREAKDOWN_ORDER) {
    const text = breakdown[item.originBlock];
    if (text === null || text === undefined || text === '') continue;
    paragraphs.push(text);
  }
  paragraphs.push(breakdown.essence);

  for (const paragraph of paragraphs) {
    const lines = wrapTextToLines(paragraph, CONTENT_WIDTH, measureWidth);
    for (const line of lines) {
      if (y < CONTENT_BOTTOM_Y) {
        page = createPage(doc, font, meta);
        y = CONTENT_TOP_Y;
      }
      // Texto do usuário literal (NFR-024-002) — nenhuma interpolação/template envolvido.
      page.drawText(line, { x: MARGIN_X, y, size: BODY_FONT_SIZE, font });
      y -= LINE_HEIGHT;
    }
    y -= PARAGRAPH_GAP;
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Variante "tira" (FR-024-004/016): 1 página por `StripFrameForPdf`, na ordem recebida
 * (nunca reordenada). Falha de imagem — decodificação (`embedJpg`/`embedPng` lançando por
 * buffer corrompido/irrenderizável), estouro do teto de pixels ou APNG (`embedFrameImage`
 * acima) — é resolvida POR Quadro e cai no mesmo caminho "só texto" de um Quadro sem
 * imagem — nunca propaga (FR-024-014/AC-024-016). Esse tratamento é escopado só à
 * resolução da imagem: uma exceção de `page.drawText(...)` sobre o texto do Quadro (ex.:
 * caractere fora de WinAnsi, TRISK-025-007) fica FORA desse caminho e propaga normalmente
 * (FR-024-009 — falha do documento inteiro é distinta de falha isolada de Associação
 * visual). `onImageSkipped` é só notificação (sem I/O aqui dentro) — quem loga é o
 * chamador (COMP-025-005/TASK-025-008).
 */
export async function buildStripPdf(
  frames: readonly StripFrameForPdf[],
  meta: PublicationPdfMeta,
  onImageSkipped?: (info: ImageSkippedInfo) => void,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const measureWidth = measureWidthFor(font);

  for (const [frameIndex, frame] of frames.entries()) {
    // Cede o event loop 1x por Quadro — sem isto, `embedPng`/`embedJpg` (síncronos)
    // impedem `withDeadline` (DEC-025-002) de disparar em Tiras grandes.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const page = createPage(doc, font, meta);

    let y = CONTENT_TOP_Y;
    const lines = wrapTextToLines(frame.text, CONTENT_WIDTH, measureWidth);
    for (const line of lines) {
      // Fora do caminho de imagem, de propósito: exceção aqui (WinAnsi) DEVE propagar.
      page.drawText(line, { x: MARGIN_X, y, size: BODY_FONT_SIZE, font });
      y -= LINE_HEIGHT;
    }

    if (frame.image !== null) {
      const result = await embedFrameImage(doc, frame.image);
      if ('skipReason' in result) {
        onImageSkipped?.({ frameIndex, format: frame.image.format, reason: result.skipReason });
      } else {
        const { width, height } = fitWithinBox(
          result.image.width,
          result.image.height,
          IMAGE_MAX_WIDTH,
          IMAGE_MAX_HEIGHT,
        );
        page.drawImage(result.image, {
          x: MARGIN_X,
          y: Math.max(CONTENT_BOTTOM_Y, y - height - LINE_HEIGHT),
          width,
          height,
        });
      }
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Desenha os parágrafos de 1 seção suplementar SEMPRE numa página própria (nunca
 * compartilhada com a seção anterior/seguinte), com transbordo para novas páginas quando o
 * texto não cabe (mesmo mecanismo de paginação de `buildSummaryPdf`, duplicado aqui de
 * propósito: `buildSummaryPdf`/`buildStripPdf` são as 2 Variantes existentes e não devem
 * herdar mudança de layout de uma seção que não lhes pertence, DEC-027-006). Chamada só
 * quando a seção TEM conteúdo (o chamador decide a omissão, FR-026-028/023) — por isso
 * sempre produz >=1 página.
 *
 * `title` identifica a seção — desenhado em CAIXA ALTA só na 1ª página, antes do 1º
 * parágrafo: sem título a Pegadinha saía como texto cru, indistinguível do conteúdo
 * principal (o estudante podia decorar o "erro comum de prova" como se fosse a regra).
 * Página de TRANSBORDO não repete o título — nas seções com rótulo de campo
 * (`Confundível:`/`Pergunta:`/etc.) o próprio rótulo já identifica a página; a PEGADINHA é a
 * exceção: é parágrafo único sem rótulo, e `updatePegadinhaSchema` não limita tamanho — texto
 * longo o bastante para transbordar fica sem identificação na página de continuação (risco
 * residual, RISK-027-008).
 */
function drawSupplementarySection(
  doc: PDFDocument,
  font: PDFFont,
  measureWidth: (word: string) => number,
  meta: PublicationPdfMeta,
  title: string,
  paragraphs: readonly string[],
): void {
  let page = createPage(doc, font, meta);
  page.drawText(title, { x: MARGIN_X, y: CONTENT_TOP_Y, size: BODY_FONT_SIZE, font });
  let y = CONTENT_TOP_Y - LINE_HEIGHT - PARAGRAPH_GAP;

  for (const paragraph of paragraphs) {
    const lines = wrapTextToLines(paragraph, CONTENT_WIDTH, measureWidth);
    for (const line of lines) {
      if (y < CONTENT_BOTTOM_Y) {
        page = createPage(doc, font, meta);
        y = CONTENT_TOP_Y;
      }
      page.drawText(line, { x: MARGIN_X, y, size: BODY_FONT_SIZE, font });
      y -= LINE_HEIGHT;
    }
    y -= PARAGRAPH_GAP;
  }
}

/**
 * Composição suplementar (COMP-027-017, DEC-027-006): Contraste(s) + Pegadinha +
 * Flashcard(s) + Protocolo impresso, num `PDFDocument` PRÓPRIO (nunca o principal — a fusão
 * é responsabilidade de `publication.service.ts`, via `PDFDocument.copyPages`). Cada seção
 * com 0 itens é OMITIDA (nenhuma página vazia, nenhum erro, FR-026-028/023); o Protocolo é
 * sempre desenhado por último, mesmo quando as 3 demais seções estão vazias (FR-026-021 —
 * não depende de nenhum registro autorado).
 */
export async function buildSupplementaryPagesPdf(
  sections: SupplementarySections,
  meta: PublicationPdfMeta,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const measureWidth = measureWidthFor(font);

  if (sections.contrasts.length > 0) {
    const paragraphs = sections.contrasts.flatMap((contrast) => [
      `Confundível: ${contrast.confusableText}`,
      `Distinção: ${contrast.distinctionText}`,
    ]);
    drawSupplementarySection(doc, font, measureWidth, meta, 'CONTRASTES', paragraphs);
  }

  if (sections.pegadinhaText !== null) {
    drawSupplementarySection(doc, font, measureWidth, meta, 'PEGADINHA', [sections.pegadinhaText]);
  }

  if (sections.flashcards.length > 0) {
    const paragraphs = sections.flashcards.flatMap((flashcard) => [
      `Pergunta: ${flashcard.question}`,
      `Resposta: ${flashcard.answer}`,
    ]);
    drawSupplementarySection(doc, font, measureWidth, meta, 'FLASHCARDS', paragraphs);
  }

  drawSupplementarySection(
    doc,
    font,
    measureWidth,
    meta,
    'PROTOCOLO DE REVISÃO',
    sections.protocol.map((mark) => mark.label),
  );

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
