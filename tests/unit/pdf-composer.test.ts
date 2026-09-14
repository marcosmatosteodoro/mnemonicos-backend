import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';

import { buildStripPdf, buildSummaryPdf } from '../../src/modules/publication/pdf-composer';
import type {
  ImageSkippedInfo,
  StripFrameForPdf,
} from '../../src/modules/publication/pdf-composer';

/**
 * Fixtures de imagem NOVAS, mínimas e REALMENTE decodíveis (1×1) — só para este arquivo
 * (TASK-025-007). Os stubs já existentes em `tests/support/visual-association-fixtures.ts`
 * (`PNG_FIXTURE_BUFFER`) e `visual-associations.routes.integration.test.ts`
 * (`JPEG_FIXTURE`) são só prefixo de assinatura de bytes — sem `IDAT`/`IEND` nem payload
 * JPEG completo — e fazem `embedPng`/`embedJpg` do pdf-lib LANÇAR (confirmado por leitura
 * direta, decisão 4.307); por isso servem aqui de fixture do caso "falha de decodificação"
 * (AC-024-016), e não do caminho feliz. Réplicas locais (não import de
 * `tests/support/visual-association-fixtures.ts`): aquele helper importa
 * `tests/integration/db.ts` (constrói `PrismaClient` no topo do módulo) — inadequado para
 * um teste unitário "sem banco" (mesmo padrão de `tests/unit/image-signature.test.ts`, que
 * também redeclara os bytes localmente em vez de importar o helper de integração).
 */

/** Prefixo de PNG (assinatura + início do IHDR) sem `IDAT`/`IEND` — mesmos bytes de
 * `PNG_FIXTURE_BUFFER`. */
const TRUNCATED_PNG_STUB = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/** Prefixo de JPEG (SOI + início do APP0/JFIF) sem SOF/dados — mesmos bytes de
 * `JPEG_FIXTURE` (`visual-associations.routes.integration.test.ts:39`). */
const TRUNCATED_JPEG_STUB = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

/**
 * `pdf-lib` (`JpegEmbedder.for`) faz `new DataView(imageData.buffer)` SEM `byteOffset`/
 * `length` — se o `Buffer` vier de um slice do pool interno do Node (`Buffer.concat`/
 * `Buffer.from(array)` para buffers pequenos, abaixo de metade de `Buffer.poolSize`), o
 * `.buffer` aponta pro ArrayBuffer inteiro do POOL (não só os bytes do fixture), e a
 * leitura fica deslocada ("SOI not found in JPEG" num JPEG válido). Cópia para um
 * ArrayBuffer de tamanho exato (via `new Uint8Array(buf).buffer`, que sempre COPIA, nunca
 * vê o pool) neutraliza isso — confirmado por execução direta contra o `pdf-lib`
 * instalado. Dado real do banco (F5) tipicamente excede o limiar do pool e não paga esse
 * imposto; aqui, com fixtures de ~70-160 bytes, é necessário.
 */
function toStandaloneBuffer(buffer: Buffer): Buffer {
  return Buffer.from(new Uint8Array(buffer).buffer);
}

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

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** PNG 1×1 RGB (vermelho puro) genuinamente decodível — `IHDR` + `IDAT` (zlib real via
 * `node:zlib`) + `IEND`, não só a assinatura de bytes. */
function buildValidPng1x1(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

  return toStandaloneBuffer(Buffer.concat([signature, ihdr, idat, iend]));
}

/**
 * JPEG 1×1 grayscale genuinamente decodível (baseline, ITU-T.81): SOI, APP0/JFIF, DQT,
 * SOF0 (1 componente, 1×1), DHT (DC e AC — 1 único código de 2 bits cada: categoria 0 e
 * EOB), SOS, 1 byte de dado codificado (`0000` do bloco DC=0/AC=EOB + `1111` de padding) e
 * EOI. Bloco 8×8 uniforme (nível 128 após level-shift) — DCT de bloco constante é
 * zero-coeficientes, exatamente o que este arquivo codifica à mão. Verificado por
 * `doc.embedJpg(...)` real contra o pdf-lib instalado (não só a heurística de assinatura).
 */
function buildValidJpeg1x1Bytes(): Buffer {
  const u16 = (n: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n, 0);
    return b;
  };

  const soi = Buffer.from([0xff, 0xd8]);

  const app0Data = Buffer.concat([
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.from([0x01, 0x01]),
    Buffer.from([0x00]),
    u16(1),
    u16(1),
    Buffer.from([0x00, 0x00]),
  ]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16(2 + app0Data.length), app0Data]);

  const dqtData = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 0x10)]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb]), u16(2 + dqtData.length), dqtData]);

  const sof0Data = Buffer.concat([
    Buffer.from([0x08]),
    u16(1),
    u16(1),
    Buffer.from([0x01]),
    Buffer.from([0x01, 0x11, 0x00]),
  ]);
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), u16(2 + sof0Data.length), sof0Data]);

  const huffmanBits16 = Buffer.from([0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const dhtDcData = Buffer.concat([Buffer.from([0x00]), huffmanBits16, Buffer.from([0x00])]);
  const dhtDc = Buffer.concat([Buffer.from([0xff, 0xc4]), u16(2 + dhtDcData.length), dhtDcData]);
  const dhtAcData = Buffer.concat([Buffer.from([0x10]), huffmanBits16, Buffer.from([0x00])]);
  const dhtAc = Buffer.concat([Buffer.from([0xff, 0xc4]), u16(2 + dhtAcData.length), dhtAcData]);

  const sosData = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([0x00, 0x3f, 0x00]),
  ]);
  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), u16(2 + sosData.length), sosData]);

  const scanData = Buffer.from([0x0f]); // '0000' (DC cat0 + AC EOB) + '1111' padding
  const eoi = Buffer.from([0xff, 0xd9]);

  return Buffer.concat([soi, app0, dqt, sof0, dhtDc, dhtAc, sos, scanData, eoi]);
}

