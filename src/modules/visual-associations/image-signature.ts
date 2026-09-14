/**
 * Fronteira de segurança do upload de imagem (COMP-023-002 / DEC-023-003): detecta o
 * formato raster real de um `Buffer` pelos primeiros bytes (magic number) — nunca por
 * extensão de nome de arquivo nem por `Content-Type` declarado pelo cliente (nenhum dos
 * dois é parâmetro desta função, NFR-022-001). Pura, sem I/O — mesmo espírito de
 * `decideStageTransition` (testável sem mocks).
 *
 * Único controle server-side contra upload de SVG/vetor sem sanitização (NFR-022-002,
 * XSS/XXE, A02/A08 do OWASP): um SVG é texto e nunca casa nenhuma assinatura raster abaixo,
 * então `detectImageSignature` já o recusa por construção, sem allowlist de extensão.
 */

export type RasterImageFormat = 'PNG' | 'JPEG' | 'WEBP';

interface RasterSignature {
  format: RasterImageFormat;
  offset: number;
  bytes: readonly number[];
}

const PNG_SIGNATURE: RasterSignature = {
  format: 'PNG',
  offset: 0,
  bytes: [0x89, 0x50, 0x4e, 0x47],
};
const JPEG_SIGNATURE: RasterSignature = { format: 'JPEG', offset: 0, bytes: [0xff, 0xd8, 0xff] };
const WEBP_RIFF_SIGNATURE: RasterSignature = {
  format: 'WEBP',
  offset: 0,
  bytes: [0x52, 0x49, 0x46, 0x46],
};
const WEBP_WEBP_SIGNATURE: RasterSignature = {
  format: 'WEBP',
  offset: 8,
  bytes: [0x57, 0x45, 0x42, 0x50],
};

/** Checa comprimento antes de comparar — nunca lança para buffer truncado. */
function matchesSignature(buffer: Buffer, signature: RasterSignature): boolean {
  if (buffer.length < signature.offset + signature.bytes.length) return false;
  return signature.bytes.every((expected, index) => buffer[signature.offset + index] === expected);
}

/**
 * Devolve o formato raster detectado pela assinatura de bytes, ou `null` para qualquer
 * outra coisa — inclusive SVG textual, arquivo truncado ou vazio. Nunca lança exceção.
 */
export function detectImageSignature(buffer: Buffer): RasterImageFormat | null {
  if (matchesSignature(buffer, PNG_SIGNATURE)) return 'PNG';
  if (matchesSignature(buffer, JPEG_SIGNATURE)) return 'JPEG';
  if (
    matchesSignature(buffer, WEBP_RIFF_SIGNATURE) &&
    matchesSignature(buffer, WEBP_WEBP_SIGNATURE)
  )
    return 'WEBP';
  return null;
}

function assertNeverRasterFormat(format: never): never {
  throw new Error(`formato raster não tratado: ${String(format)}`);
}

/** Extensão de arquivo (com ponto) para o formato detectado — nunca a extensão do cliente. */
export function extensionForFormat(format: RasterImageFormat): '.png' | '.jpg' | '.webp' {
  switch (format) {
    case 'PNG':
      return '.png';
    case 'JPEG':
      return '.jpg';
    case 'WEBP':
      return '.webp';
    default:
      return assertNeverRasterFormat(format);
  }
}

