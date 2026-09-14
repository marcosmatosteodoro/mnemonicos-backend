import { deflateSync } from 'node:zlib';

/**
 * Fixtures de bytes PNG compartilhadas entre `tests/unit/image-signature.test.ts` e
 * `tests/unit/pdf-composer.test.ts` — helper único (perfil node-22.md §7, "Fixtures
 * compartilhadas"; mesmo padrão de `tests/support/production-events-fixtures.ts` e
 * `tests/support/visual-association-fixtures.ts`). Puro, sem I/O, e sem import de
 * `tests/integration/db.ts` (que constrói `PrismaClient` no topo do módulo) —
 * inadequado para os testes unitários "sem banco" que consomem isto (mesmo motivo de
 * `tests/unit/image-signature.test.ts` não importar
 * `tests/support/visual-association-fixtures.ts`).
 */

/** CRC-32 (IEEE 802.3, o mesmo polinômio usado pelo PNG) — implementação direta, sem
 * dependência externa. */
export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 1 chunk PNG REAL (`length`+`type`+`data`+`crc`) — bloco de construção de todas as
 * fixtures abaixo. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const PNG_SIGNATURE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 1×1 RGB (vermelho puro) genuinamente decodível — `IHDR` + `IDAT` (zlib real via
 * `node:zlib`) + `IEND`, não só a assinatura de bytes. */
export function buildValidPng1x1(): Buffer {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(2, 9); // color type 2 = RGB
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace
  const ihdr = pngChunk('IHDR', ihdrData);

  const rawScanline = Buffer.from([0x00, 0xff, 0x00, 0x00]); // filtro 0 + 1 pixel RGB
  const idat = pngChunk('IDAT', deflateSync(rawScanline));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([PNG_SIGNATURE_BYTES, ihdr, idat, iend]);
}

/** `IHDR` de um PNG com `width`/`height` arbitrários — só o cabeçalho (sem `IDAT`/`IEND`),
 * suficiente para `readImageDimensions`, que nunca olha além dos primeiros 24 bytes. Inclui
 * o CRC (4 bytes, valor dummy — ninguém aqui o valida) para que o chunk fique com o
 * tamanho REAL de um chunk PNG: `hasAnimatedPngChunk` (varredura por fronteira de chunk)
 * precisa disso para achar corretamente o próximo chunk depois do IHDR. */
export function pngHeaderWithDimensions(width: number, height: number): Buffer {
  const chunkLength = Buffer.alloc(4);
  chunkLength.writeUInt32BE(13, 0);
  const chunkType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  const crc = Buffer.alloc(4);
  return Buffer.concat([PNG_SIGNATURE_BYTES, chunkLength, chunkType, ihdrData, crc]);
}

/**
 * PNG com um chunk decoy (`tEXt`, 20 bytes de payload) ANTES do `IHDR` real. O payload do
 * decoy é construído para que uma leitura de OFFSET FIXO (16/20, sem validar o que está
 * ali) decodifique como `width=1,height=1` — inofensivo — enquanto o `IHDR` verdadeiro,
 * mais adiante (achado pelo decoder real, que VARRE os chunks), declara uma dimensão
 * FORJADA acima do teto. `readImageDimensions` tem que devolver `null` para o arquivo
 * inteiro.
 */
export function buildPngWithDecoyChunkBeforeIhdr(fakeWidth: number, fakeHeight: number): Buffer {
  const decoyPayload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]), // offsets ABSOLUTOS 16-23: "1×1"
    Buffer.alloc(12, 0x00), // completa os 20 bytes declarados
  ]);
  const decoyChunk = pngChunk('tEXt', decoyPayload);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(fakeWidth, 0);
  ihdrData.writeUInt32BE(fakeHeight, 4);
  const ihdrChunk = pngChunk('IHDR', ihdrData);

  return Buffer.concat([PNG_SIGNATURE_BYTES, decoyChunk, ihdrChunk]);
}

/**
 * PNG com 2 chunks `IHDR` — `width1`×`height1` primeiro, `width2`×`height2` depois. O
 * decoder real (`@pdf-lib/upng`) sobrescreve width/height a cada `IHDR` que encontra —
 * vence o ÚLTIMO, não o primeiro — então um `IHDR` pequeno seguido de um `IHDR` gigante
 * engana qualquer leitura que confie só no 1º. `readImageDimensions` tem que devolver
 * `null` para o arquivo inteiro (0 ou 2+ `IHDR` é inválido pelo spec PNG).
 */
export function buildPngWithDuplicateIhdr(
  width1: number,
  height1: number,
  width2: number,
  height2: number,
): Buffer {
  const ihdr1Data = Buffer.alloc(13);
  ihdr1Data.writeUInt32BE(width1, 0);
  ihdr1Data.writeUInt32BE(height1, 4);
  const ihdr1 = pngChunk('IHDR', ihdr1Data);

  const ihdr2Data = Buffer.alloc(13);
  ihdr2Data.writeUInt32BE(width2, 0);
  ihdr2Data.writeUInt32BE(height2, 4);
  const ihdr2 = pngChunk('IHDR', ihdr2Data);

  return Buffer.concat([PNG_SIGNATURE_BYTES, ihdr1, ihdr2]);
}