function buildValidJpeg1x1(): Buffer {
  return toStandaloneBuffer(buildValidJpeg1x1Bytes());
}

/**
 * Mesmo JPEG 1×1 válido, mas construído do jeito que uma leitura real do Prisma produz —
 * `Buffer.concat` de um payload pequeno cai no pool interno do Node (`byteOffset !== 0`),
 * SEM a normalização `toStandaloneBuffer` que as outras fixtures deste arquivo usam.
 * Prova que `embedFrameImage` normaliza o buffer sozinho antes do embed, em vez de
 * depender de quem chama já ter normalizado — lança se a pré-condição (`byteOffset !== 0`)
 * não se confirmar, para o teste nunca passar "por acidente" testando um buffer que não
 * reproduz o bug.
 */
function buildValidJpeg1x1PoolBacked(): Buffer {
  const poolBacked = Buffer.concat([buildValidJpeg1x1Bytes()]);
  if (poolBacked.byteOffset === 0) {
    throw new Error(
      'Pré-condição do teste falhou: buffer não ficou pool-backed (byteOffset === 0) — ' +
        'a fixture não reproduz o cenário de produção que este teste precisa provar.',
    );
  }
  return poolBacked;
}

/**
 * PNG cujo `IHDR` declara uma dimensão astronômica (`width × height` muito acima de
 * `IMAGE_PIXEL_BUDGET_PX`), mas sem `IDAT`/`IEND` de verdade — arquivo pequeno o
 * suficiente para nunca ter existido de fato como imagem real. Prova que a recusa
 * acontece por LEITURA DE CABEÇALHO, antes de qualquer tentativa de decodificação pesada
 * — se o teto fosse removido, `embedPng` receberia este buffer INCOMPLETO e o motivo
 * mudaria para `'decode-failed'`, nunca `'pixel-budget-exceeded'`.
 */
function buildPngWithOversizedHeader(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(100_000, 0); // width
  ihdrData.writeUInt32BE(100_000, 4); // height — 10 bilhões de px, bem acima do teto
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(2, 9);
  const ihdr = pngChunk('IHDR', ihdrData);

  return toStandaloneBuffer(Buffer.concat([signature, ihdr])); // sem IDAT/IEND, de propósito
}

/** PNG 1×1 válido (mesma estrutura de `buildValidPng1x1`) com um chunk `acTL` (Animation
 * Control) inserido entre `IHDR` e `IDAT` — marca de APNG que `hasAnimatedPngChunk` deve
 * detectar ANTES do decode. */
function buildPngWithActlChunk(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(2, 9);
  const ihdr = pngChunk('IHDR', ihdrData);

  const actlData = Buffer.alloc(8);
  actlData.writeUInt32BE(2, 0); // num_frames (valor arbitrário — só a presença importa)
  actlData.writeUInt32BE(0, 4); // num_plays
  const actl = pngChunk('acTL', actlData);

  const rawScanline = Buffer.from([0x00, 0xff, 0x00, 0x00]);
  const idat = pngChunk('IDAT', deflateSync(rawScanline));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return toStandaloneBuffer(Buffer.concat([signature, ihdr, actl, idat, iend]));
}

/**
 * PNG com `IHDR` 1×1 válido (passa longe do teto de pixels, sem `acTL`) mas `IDAT` lixo
 * (não é um stream `zlib` válido) — o `embedPng` real do `pdf-lib` só lança ao tentar
 * DECODIFICAR esse payload, nunca na leitura de cabeçalho. Prova que o `try/catch` em
 * torno do `embedPng`/`embedJpg` (dentro de `embedFrameImage`) continua vivo mesmo depois
 * das checagens novas — sem esta fixture, `TRUNCATED_JPEG_STUB` (curto demais para passar
 * de `readImageDimensions`) nunca alcançaria esse `catch`, e um mutante que o removesse
 * passaria despercebido.
 */
function buildPngWithCorruptIdat(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(2, 9);
  const ihdr = pngChunk('IHDR', ihdrData);

  const garbageIdat = pngChunk('IDAT', Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22]));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return toStandaloneBuffer(Buffer.concat([signature, ihdr, garbageIdat, iend]));
}

/**
 * PNG com um chunk decoy (`tEXt`, 20 bytes de payload) ANTES do `IHDR` real. O payload do
 * decoy é construído para que uma leitura de OFFSET FIXO (16/20, sem validar o que está
 * ali) decodifique como `width=1,height=1` — inofensivo — enquanto o `IHDR` verdadeiro,
 * mais adiante (achado pelo decoder real, que VARRE os chunks), declara uma dimensão
 * FORJADA acima do teto. `readImageDimensions` tem que devolver `null` para o arquivo
 * inteiro, e `embedFrameImage` nunca pode chegar a chamar `embedPng` com isto.
 */
