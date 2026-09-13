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
