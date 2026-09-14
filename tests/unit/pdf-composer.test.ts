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
import type { StripFrameForPdf } from '../../src/modules/publication/pdf-composer';

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
function buildValidJpeg1x1(): Buffer {
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

  return toStandaloneBuffer(
    Buffer.concat([soi, app0, dqt, sof0, dhtDc, dhtAc, sos, scanData, eoi]),
  );
}

const VALID_PNG_1X1 = buildValidPng1x1();
const VALID_JPEG_1X1 = buildValidJpeg1x1();

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

describe('Postura estrutural de pdf-composer.ts (NFR-024-001/002/004, gate 1)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/modules/publication/pdf-composer.ts'),
    'utf-8',
  );
  const nonCommentLines = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join('\n');

  it('nenhuma chamada/identificador de rede fora de comentário (NFR-024-001)', () => {
    const networkPattern =
      /fetch\(|axios|XMLHttpRequest|new WebSocket|require\([^)]*(http|https|net|dns)|from ['"](http|https|net|dns)/i;
    expect(networkPattern.test(nonCommentLines)).toBe(false);
  });

  it('nenhuma escrita de I/O parcial fora de comentário — Buffer só via PDFDocument.save() ao final', () => {
    const partialWritePattern = /\bfs\.|createWriteStream|res\.write/;
    expect(partialWritePattern.test(nonCommentLines)).toBe(false);
  });

  it('nenhum redimensionamento/recompressão de imagem fora de comentário (NFR-024-004)', () => {
    const resizePattern = /\bsharp\(|\bjimp\b/i;
    expect(resizePattern.test(nonCommentLines)).toBe(false);
  });
});