function buildPngWithDecoyChunkBeforeIhdr(fakeWidth: number, fakeHeight: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const decoyPayload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]), // offsets ABSOLUTOS 16-23: "1×1"
    Buffer.alloc(12, 0x00),
  ]);
  const decoyChunk = pngChunk('tEXt', decoyPayload);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(fakeWidth, 0);
  ihdrData.writeUInt32BE(fakeHeight, 4);
  const ihdrChunk = pngChunk('IHDR', ihdrData);

  return toStandaloneBuffer(Buffer.concat([signature, decoyChunk, ihdrChunk]));
}

/**
 * PNG com 2 chunks `IHDR` — `width1`×`height1` primeiro, `width2`×`height2` depois. O
 * decoder real (`@pdf-lib/upng`) sobrescreve width/height a cada `IHDR` que encontra —
 * vence o ÚLTIMO, não o primeiro — então um `IHDR` pequeno seguido de um `IHDR` gigante
 * engana qualquer leitura que confie só no 1º. `readImageDimensions` tem que devolver
 * `null` para o arquivo inteiro, e `embedFrameImage` nunca pode chegar a chamar
 * `embedPng` com isto.
 */
function buildPngWithDuplicateIhdr(
  width1: number,
  height1: number,
  width2: number,
  height2: number,
): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr1Data = Buffer.alloc(13);
  ihdr1Data.writeUInt32BE(width1, 0);
  ihdr1Data.writeUInt32BE(height1, 4);
  const ihdr1 = pngChunk('IHDR', ihdr1Data);

  const ihdr2Data = Buffer.alloc(13);
  ihdr2Data.writeUInt32BE(width2, 0);
  ihdr2Data.writeUInt32BE(height2, 4);
  const ihdr2 = pngChunk('IHDR', ihdr2Data);

  return toStandaloneBuffer(Buffer.concat([signature, ihdr1, ihdr2]));
}

const VALID_PNG_1X1 = buildValidPng1x1();
const VALID_JPEG_1X1 = buildValidJpeg1x1();
const PNG_WITH_OVERSIZED_HEADER = buildPngWithOversizedHeader();
const PNG_WITH_ACTL_CHUNK = buildPngWithActlChunk();
const PNG_WITH_CORRUPT_IDAT = buildPngWithCorruptIdat();
const PNG_WITH_DECOY_CHUNK_BEFORE_IHDR = buildPngWithDecoyChunkBeforeIhdr(5000, 5000);
const PNG_WITH_DUPLICATE_IHDR = buildPngWithDuplicateIhdr(1, 1, 20_000, 20_000);

/** Codificação hex (maiúscula) que `showText`/`PDFHexString` grava no operador `Tj` para
 * texto puramente ASCII sob fonte padrão WinAnsi — nessa faixa (0x20-0x7E), WinAnsi
 * coincide byte-a-byte com o código do caractere, então o hex glyph-a-glyph bate com o hex
 * latin1 do texto (confirmado por execução direta: `PDFHexString` de "LINE_ONE" via
 * `page.drawText` é literalmente `Buffer.from('LINE_ONE','latin1').toString('hex')`
 * maiúsculo). Técnica local (o `pdf-composer.ts` desenha `Tj` como HEX STRING sob fonte
 * padrão, não como `(<texto>) Tj` literal entre parênteses).
 */
function hexOfAscii(text: string): string {
  return Buffer.from(text, 'latin1').toString('hex').toUpperCase();
}

/**
 * Decodifica o(s) content stream(s) de 1 página e devolve o texto latin1 bruto (hex
 * strings + operadores PDF), para busca de substring hex.
 *
 * `page.node.normalizedEntries()` (usada por `pageXObjectCount`/`pageImage*` abaixo) tem
 * o efeito colateral de `normalize()`: injeta 2 content streams-wrapper (`q`/`Q`, "push/
 * pop graphics state") em volta do conteúdo real, na 1ª vez que QUALQUER acessor
 * normalizado é chamado sobre a página — então `Contents()` pode devolver 1 ou 3 entradas
 * dependendo da ordem de chamadas dos helpers deste arquivo. Os wrappers são
 * `PDFStream`/`PDFContentStream` (não `PDFRawStream` — nunca passaram por save+reload) e
 * seu `getContentsString()` já devolve o operador em texto puro (sem `Filter`, nada a
 * decodificar); o content stream real, publicado por `PDFDocument.save()`, é sempre
 * `PDFRawStream` com `Filter: FlateDecode` (confirmado por execução direta contra o
 * pdf-lib instalado), decodificado via `decodePDFRawStream` (do próprio pdf-lib — sem
 * parser externo). Tratar os 2 tipos cobre a ordem de chamada nos dois sentidos.
 */
function decodedPageContent(doc: PDFDocument, pageIndex: number): string {
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) {
    throw new Error('Contents inesperado: pdf-composer sempre gera 1 content stream por página.');
  }

  let text = '';
  for (let i = 0; i < contents.size(); i++) {
    const resolved = doc.context.lookup(contents.get(i));
    if (resolved instanceof PDFRawStream) {
      text += Buffer.from(decodePDFRawStream(resolved).decode()).toString('latin1');
    } else if (resolved instanceof PDFStream) {
      text += resolved.getContentsString();
    } else {
      throw new Error('Content stream em formato inesperado.');
    }
  }
  return text;
}

