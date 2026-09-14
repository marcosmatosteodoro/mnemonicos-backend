import { deflateSync } from 'node:zlib';

import {
  IMAGE_PIXEL_BUDGET_PX,
  detectImageSignature,
  exceedsPixelBudget,
  extensionForFormat,
  hasAnimatedPngChunk,
  mimeTypeForFormat,
  readImageDimensions,
  type RasterImageFormat,
} from '../../src/modules/visual-associations/image-signature';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Chunk PNG REAL (length + type + data + crc) — usado pelos PoCs de `hasAnimatedPngChunk`
 * abaixo, que precisam de fronteiras de chunk corretas (não só um IHDR solto). */
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * PNG 1×1 estático (sem `acTL` nenhum) genuinamente válido — `IHDR`+`IDAT`+`IEND`, todos
 * com CRC real — usado como base pelos 2 casos abaixo, em que os bytes `acTL` aparecem
 * DENTRO do payload de um chunk (nunca como TYPE de um chunk de verdade); `hasAnimatedPngChunk`
 * tem que devolver `false` nos dois — o `pdf-lib` real embutiria esta imagem sem problema.
 */
function buildStaticPngWithAcTLBytesInPayload(location: 'text-chunk' | 'pixel-data'): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(2, 9);
  const ihdr = pngChunk('IHDR', ihdrData);

  const middleChunks: Buffer[] = [];
  if (location === 'text-chunk') {
    // "acTL" aparece dentro do DADO de um chunk tEXt real — nunca como TYPE de chunk.
    const textPayload = Buffer.from('Comment: acTL is not a chunk type here', 'ascii');
    middleChunks.push(pngChunk('tEXt', textPayload));
  }

  const rawScanline =
    location === 'pixel-data'
      ? Buffer.concat([Buffer.from([0x00]), Buffer.from('XXacTLXX', 'ascii')]) // filtro 0 + payload com "acTL" embutido
      : Buffer.from([0x00, 0xff, 0x00, 0x00]); // filtro 0 + 1 pixel RGB qualquer

  // `level: 0` (STORED block) garante que os bytes crus (incl. "acTL", no caso
  // 'pixel-data') sobrevivem literalmente dentro do IDAT comprimido — prova mais forte
  // que compressão real, que poderia (ou não) preservar a sequência por acaso.
  const idat = pngChunk('IDAT', deflateSync(rawScanline, { level: 0 }));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, ...middleChunks, idat, iend]);
}

/** `IHDR` de um PNG com `width`/`height` arbitrários — só o cabeçalho (sem `IDAT`/`IEND`),
 * suficiente para `readImageDimensions`, que nunca olha além dos primeiros 24 bytes. Inclui
 * o CRC (4 bytes, valor dummy — ninguém aqui o valida) para que o chunk fique com o
 * tamanho REAL de um chunk PNG: `hasAnimatedPngChunk` (varredura por fronteira de chunk)
 * precisa disso para achar corretamente o próximo chunk depois do IHDR. */
function pngHeaderWithDimensions(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunkLength = Buffer.alloc(4);
  chunkLength.writeUInt32BE(13, 0);
  const chunkType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  const crc = Buffer.alloc(4);
  return Buffer.concat([signature, chunkLength, chunkType, ihdrData, crc]);
}

/**
 * PNG com um chunk decoy (`tEXt`, 20 bytes de payload) ANTES do `IHDR` real. Uma leitura de
 * OFFSET FIXO (16/20, sem validar o que está ali) leria os bytes 16-23 — que caem DENTRO
 * do payload do decoy, construído de propósito para decodificar como `width=1,height=1`
 * — e liberaria a imagem como inofensiva; o decoder real (`@pdf-lib/upng`) VARRE os
 * chunks e acharia o `IHDR` verdadeiro mais adiante, com a dimensão FORJADA
 * (`fakeWidth`/`fakeHeight`, tipicamente acima do teto). `readImageDimensions` precisa
 * devolver `null` para o arquivo inteiro — nem o decoy nem o `IHDR` forjado podem
 * "vazar" uma dimensão aceita.
 */
function pngWithDecoyChunkBeforeIhdr(fakeWidth: number, fakeHeight: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const decoyLength = Buffer.alloc(4);
  decoyLength.writeUInt32BE(20, 0);
  const decoyType = Buffer.from('tEXt', 'ascii');
  const decoyPayload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]), // offsets ABSOLUTOS 16-23: "1×1"
    Buffer.alloc(12, 0x00), // completa os 20 bytes declarados em decoyLength
  ]);
  const decoyCrc = Buffer.alloc(4); // ninguém aqui valida CRC — irrelevante para o PoC
  const decoyChunk = Buffer.concat([decoyLength, decoyType, decoyPayload, decoyCrc]);

  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(fakeWidth, 0);
  ihdrData.writeUInt32BE(fakeHeight, 4);
  const ihdrCrc = Buffer.alloc(4);
  const ihdrChunk = Buffer.concat([ihdrLength, ihdrType, ihdrData, ihdrCrc]);

  return Buffer.concat([signature, decoyChunk, ihdrChunk]);
}

