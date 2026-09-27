import { PDFArray, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';

/**
 * Extração de texto de PDF para testes de integração de `publication.service.ts` — mesma
 * técnica de `tests/unit/pdf-composer.test.ts` (padrão local daquele arquivo, não
 * exportado).
 */

/**
 * Diferenças de Windows-1252 (cp1252, a codificação que `WinAnsiEncoding` do `pdf-lib` usa
 * para desenhar `Tj`) em relação a ISO-8859-1/Latin-1 — só a faixa 0x80-0x9F diverge.
 * Necessário porque `Buffer.from(text, 'latin1')` do Node trunca qualquer code point fora
 * de 0-255 para o byte baixo, o que corrompe caracteres como "—" (em dash, U+2014): o
 * Protocolo impresso (`review-protocol.ts`) o usa no rótulo, e o byte NAIVE (0x14) nunca
 * bateria com o byte que a fonte WinAnsi de fato grava (0x97).
 */
const CP1252_HIGH_RANGE: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Codificação hex (maiúscula) que `showText`/`PDFHexString` grava no operador `Tj` para
 * texto sob fonte padrão WinAnsi (`page.drawText` do `pdf-composer.ts` desenha `Tj` como
 * hex string, não como `(<texto>) Tj` literal) — cp1252, não Latin-1 puro (ver
 * `CP1252_HIGH_RANGE` acima). */
export function hexOfAscii(text: string): string {
  const bytes = Array.from(text, (ch) => {
    const codePoint = ch.codePointAt(0)!;
    return CP1252_HIGH_RANGE[codePoint] ?? codePoint & 0xff;
  });
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

/** Decodifica o(s) content stream(s) de 1 página e devolve o texto latin1 bruto (hex
 * strings + operadores PDF), para busca de substring hex — ver
 * `tests/unit/pdf-composer.test.ts` para a explicação completa dos 2 tipos de stream
 * (`PDFRawStream` pós-`save()`/`load()`, `PDFStream` normalizado antes disso). */
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

/** Texto decodificado de TODAS as páginas do documento, concatenado na ordem das
 * páginas — usado quando o teste não sabe (nem precisa saber) em qual página exata do
 * documento FUNDIDO (principal + suplementar, DEC-027-006) 1 seção específica caiu. */
export function decodedDocumentText(doc: PDFDocument): string {
  let text = '';
  for (let i = 0; i < doc.getPageCount(); i++) {
    text += decodedPageContent(doc, i);
  }
  return text;
}

/** Texto decodificado de CADA página do documento, 1 string POR página (nunca
 * concatenado, TASK-029-003) — pré-requisito mecânico de qualquer critério "toda página"
 * (ex.: AC-028-009/010/011/013): um teste que só olhasse `decodedDocumentText` não
 * distinguiria "aparece em 1 página" de "aparece em TODAS", porque a concatenação apaga a
 * fronteira entre páginas. */
export function decodedPageTexts(doc: PDFDocument): string[] {
  const texts: string[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    texts.push(decodedPageContent(doc, i));
  }
  return texts;
}