/** Nº de XObjects (imagens) nos Recursos de 1 página — 0 = página só-texto. */
function pageXObjectCount(doc: PDFDocument, pageIndex: number): number {
  return doc.getPage(pageIndex).node.normalizedEntries().XObject.keys().length;
}

/** Bytes crus (sem decodificação — `DCTDecode` embute o JPEG original tal qual) do único
 * XObject de imagem de 1 página. */
function pageImageRawBytes(doc: PDFDocument, pageIndex: number): Buffer {
  const xObject = doc.getPage(pageIndex).node.normalizedEntries().XObject;
  const [name] = xObject.keys();
  if (name === undefined) throw new Error('Página sem XObject de imagem.');
  const resolved = doc.context.lookup(xObject.get(name));
  if (!(resolved instanceof PDFRawStream)) throw new Error('XObject não é PDFRawStream.');
  return Buffer.from(resolved.contents);
}

/** `Width`/`Height` (inteiros do dicionário do XObject) do único XObject de imagem de 1
 * página — o que o `pdf-lib` de fato embutiu, não o que a fixture originalmente tinha. */
function pageImageDims(doc: PDFDocument, pageIndex: number): { width: number; height: number } {
  const xObject = doc.getPage(pageIndex).node.normalizedEntries().XObject;
  const [name] = xObject.keys();
  if (name === undefined) throw new Error('Página sem XObject de imagem.');
  const resolved = doc.context.lookup(xObject.get(name));
  if (!(resolved instanceof PDFRawStream)) throw new Error('XObject não é PDFRawStream.');
  const width = resolved.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber();
  const height = resolved.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber();
  if (width === undefined || height === undefined) throw new Error('XObject sem Width/Height.');
  return { width, height };
}

const META: { variant: 'RESUMO'; generatedAt: Date } = {
  variant: 'RESUMO',
  generatedAt: new Date('2026-03-17T08:05:00.000Z'), // "17/03/2026, 05:05:00" — sem "49"
};

/** Mesma data de `META`, Variante diferente — usada pelo teste abaixo que precisa das
 * DUAS variantes reais para provar que o rótulo lê `meta.variant` em vez de uma
 * constante fixa. */
const META_TIRA: { variant: 'TIRA'; generatedAt: Date } = {
  variant: 'TIRA',
  generatedAt: new Date('2026-03-17T08:05:00.000Z'),
};

describe('Fixtures locais são realmente decodíveis (pré-condição, TASK-025-007)', () => {
  it('embedPng aceita o PNG 1×1 construído', async () => {
    const doc = await PDFDocument.create();
    await expect(doc.embedPng(VALID_PNG_1X1)).resolves.toBeDefined();
  });

  it('embedJpg aceita o JPEG 1×1 construído', async () => {
    const doc = await PDFDocument.create();
    await expect(doc.embedJpg(VALID_JPEG_1X1)).resolves.toBeDefined();
  });

  it('os stubs truncados já existentes no repo LANÇAM em embedPng/embedJpg (confirma o motivo de existirem 2 fixtures novas)', async () => {
    const doc = await PDFDocument.create();
    await expect(doc.embedPng(TRUNCATED_PNG_STUB)).rejects.toThrow();
    await expect(doc.embedJpg(TRUNCATED_JPEG_STUB)).rejects.toThrow();
  });
});

describe('buildSummaryPdf — AC-024-002', () => {
  it('desenha CONCEITO→AÇÃO→OBJETO→SÍNTESE em ordem, pulando CONDIÇÃO/EXCEÇÃO vazios, sem diagramação de Quadro', async () => {
    const breakdown = {
      concept: 'CONCEITO_FIXTURE_XPTO',
      action: 'ACAO_FIXTURE_XPTO',
      object: 'OBJETO_FIXTURE_XPTO',
      condition: null,
      exception: null,
      essence: 'SINTESE_FIXTURE_XPTO',
    };

    const buffer = await buildSummaryPdf(breakdown, META);
    const doc = await PDFDocument.load(buffer);

    expect(doc.getPageCount()).toBe(1); // texto corrido curto cabe numa só página
    expect(pageXObjectCount(doc, 0)).toBe(0); // nenhum Quadro/imagem na Variante "resumo"

    const text = decodedPageContent(doc, 0);
    const indices = [
      text.indexOf(hexOfAscii(breakdown.concept)),
      text.indexOf(hexOfAscii(breakdown.action)),
      text.indexOf(hexOfAscii(breakdown.object)),
      text.indexOf(hexOfAscii(breakdown.essence)),
    ];

    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b)); // ordem relativa preservada

    expect(text).not.toContain(hexOfAscii('null'));
  });
});

