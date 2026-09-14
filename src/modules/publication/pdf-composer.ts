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

const [PAGE_WIDTH, PAGE_HEIGHT] = PageSizes.A4;

const MARGIN_X = 50;
const MARGIN_TOP = 85; // reserva o cabeçalho de rascunho (3 linhas) fora da área de conteúdo
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

/** Nunca "fechamento"/"aprovação" (AC-024-005) — é rótulo de RASCUNHO/geração, não de
 * decisão editorial sobre o conteúdo. */
const DRAFT_LABEL = 'RASCUNHO — documento gerado automaticamente, sujeito a revisão.';

const IMAGE_MAX_WIDTH = 300;
const IMAGE_MAX_HEIGHT = 300;

function formatGeneratedAt(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

/**
 * Rótulo de rascunho + Variante (`meta.variant`, lida do valor — nunca hardcoded, AC-024-005
 * exige que o rótulo diga TAMBÉM qual Variante a página representa) + `meta.generatedAt`
 * (FR-024-001/AC-024-005) — chamada uma vez por página recém-criada, nunca só na 1ª (tanto
 * no laço de `buildStripPdf` quanto na(s) página(s) de `buildSummaryPdf`).
 */
function drawDraftHeader(page: PDFPage, font: PDFFont, meta: PublicationPdfMeta): void {
  page.drawText(DRAFT_LABEL, { x: MARGIN_X, y: LABEL_LINE_Y, size: LABEL_FONT_SIZE, font });
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
 * decode pesado (`exceedsPixelBudget`/`hasAnimatedPngChunk` só leem cabeçalho — achado do
 * security-engineer, gate 8: o decoder de `embedPng`/`embedJpg` aloca memória proporcional
 * à dimensão DECODIFICADA, não ao tamanho comprimido do arquivo, então o teto tem que
 * vir antes da chamada, não dentro do `catch`), mais o `try/catch` em torno do embed em si
 * para qualquer outra falha de decodificação (buffer corrompido/irrenderizável).
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