/** SOI + (opcional) 1 segmento genérico antes do SOF0 + SOF0 com `width`/`height` — só o
 * necessário para `readImageDimensions` achar o marcador; sem DQT/DHT/SOS/dado
 * codificado (esta suíte testa leitura de cabeçalho, não decodificação via `pdf-lib`). */
function jpegHeaderWithDimensions(
  width: number,
  height: number,
  options: {
    leadingSegment?: boolean;
    fillBytesBeforeMarker?: boolean;
    strayByteBeforeMarker?: boolean;
    standaloneMarkerBeforeSof?: boolean;
  } = {},
): Buffer {
  const u16 = (n: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n, 0);
    return b;
  };

  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]; // SOI

  if (options.leadingSegment) {
    // Segmento genérico (ex.: EXIF-like, marcador 0xE1) com payload arbitrário — exercita
    // o ramo que pula um segmento pelo campo de tamanho antes de achar o SOF.
    const payload = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    parts.push(Buffer.from([0xff, 0xe1]), u16(2 + payload.length), payload);
  }

  if (options.fillBytesBeforeMarker) {
    parts.push(Buffer.from([0xff, 0xff, 0xff])); // bytes de preenchimento antes do marcador real
  }

  if (options.strayByteBeforeMarker) {
    parts.push(Buffer.from([0x00])); // byte solto (não é 0xFF) — exercita o resync
  }

  if (options.standaloneMarkerBeforeSof) {
    parts.push(Buffer.from([0xff, 0xd0])); // RST0 — marcador sem campo de tamanho
  }

  const sof0Data = Buffer.concat([
    Buffer.from([0x08]),
    u16(height),
    u16(width),
    Buffer.from([0x01]),
    Buffer.from([0x01, 0x11, 0x00]),
  ]);
  parts.push(Buffer.from([0xff, 0xc0]), u16(2 + sof0Data.length), sof0Data);

  return Buffer.concat(parts);
}

describe('detectImageSignature', () => {
  it('reconhece um PNG válido pela assinatura de bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

    expect(detectImageSignature(buffer)).toBe('PNG');
  });

  it('reconhece um JPEG válido pela assinatura de bytes', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    expect(detectImageSignature(buffer)).toBe('JPEG');
  });

  it('reconhece um WebP válido pela assinatura RIFF + WEBP no offset 8', () => {
    const buffer = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x00,
      0x00,
      0x00,
      0x00, // tamanho do chunk (irrelevante para a detecção)
      0x57,
      0x45,
      0x42,
      0x50, // "WEBP"
    ]);

    expect(detectImageSignature(buffer)).toBe('WEBP');
  });

  it('devolve null para um SVG renomeado .png (conteúdo textual, sem assinatura raster)', () => {
    const svgBuffer = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'utf-8',
    );

    expect(detectImageSignature(svgBuffer)).toBeNull();
  });

  it('devolve null sem lançar exceção para um arquivo truncado (menos bytes que o magic number mais longo)', () => {
    const truncated = Buffer.from([0x89, 0x50]);

    expect(() => detectImageSignature(truncated)).not.toThrow();
    expect(detectImageSignature(truncated)).toBeNull();
  });

  it('devolve null para um buffer com prefixo RIFF mas sem WEBP no offset 8 (ex.: WAV)', () => {
    const wavLikeBuffer = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x41,
      0x56,
      0x45, // "WAVE", não "WEBP"
    ]);

    expect(detectImageSignature(wavLikeBuffer)).toBeNull();
  });
});

describe('extensionForFormat', () => {
  it.each<[RasterImageFormat, string]>([
    ['PNG', '.png'],
    ['JPEG', '.jpg'],
    ['WEBP', '.webp'],
  ])('devolve %s -> %s', (format, expected) => {
    expect(extensionForFormat(format)).toBe(expected);
  });
});

describe('mimeTypeForFormat', () => {
  it.each<[RasterImageFormat, string]>([
    ['PNG', 'image/png'],
    ['JPEG', 'image/jpeg'],
    ['WEBP', 'image/webp'],
  ])('devolve %s -> %s', (format, expected) => {
    expect(mimeTypeForFormat(format)).toBe(expected);
  });
});