describe('buildStripPdf — AC-024-003/AC-024-020', () => {
  it('gera exatamente N páginas, na ordem recebida, cada uma com o texto do Quadro e a imagem (quando houver)', async () => {
    const frames: StripFrameForPdf[] = [
      { text: 'QUADRO_UM_COM_PNG', image: { buffer: VALID_PNG_1X1, format: 'PNG' } },
      { text: 'QUADRO_DOIS_COM_JPEG', image: { buffer: VALID_JPEG_1X1, format: 'JPEG' } },
      { text: 'QUADRO_TRES_SEM_IMAGEM', image: null },
    ];

    const buffer = await buildStripPdf(frames, META);
    const doc = await PDFDocument.load(buffer);

    expect(doc.getPageCount()).toBe(frames.length);

    frames.forEach((frame, index) => {
      const text = decodedPageContent(doc, index);
      expect(text).toContain(hexOfAscii(frame.text));

      if (frame.image === null) {
        expect(pageXObjectCount(doc, index)).toBe(0);
      } else {
        expect(pageXObjectCount(doc, index)).toBe(1);
      }
    });
  });
});

describe('buildStripPdf — AC-024-016 (falha de decodificação de imagem não derruba o documento)', () => {
  it('Quadro com imagem corrompida (buffer truncado) cai no caminho só-texto; os demais Quadros continuam intactos', async () => {
    const frames: StripFrameForPdf[] = [
      { text: 'QUADRO_A_IMAGEM_VALIDA', image: { buffer: VALID_PNG_1X1, format: 'PNG' } },
      {
        text: 'QUADRO_B_IMAGEM_CORROMPIDA',
        image: { buffer: TRUNCATED_JPEG_STUB, format: 'JPEG' },
      },
      { text: 'QUADRO_C_SEM_IMAGEM', image: null },
    ];

    const buffer = await buildStripPdf(frames, META); // NÃO deve lançar

    const doc = await PDFDocument.load(buffer);
    expect(doc.getPageCount()).toBe(3);

    expect(pageXObjectCount(doc, 0)).toBe(1); // Quadro A: imagem válida embutida
    expect(pageXObjectCount(doc, 1)).toBe(0); // Quadro B: corrompida → mesmo caminho "só texto"
    expect(pageXObjectCount(doc, 2)).toBe(0); // Quadro C: já era "sem imagem"

    expect(decodedPageContent(doc, 1)).toContain(hexOfAscii('QUADRO_B_IMAGEM_CORROMPIDA'));
  });
});