/** `Content-Type` correspondente, para a rota de entrega do binário. */
export function mimeTypeForFormat(
  format: RasterImageFormat,
): 'image/png' | 'image/jpeg' | 'image/webp' {
  switch (format) {
    case 'PNG':
      return 'image/png';
    case 'JPEG':
      return 'image/jpeg';
    case 'WEBP':
      return 'image/webp';
    default:
      return assertNeverRasterFormat(format);
  }
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Assinatura PNG completa (8 bytes) — não só os 4 bytes que `detectImageSignature` usa
 * como magic number (aquilo é heurística de formato; isto é pré-condição de estrutura
 * antes de confiar em offset fixo). */
const PNG_FULL_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** Offset do campo `length` (4 bytes) do 1º chunk, logo após a assinatura. */
const PNG_FIRST_CHUNK_LENGTH_OFFSET = 8;
/** Offset do campo `type` (4 bytes ASCII) do 1º chunk. */
const PNG_FIRST_CHUNK_TYPE_OFFSET = 12;
/** `IHDR` tem tamanho de payload fixo pelo spec PNG (width/height/bitDepth/colorType/
 * compression/filter/interlace = 4+4+1+1+1+1+1). */
const PNG_IHDR_EXPECTED_LENGTH = 13;
/** Offset do 1º byte de `width` no chunk `IHDR`: assinatura PNG (8) + tamanho do chunk (4)
 * + tipo "IHDR" (4) = 16; `height` começa 4 bytes depois. */
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;
const PNG_IHDR_MIN_LENGTH = PNG_IHDR_HEIGHT_OFFSET + 4;

/** `true` só se os 8 bytes bater exatamente com a assinatura PNG — pré-condição
 * compartilhada por qualquer leitura de offset fixo abaixo (`hasValidPngSignatureAndIhdr`,
 * `hasAnimatedPngChunk`): sem ela, "offset 8" não é necessariamente onde o 1º chunk
 * começa. */
function hasValidPngSignature(buffer: Buffer): boolean {
  if (buffer.length < PNG_FULL_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_FULL_SIGNATURE.length; i++) {
    if (buffer[i] !== PNG_FULL_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * `true` só se a assinatura PNG de 8 bytes bate E o 1º chunk é literalmente `IHDR` com o
 * tamanho de payload esperado (13) — as únicas 2 garantias que o spec PNG dá e que tornam
 * os offsets fixos 16/20 (usados por `readPngDimensions` abaixo) SEGUROS de ler direto,
 * sem variar chunk a chunk como o decoder real (`@pdf-lib/upng`) faz.
 *
 * Sem esta checagem, um PNG forjado com um chunk decoy (ex.: `tEXt`) ANTES do `IHDR`
 * verdadeiro faz um leitor de offset fixo ler os bytes ERRADOS (dentro do payload do
 * decoy) como se fossem width/height — enquanto o decoder real, que varre os chunks, acha
 * o `IHDR` de verdade mais adiante, com a dimensão real (possivelmente forjada acima do
 * teto). `detectImageSignature` (heurística de formato, só 4 bytes) não pega isso — é
 * outra camada, outro propósito.
 */
function hasValidPngSignatureAndIhdr(buffer: Buffer): boolean {
  if (buffer.length < PNG_IHDR_MIN_LENGTH) return false;
  if (!hasValidPngSignature(buffer)) return false;
  if (buffer.readUInt32BE(PNG_FIRST_CHUNK_LENGTH_OFFSET) !== PNG_IHDR_EXPECTED_LENGTH) return false;
  const chunkType = buffer.toString(
    'ascii',
    PNG_FIRST_CHUNK_TYPE_OFFSET,
    PNG_FIRST_CHUNK_TYPE_OFFSET + 4,
  );
  return chunkType === 'IHDR';
}

function readPngDimensions(buffer: Buffer): ImageDimensions | null {
  if (!hasValidPngSignatureAndIhdr(buffer)) return null;
  const width = buffer.readUInt32BE(PNG_IHDR_WIDTH_OFFSET);
  const height = buffer.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** Marcadores JPEG "Start Of Frame" (baseline e as variantes progressivas/aritméticas;
 * exclui DHT=0xC4, JPG=0xC8 e DAC=0xCC, que reusam a faixa 0xC0-0xCF sem serem SOF) — o
 * mesmo conjunto que o `JpegEmbedder` do `pdf-lib` reconhece para achar width/height. */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
/** Marcadores sem campo de tamanho (RST0-RST7, SOI reencontrado, TEM) — 2 bytes só. */
const JPEG_STANDALONE_MARKERS = new Set([
  0xd8, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7,
]);

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let pos = 2;
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    const next = buffer[pos + 1]!;
    if (next === 0xff) {
      // byte de preenchimento (0xFF repetido antes do marcador real) — reexamina 1 byte à frente.
      pos += 1;
      continue;
    }
    if (next === 0xd9) return null; // EOI sem nenhum SOF encontrado antes
    if (JPEG_STANDALONE_MARKERS.has(next)) {
      pos += 2;
      continue;
    }
    if (JPEG_SOF_MARKERS.has(next)) {
      if (pos + 9 > buffer.length) return null; // sem bytes suficientes para height/width
      const height = buffer.readUInt16BE(pos + 5);
      const width = buffer.readUInt16BE(pos + 7);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    const segmentLength = buffer.readUInt16BE(pos + 2);
    if (segmentLength < 2) return null; // segmento mal-formado — nunca entra em loop infinito
    pos += 2 + segmentLength;
  }
  return null;
}

/**
 * Largura/altura declaradas no CABEÇALHO do formato indicado — nunca decodifica o payload
 * de pixel/DCT (PNG: chunk `IHDR`; JPEG: marcador SOF, via varredura de marcadores sem
 * alocar nada). `null` se o buffer não tiver bytes suficientes para o cabeçalho, ou (JPEG)
 * se nenhum marcador SOF for encontrado — nunca lança. Usada por `pdf-composer.ts` como
 * teto ANTES de `embedPng`/`embedJpg` (o decoder interno do `pdf-lib` aloca memória
 * proporcional à dimensão decodificada, não ao tamanho comprimido do arquivo: um PNG de
 * poucos KB com `IHDR` gigante pode estourar heap antes de qualquer byte chegar ao PDF).
 */
export function readImageDimensions(
  buffer: Buffer,
  format: 'PNG' | 'JPEG',
): ImageDimensions | null {
  return format === 'PNG' ? readPngDimensions(buffer) : readJpegDimensions(buffer);
}

/**
 * Teto de pixels decodificados (~20 MP — cobre confortavelmente uma imagem de página
 * impressa em alta resolução, ex. 6000×3333, sem abrir a porta para um `IHDR`/SOF forjado
 * declarando dimensão arbitrária) antes de chamar `embedPng`/`embedJpg`: o decoder aloca
 * ~8 bytes por pixel decodificado (RGBA + buffers intermediários) ANTES de qualquer byte
 * ir para o PDF, então o CUSTO de decodificar escala com `width × height` do cabeçalho,
 * não com o tamanho comprimido do arquivo em disco.
 */
export const IMAGE_PIXEL_BUDGET_PX = 20_000_000;

/** `true` se `width × height` excede `IMAGE_PIXEL_BUDGET_PX` (ou um teto explícito). */
export function exceedsPixelBudget(
  dimensions: ImageDimensions,
  budgetPx: number = IMAGE_PIXEL_BUDGET_PX,
): boolean {
  return dimensions.width * dimensions.height > budgetPx;
}

/** Tipo de chunk `acTL` ("Animation Control") — extensão de fato (não registrada no PNG
 * "core", mas universalmente reconhecida pelos codecs) que marca um PNG como animado
 * (APNG, multi-frame). */
const APNG_ANIMATION_CONTROL_CHUNK_TYPE = 'acTL';
/** Tamanho fixo dos campos `length`(4)+`type`(4) no início de cada chunk PNG. */
const PNG_CHUNK_HEADER_SIZE = 8;
/** Tamanho fixo do campo `crc`(4) ao final de cada chunk PNG. */
const PNG_CHUNK_CRC_SIZE = 4;

/**
 * `true` só se o buffer contém um chunk cujo campo TYPE (em fronteira de chunk, nunca uma
 * substring solta em qualquer offset) é literalmente `acTL` — um APNG só é rejeitado pelo
 * decoder do `pdf-lib` DEPOIS de decodificar TODOS os frames da animação (o `IHDR` sozinho
 * não distingue PNG estático de APNG), então esta varredura acontece ANTES do decode, no
 * mesmo espírito do teto de pixels acima.
 *
 * Busca de SUBSTRING no buffer bruto (a versão anterior desta função) é insegura na
 * direção oposta à do teto de pixels: um PNG ESTÁTICO legítimo pode conter os bytes
 * `acTL` por acaso dentro do payload de um chunk de metadado (`tEXt`/`iTXt`/`eXIf`) ou no
 * stream de pixel comprimido (`IDAT`), e seria recusado como APNG mesmo sendo uma imagem
 * que o `pdf-lib` embutiria sem problema — um falso positivo silencioso (a imagem some da
 * página), não uma falha de segurança, mas ainda assim uma leitura errada da estrutura
 * real do arquivo. A varredura abaixo avança de chunk em chunk pelo campo `length`
 * declarado (nunca por índice de substring), então só compara `acTL` contra o TYPE de
 * cada chunk de verdade.
 */
export function hasAnimatedPngChunk(buffer: Buffer): boolean {
  if (!hasValidPngSignature(buffer)) return false;

  let pos = PNG_FULL_SIGNATURE.length;
  while (pos + PNG_CHUNK_HEADER_SIZE <= buffer.length) {
    const chunkDataLength = buffer.readUInt32BE(pos);
    const chunkType = buffer.toString('ascii', pos + 4, pos + PNG_CHUNK_HEADER_SIZE);
    if (chunkType === APNG_ANIMATION_CONTROL_CHUNK_TYPE) return true;
    if (chunkType === 'IEND') return false; // fim oficial da cadeia de chunks
    pos += PNG_CHUNK_HEADER_SIZE + chunkDataLength + PNG_CHUNK_CRC_SIZE;
  }
  return false;
}
