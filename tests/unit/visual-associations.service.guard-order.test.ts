import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prova ESTRUTURAL (leitura textual, sem AST — mesmo mecanismo de
 * `tira.service.guard-order.test.ts`) de que `assertVisualAssociationWritable`
 * (guarda de escrita, DEC-023-006) roda ANTES de qualquer escrita
 * (`tx.visualAssociation.update(`/`tx.visualAssociation.deleteMany(`) dentro do corpo da
 * `$transaction` de `updateVisualAssociation`/`removeVisualAssociation`. Diferente do
 * molde de `tira.service.ts` (`assertRawContentReachable` é autocontida, faz sua
 * própria leitura e é literalmente a 1ª linha executável), `assertVisualAssociationWritable`
 * é PURA — precisa da linha já lida (`findUnique`) para receber `authorId` — então a
 * leitura antecede a guarda por necessidade; o invariante de segurança real é "nenhuma
 * escrita antes da guarda", provado aqui pela ORDEM textual dos dois pontos de
 * referência, **por método** (lição "[Segurança] Guarda reusada continua exigindo prova
 * comportamental própria por novo método de escrita" — este teste é o complemento
 * ESTRUTURAL/de ordem; a prova comportamental de negação por autoria de
 * `removeVisualAssociation` é `visual-associations.routes.integration.test.ts`).
 *
 * `createVisualAssociation` não tem guarda de autoria (não edita linha
 * existente) — fora do escopo desta prova.
 */
const VISUAL_ASSOCIATIONS_SERVICE = resolve(
  __dirname,
  '../../src/modules/visual-associations/visual-associations.service.ts',
);

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Casamento de chaves balanceadas — corpo pode conter bloco aninhado (`if`, `$transaction`). */
function extractFunctionBody(source: string, signatureAnchor: string): string {
  const anchorIndex = source.indexOf(signatureAnchor);
  if (anchorIndex === -1) {
    throw new Error(`assinatura não encontrada: ${signatureAnchor}`);
  }

  const openBraceIndex = source.indexOf('{', anchorIndex);
  if (openBraceIndex === -1) {
    throw new Error(`corpo da função não encontrado: ${signatureAnchor}`);
  }

  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }
  throw new Error(`chave de fechamento não encontrada: ${signatureAnchor}`);
}

describe('updateVisualAssociation — assertVisualAssociationWritable roda ANTES de qualquer escrita (DEC-023-006, estrutural)', () => {
  it('o índice textual de `assertVisualAssociationWritable(` precede o de `tx.visualAssociation.update(` dentro do corpo da função', () => {
    const source = readSource(VISUAL_ASSOCIATIONS_SERVICE);
    const body = extractFunctionBody(source, 'export async function updateVisualAssociation');

    const guardIndex = body.indexOf('assertVisualAssociationWritable(');
    const writeIndex = body.indexOf('tx.visualAssociation.update(');

    // Mutante: remover a chamada da guarda faz `guardIndex` virar -1 (reprova pelo
    // `toBeGreaterThan(-1)`); mover a guarda para DEPOIS do `update` (ou removê-la
    // do corpo, deixando só o `findUnique`+`update`) faz `guardIndex > writeIndex`,
    // reprovando a comparação abaixo.
    expect(guardIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(writeIndex);
  });
});

describe('removeVisualAssociation — assertVisualAssociationWritable roda ANTES de qualquer escrita (DEC-023-006, estrutural)', () => {
  it('o índice textual de `assertVisualAssociationWritable(` precede o de `tx.visualAssociation.deleteMany(` dentro do corpo da função', () => {
    const source = readSource(VISUAL_ASSOCIATIONS_SERVICE);
    const body = extractFunctionBody(source, 'export async function removeVisualAssociation');

    const guardIndex = body.indexOf('assertVisualAssociationWritable(');
    const writeIndex = body.indexOf('tx.visualAssociation.deleteMany(');

    // Mutante: remover a chamada da guarda faz `guardIndex` virar -1 (reprova pelo
    // `toBeGreaterThan(-1)`); mover a guarda para DEPOIS do `deleteMany` (ou removê-la
    // do corpo, deixando só o `findUnique`+`deleteMany`) faz `guardIndex > writeIndex`,
    // reprovando a comparação abaixo.
    expect(guardIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(writeIndex);
  });
});