describe('buildStripPdf — teto de pixels/APNG recusados ANTES do decode (NFR-024-004, gate 8)', () => {
  it('PNG com cabeçalho declarando dimensão acima do teto (~20MP) é recusado por LEITURA DE CABEÇALHO — nunca chega a embedPng', async () => {
    const frames: StripFrameForPdf[] = [
      {
        text: 'QUADRO_CABECALHO_GIGANTE',
        image: { buffer: PNG_WITH_OVERSIZED_HEADER, format: 'PNG' },
      },
    ];
    const skipped: ImageSkippedInfo[] = [];

    const buffer = await buildStripPdf(frames, META, (info) => skipped.push(info)); // NÃO deve lançar

    const doc = await PDFDocument.load(buffer);
    expect(doc.getPageCount()).toBe(1);
    expect(pageXObjectCount(doc, 0)).toBe(0); // caminho "só texto"
    expect(decodedPageContent(doc, 0)).toContain(hexOfAscii('QUADRO_CABECALHO_GIGANTE'));

    // O motivo prova QUAL checagem recusou: se o teto de pixels não tivesse rodado antes
    // do embed, este buffer (sem IDAT/IEND) teria sido rejeitado por `embedPng` mesmo
    // assim, mas com reason 'decode-failed' — nunca 'pixel-budget-exceeded'.
    expect(skipped).toEqual([{ frameIndex: 0, format: 'PNG', reason: 'pixel-budget-exceeded' }]);
  });

  it('PNG com chunk acTL (APNG) é recusado antes do decode, mesmo sendo um PNG 1×1 válido no restante', async () => {
    const frames: StripFrameForPdf[] = [
      { text: 'QUADRO_ANTES', image: null },
      { text: 'QUADRO_APNG', image: { buffer: PNG_WITH_ACTL_CHUNK, format: 'PNG' } },
    ];
    const skipped: ImageSkippedInfo[] = [];

    const buffer = await buildStripPdf(frames, META, (info) => skipped.push(info));

    const doc = await PDFDocument.load(buffer);
    expect(doc.getPageCount()).toBe(2);
    expect(pageXObjectCount(doc, 1)).toBe(0);
    expect(skipped).toEqual([{ frameIndex: 1, format: 'PNG', reason: 'apng-not-supported' }]);
  });

  it('onImageSkipped é opcional — omitir o 3º argumento mantém o comportamento idêntico (retrocompatível)', async () => {
    const frames: StripFrameForPdf[] = [
      { text: 'QUADRO_SEM_CALLBACK', image: { buffer: PNG_WITH_OVERSIZED_HEADER, format: 'PNG' } },
    ];

    await expect(buildStripPdf(frames, META)).resolves.toBeInstanceOf(Buffer);
  });

  it('PNG com chunk decoy (tEXt) antes do IHDR real cai no caminho só-texto — NUNCA chega a CHAMAR embedPng, mesmo com o teto de pixels no lugar', async () => {
    // Espiona o método real de `pdf-lib` (sem mockImplementation — o spy só observa,
    // continua chamando através) para provar "nunca chamado" de forma direta, em vez de
    // inferir isso indiretamente pelo resultado — um fixture incompleto por outro motivo
    // (ex.: sem IDAT) faria `embedPng` falhar de qualquer jeito, mascarando se a checagem
    // de estrutura BARROU antes ou se só o decode real por acaso também rejeitou.
    const embedPngSpy = jest.spyOn(PDFDocument.prototype, 'embedPng');

    const frames: StripFrameForPdf[] = [
      {
        text: 'QUADRO_PNG_FORJADO',
        image: { buffer: PNG_WITH_DECOY_CHUNK_BEFORE_IHDR, format: 'PNG' },
      },
    ];
    const skipped: ImageSkippedInfo[] = [];

    const buffer = await buildStripPdf(frames, META, (info) => skipped.push(info)); // NÃO deve lançar, NÃO deve estourar heap

    const doc = await PDFDocument.load(buffer); // PDFDocument.load NÃO chama embedPng — não interfere no spy
    expect(pageXObjectCount(doc, 0)).toBe(0);
    // 'decode-failed': readImageDimensions recusou o arquivo inteiro (null) ANTES de
    // qualquer teto de pixels ser calculado — nem a leitura por offset (decoy = "1×1")
    // nem o IHDR forjado (5000×5000) chegam a produzir um resultado "pixel-budget-exceeded".
    expect(skipped).toEqual([{ frameIndex: 0, format: 'PNG', reason: 'decode-failed' }]);
    expect(embedPngSpy).not.toHaveBeenCalled();

    embedPngSpy.mockRestore();
  });

  it('PNG com IHDR DUPLICADO (1×1 seguido de 20000×20000) cai no caminho só-texto — NUNCA chega a CHAMAR embedPng', async () => {
    const embedPngSpy = jest.spyOn(PDFDocument.prototype, 'embedPng');

    const frames: StripFrameForPdf[] = [
      { text: 'QUADRO_IHDR_DUPLICADO', image: { buffer: PNG_WITH_DUPLICATE_IHDR, format: 'PNG' } },
    ];
    const skipped: ImageSkippedInfo[] = [];

    const buffer = await buildStripPdf(frames, META, (info) => skipped.push(info)); // NÃO deve lançar, NÃO deve estourar heap

    const doc = await PDFDocument.load(buffer);
    expect(pageXObjectCount(doc, 0)).toBe(0);
    // 'decode-failed': readImageDimensions recusou o arquivo inteiro (null, 2 IHDR não é
    // válido) — nem o 1×1 (1º IHDR) nem o 20000×20000 (2º IHDR, o que o decoder real
    // usaria) chegam a produzir uma dimensão aceita.
    expect(skipped).toEqual([{ frameIndex: 0, format: 'PNG', reason: 'decode-failed' }]);
    expect(embedPngSpy).not.toHaveBeenCalled();

    embedPngSpy.mockRestore();
  });

  it('PNG com IHDR válido (dentro do teto, sem acTL) mas IDAT corrompido ainda cai no caminho só-texto — o try/catch em torno de embedPng continua vivo depois das checagens novas', async () => {
    const frames: StripFrameForPdf[] = [
      { text: 'QUADRO_IDAT_CORROMPIDO', image: { buffer: PNG_WITH_CORRUPT_IDAT, format: 'PNG' } },
    ];
    const skipped: ImageSkippedInfo[] = [];

    const buffer = await buildStripPdf(frames, META, (info) => skipped.push(info)); // NÃO deve lançar

    const doc = await PDFDocument.load(buffer);
    expect(pageXObjectCount(doc, 0)).toBe(0);
    // Mesma string 'decode-failed' do stub truncado, mas alcançada por um caminho
    // DIFERENTE (o `catch` do embed em si, não a checagem de dimensão) — a prova real é
    // de mutação: remover o `try/catch` faz ESTE caso (não o do stub truncado) rejeitar.
    expect(skipped).toEqual([{ frameIndex: 0, format: 'PNG', reason: 'decode-failed' }]);
  });
});

describe('Exceção de page.drawText(...) sobre o texto principal NÃO é engolida pelo try/catch de imagem', () => {
  const OUT_OF_WINANSI_TEXT = 'Texto com emoji fora de WinAnsi \u{1F680}';

  it('buildStripPdf rejeita (nunca devolve Buffer parcial) mesmo com imagem válida no mesmo Quadro', async () => {
    const frames: StripFrameForPdf[] = [
      { text: OUT_OF_WINANSI_TEXT, image: { buffer: VALID_PNG_1X1, format: 'PNG' } },
    ];

    await expect(buildStripPdf(frames, META)).rejects.toThrow();
  });

  it('buildSummaryPdf rejeita quando um Bloco contém caractere fora de WinAnsi', async () => {
    const breakdown = {
      concept: OUT_OF_WINANSI_TEXT,
      action: 'ACAO',
      object: 'OBJETO',
      condition: null,
      exception: null,
      essence: 'SINTESE',
    };

    await expect(buildSummaryPdf(breakdown, META)).rejects.toThrow();
  });
});