describe('readImageDimensions (lê SÓ o cabeçalho)', () => {
  it('PNG: lê width/height do IHDR sem exigir IDAT/IEND', () => {
    const buffer = pngHeaderWithDimensions(800, 600);

    expect(readImageDimensions(buffer, 'PNG')).toEqual({ width: 800, height: 600 });
  });

  it('PNG: devolve null para buffer menor que o IHDR mínimo (24 bytes), sem lançar', () => {
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    expect(() => readImageDimensions(truncated, 'PNG')).not.toThrow();
    expect(readImageDimensions(truncated, 'PNG')).toBeNull();
  });

  it('PNG: devolve null (nunca a dimensão do decoy NEM a forjada) quando um chunk decoy antecede o IHDR real', () => {
    const forged = pngWithDecoyChunkBeforeIhdr(5000, 5000);

    const result = readImageDimensions(forged, 'PNG');

    expect(result).not.toEqual({ width: 1, height: 1 }); // não "vaza" a leitura por offset fixo do decoy
    expect(result).not.toEqual({ width: 5000, height: 5000 }); // não "vaza" o IHDR forjado sem validar posição
    expect(result).toBeNull();
  });

  it('JPEG: lê width/height do marcador SOF0, pulando um segmento genérico antes dele', () => {
    const buffer = jpegHeaderWithDimensions(1024, 768, { leadingSegment: true });

    expect(readImageDimensions(buffer, 'JPEG')).toEqual({ width: 1024, height: 768 });
  });

  it('JPEG: pula bytes de preenchimento (0xFF repetido) antes do marcador real', () => {
    const buffer = jpegHeaderWithDimensions(640, 480, { fillBytesBeforeMarker: true });

    expect(readImageDimensions(buffer, 'JPEG')).toEqual({ width: 640, height: 480 });
  });

  it('JPEG: resincroniza ao encontrar um byte solto (não 0xFF) fora de um marcador', () => {
    const buffer = jpegHeaderWithDimensions(320, 240, { strayByteBeforeMarker: true });

    expect(readImageDimensions(buffer, 'JPEG')).toEqual({ width: 320, height: 240 });
  });

  it('JPEG: pula um marcador autônomo (RST, sem campo de tamanho) antes do SOF', () => {
    const buffer = jpegHeaderWithDimensions(200, 150, { standaloneMarkerBeforeSof: true });

    expect(readImageDimensions(buffer, 'JPEG')).toEqual({ width: 200, height: 150 });
  });

  it('JPEG: devolve null se o SOI não abre o buffer', () => {
    const notJpeg = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    expect(readImageDimensions(notJpeg, 'JPEG')).toBeNull();
  });

  it('JPEG: devolve null se o EOI aparece antes de qualquer marcador SOF (nenhum SOF no arquivo)', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    expect(readImageDimensions(buffer, 'JPEG')).toBeNull();
  });

  it('JPEG: devolve null sem lançar para buffer truncado bem no meio do marcador SOF (stub já existente no repo)', () => {
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    expect(() => readImageDimensions(truncated, 'JPEG')).not.toThrow();
    expect(readImageDimensions(truncated, 'JPEG')).toBeNull();
  });
});

describe('exceedsPixelBudget', () => {
  it('width × height igual ao teto NÃO excede (fronteira inclusiva)', () => {
    expect(exceedsPixelBudget({ width: IMAGE_PIXEL_BUDGET_PX, height: 1 })).toBe(false);
  });

  it('width × height 1px acima do teto excede', () => {
    expect(exceedsPixelBudget({ width: IMAGE_PIXEL_BUDGET_PX + 1, height: 1 })).toBe(true);
  });

  it('teto explícito substitui o default', () => {
    expect(exceedsPixelBudget({ width: 100, height: 100 }, 5_000)).toBe(true);
    expect(exceedsPixelBudget({ width: 100, height: 100 }, 20_000)).toBe(false);
  });
});

describe('hasAnimatedPngChunk', () => {
  it('detecta o chunk acTL quando ele é o TYPE de um chunk real, em fronteira de chunk', () => {
    const actlData = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]);
    const withActl = Buffer.concat([pngHeaderWithDimensions(1, 1), pngChunk('acTL', actlData)]);

    expect(hasAnimatedPngChunk(withActl)).toBe(true);
  });

  it('devolve false para um PNG estático (sem acTL)', () => {
    const withoutActl = pngHeaderWithDimensions(1, 1);

    expect(hasAnimatedPngChunk(withoutActl)).toBe(false);
  });

  it('devolve false quando os bytes "acTL" aparecem DENTRO do payload de um chunk tEXt, nunca como TYPE de chunk — imagem estática legítima não pode ser recusada por coincidência de bytes', () => {
    const png = buildStaticPngWithAcTLBytesInPayload('text-chunk');

    expect(hasAnimatedPngChunk(png)).toBe(false);
  });

  it('devolve false quando os bytes "acTL" aparecem DENTRO do stream de pixel comprimido (IDAT) — mesma razão, formato diferente de payload', () => {
    const png = buildStaticPngWithAcTLBytesInPayload('pixel-data');

    expect(hasAnimatedPngChunk(png)).toBe(false);
  });
});