describe('buildStripPdf/buildSummaryPdf — AC-024-005 (rótulo de rascunho + geração em TODA página)', () => {
  it('buildStripPdf: rótulo de rascunho e "Gerado em:" aparecem em TODAS as N páginas (N >= 2), sem texto de fechamento/aprovação', async () => {
    const frames: StripFrameForPdf[] = [
      { text: 'QUADRO_UM', image: null },
      { text: 'QUADRO_DOIS', image: null },
    ];

    const buffer = await buildStripPdf(frames, META);
    const doc = await PDFDocument.load(buffer);
    expect(doc.getPageCount()).toBe(2);

    for (let i = 0; i < doc.getPageCount(); i++) {
      const text = decodedPageContent(doc, i);
      expect(text).toContain(hexOfAscii('RASCUNHO'));
      expect(text).toContain(hexOfAscii('Gerado em:'));
      expect(text).toContain(hexOfAscii('17/03/2026'));
      expect(text).not.toContain(hexOfAscii('fechamento'));
      expect(text).not.toContain(hexOfAscii('aprova')); // cobre aprovação/aprovada/aprovado
    }
  });

  it('buildSummaryPdf: texto longo o bastante para transbordar 2+ páginas também exibe o rótulo em TODAS elas', async () => {
    const longEssence = Array.from({ length: 1500 }, () => 'palavra').join(' ');
    const breakdown = {
      concept: 'CONCEITO',
      action: 'ACAO',
      object: 'OBJETO',
      condition: null,
      exception: null,
      essence: longEssence,
    };

    const buffer = await buildSummaryPdf(breakdown, META);
    const doc = await PDFDocument.load(buffer);

    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2); // prova que o transbordo realmente ocorreu

    for (let i = 0; i < doc.getPageCount(); i++) {
      const text = decodedPageContent(doc, i);
      expect(text).toContain(hexOfAscii('RASCUNHO'));
      expect(text).toContain(hexOfAscii('Gerado em:'));
    }
  });

  it('o rótulo nomeia a Variante lida de meta.variant — TIRA em buildStripPdf, RESUMO em buildSummaryPdf, PÁGINA A PÁGINA (mutante que fixasse uma constante morre)', async () => {
    const stripBuffer = await buildStripPdf(
      [
        { text: 'QUADRO_UM', image: null },
        { text: 'QUADRO_DOIS', image: null },
      ],
      META_TIRA,
    );
    const stripDoc = await PDFDocument.load(stripBuffer);
    expect(stripDoc.getPageCount()).toBe(2);
    for (let i = 0; i < stripDoc.getPageCount(); i++) {
      const text = decodedPageContent(stripDoc, i);
      expect(text).toContain(hexOfAscii('TIRA'));
      expect(text).not.toContain(hexOfAscii('RESUMO'));
    }

    const summaryBuffer = await buildSummaryPdf(
      {
        concept: 'CONCEITO',
        action: 'ACAO',
        object: 'OBJETO',
        condition: null,
        exception: null,
        essence: 'SINTESE',
      },
      META, // META.variant === 'RESUMO'
    );
    const summaryDoc = await PDFDocument.load(summaryBuffer);
    const summaryText = decodedPageContent(summaryDoc, 0);
    expect(summaryText).toContain(hexOfAscii('RESUMO'));
    expect(summaryText).not.toContain(hexOfAscii('TIRA'));
  });
});

describe('buildStripPdf/buildSummaryPdf — AC-024-010 (postura de segurança, comportamental)', () => {
  it('texto "hostil" tipo template/marcação sai LITERAL, nunca avaliado, e fetch nunca é chamado', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('rede chamada');
    });

    const hostileMustache = '{{ 7 * 7 }}';
    const hostileEjs = '<%= 7*7 %>';

    const summaryBuffer = await buildSummaryPdf(
      {
        concept: hostileMustache,
        action: 'ACAO',
        object: 'OBJETO',
        condition: null,
        exception: null,
        essence: 'SINTESE',
      },
      META,
    );
    const summaryDoc = await PDFDocument.load(summaryBuffer);
    const summaryText = decodedPageContent(summaryDoc, 0);
    expect(summaryText).toContain(hexOfAscii(hostileMustache));
    expect(summaryText).not.toContain(hexOfAscii('49')); // nunca "7 * 7" avaliado

    const stripBuffer = await buildStripPdf([{ text: hostileEjs, image: null }], META);
    const stripDoc = await PDFDocument.load(stripBuffer);
    const stripText = decodedPageContent(stripDoc, 0);
    expect(stripText).toContain(hexOfAscii(hostileEjs));
    expect(stripText).not.toContain(hexOfAscii('49'));

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('buildStripPdf — AC-024-011 (imagem usada exatamente como recebida, NFR-024-004)', () => {
  it('JPEG: o stream DCTDecode embutido é byte-a-byte idêntico ao JPEG de fixture original', async () => {
    const buffer = await buildStripPdf(
      [{ text: 'QUADRO_JPEG', image: { buffer: VALID_JPEG_1X1, format: 'JPEG' } }],
      META,
    );
    const doc = await PDFDocument.load(buffer);

    const embedded = pageImageRawBytes(doc, 0);
    expect(Buffer.compare(embedded, VALID_JPEG_1X1)).toBe(0);
  });

  it('PNG: a imagem embutida tem as MESMAS dimensões intrínsecas do cabeçalho IHDR da fixture (sem redimensionar)', async () => {
    // Lidas do PRÓPRIO buffer de fixture (bytes 16-23, big-endian), nunca hardcoded — não
    // pode coincidir por acaso com o que o `pdf-lib` embutiu.
    const ihdrWidth = VALID_PNG_1X1.readUInt32BE(16);
    const ihdrHeight = VALID_PNG_1X1.readUInt32BE(20);

    const buffer = await buildStripPdf(
      [{ text: 'QUADRO_PNG', image: { buffer: VALID_PNG_1X1, format: 'PNG' } }],
      META,
    );
    const doc = await PDFDocument.load(buffer);

    const { width, height } = pageImageDims(doc, 0);
    expect(width).toBe(ihdrWidth);
    expect(height).toBe(ihdrHeight);
  });
});

describe('buildStripPdf — buffer pool-backed não pode sumir silenciosamente (AC-024-003, ArrayBuffer não-exato do pdf-lib)', () => {
  it('JPEG construído do jeito que a produção constrói (pool-backed, byteOffset !== 0, NÃO normalizado a priori) ainda é embutido — 1 XObject, conteúdo byte-a-byte idêntico', async () => {
    const poolBackedJpeg = buildValidJpeg1x1PoolBacked();
    expect(poolBackedJpeg.byteOffset).not.toBe(0); // confirma a pré-condição do teste

    const skipped: ImageSkippedInfo[] = [];
    const buffer = await buildStripPdf(
      [{ text: 'QUADRO_JPEG_POOL_BACKED', image: { buffer: poolBackedJpeg, format: 'JPEG' } }],
      META,
      (info) => skipped.push(info),
    );
    const doc = await PDFDocument.load(buffer);

    expect(skipped).toEqual([]); // NÃO pode ter caído no caminho "só texto"
    expect(pageXObjectCount(doc, 0)).toBe(1);

    // NFR-024-004 continua valendo: o CONTEÚDO embutido é idêntico byte-a-byte ao
    // original — só o ArrayBuffer subjacente do argumento mudou, nunca os bytes.
    const embedded = pageImageRawBytes(doc, 0);
    expect(Buffer.compare(embedded, poolBackedJpeg)).toBe(0);
  });
});

describe('Postura estrutural de pdf-composer.ts (NFR-024-001/002/004, gate 1)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/modules/publication/pdf-composer.ts'),
    'utf-8',
  );
  const nonCommentLines = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join('\n');

  /** Presente de verdade no arquivo (`import { PageSizes, PDFDocument, StandardFonts }
   * from 'pdf-lib'`) — controle positivo repetido em CADA prova de ausência abaixo: se
   * `nonCommentLines` estivesse vazio/corrompido por um bug de path ou de filtro, toda
   * prova de ausência passaria por acidente (grep vazio nunca acha nada). */
  const POSITIVE_CONTROL = "from 'pdf-lib'";

  /** `require('mod')`, `require('node:mod')`, `from 'mod'` e `from 'node:mod'` — as 4
   * formas pelas quais um import da stdlib pode aparecer; um grep que só cobrisse
   * `http`/`https`/`net`/`dns` sem o prefixo `node:` deixaria `from 'node:https'` passar
   * despercebido. */
  function importsModule(text: string, moduleName: string): boolean {
    const pattern = new RegExp(
      `require\\(\\s*['"](?:node:)?${moduleName}['"]\\s*\\)|from\\s+['"](?:node:)?${moduleName}['"]`,
    );
    return pattern.test(text);
  }

  const NETWORK_MODULES = ['http', 'https', 'net', 'dns'];
  const PROCESS_ESCAPE_MODULES = ['fs', 'child_process'];

  it('nenhuma chamada/identificador de rede fora de comentário — cobre especificador node: (NFR-024-001)', () => {
    expect(nonCommentLines).toContain(POSITIVE_CONTROL);

    const networkCallPattern = /fetch\(|axios|XMLHttpRequest|new WebSocket/i;
    expect(networkCallPattern.test(nonCommentLines)).toBe(false);
    for (const moduleName of NETWORK_MODULES) {
      expect(importsModule(nonCommentLines, moduleName)).toBe(false);
    }
  });

  it('nenhuma escrita de I/O parcial fora de comentário — Buffer só via PDFDocument.save() ao final, cobre especificador node: (fs/child_process)', () => {
    expect(nonCommentLines).toContain(POSITIVE_CONTROL);

    const partialWritePattern = /\bfs\.|createWriteStream|res\.write|child_process/;
    expect(partialWritePattern.test(nonCommentLines)).toBe(false);
    for (const moduleName of PROCESS_ESCAPE_MODULES) {
      expect(importsModule(nonCommentLines, moduleName)).toBe(false);
    }
  });

  it('nenhum redimensionamento/recompressão de imagem fora de comentário (NFR-024-004)', () => {
    expect(nonCommentLines).toContain(POSITIVE_CONTROL);

    const resizePattern = /\bsharp\(|\bjimp\b/i;
    expect(resizePattern.test(nonCommentLines)).toBe(false);
  });

  it('controle positivo do detector: importsModule() ACHA "node:https" (e as demais) quando plantado — prova que o grep não está vazio por acidente', () => {
    for (const moduleName of [...NETWORK_MODULES, ...PROCESS_ESCAPE_MODULES]) {
      const planted = `import { x } from 'node:${moduleName}';\n${nonCommentLines}`;
      expect(importsModule(planted, moduleName)).toBe(true);

      const plantedRequire = `const x = require('node:${moduleName}');\n${nonCommentLines}`;
      expect(importsModule(plantedRequire, moduleName)).toBe(true);
    }
  });
});
