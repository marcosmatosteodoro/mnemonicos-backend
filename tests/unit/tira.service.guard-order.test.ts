import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prova ESTRUTURAL (leitura textual, sem AST — mesmo mecanismo de
 * `extractInterfaceFields` de `contents-frontend-contract.test.ts`,
 * generalizado para corpo de FUNÇÃO em vez de interface) de que
 * `assertRawContentReachable` é a 1ª chamada dentro do corpo de
 * `reorderMnemonicFrames` (AC-011-020, AC-011-022, parte estrutural,
 * TASK-012-006). A prova COMPORTAMENTAL completa de alcance (EDITOR não
 * alcança Tira de outro EDITOR; soft-delete torna inalcançável) já foi feita
 * em TASK-012-005 sobre `openMnemonicStrip` — não duplicada aqui.
 */
const TIRA_SERVICE = resolve(__dirname, '../../src/modules/tira/tira.service.ts');

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Extrai o corpo de uma função pelo casamento de chaves balanceadas — ao
 * contrário de `extractInterfaceFields` (corpo flat, sem chave aninhada),
 * corpo de função contém `{`/`}` aninhados (bloco da `$transaction`, `if`),
 * então a extração precisa contar profundidade em vez de parar na 1ª `\n}`.
 */
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

/**
 * A 1ª linha EXECUTÁVEL do corpo: descarta comentário/linha vazia e também a
 * linha que só ABRE um escopo aninhado (`return db.$transaction(async (tx) =>
 * {`) — essa linha não é, ela mesma, uma chamada de guarda, é o envelope da
 * transação em que a guarda roda (mesmo padrão de `saveRuleBreakdown`/
 * `openMnemonicStrip`, já mergeados).
 */
function firstExecutableLine(body: string): string {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('//') &&
        !line.startsWith('*') &&
        !line.startsWith('/*'),
    );

  const isScopeOpener = (line: string): boolean => line.endsWith('=> {') || line.endsWith(') {');

  const line = lines.find((candidate) => !isScopeOpener(candidate));
  if (line === undefined) {
    throw new Error('nenhuma linha executável encontrada no corpo da função');
  }
  return line;
}

describe('reorderMnemonicFrames — assertRawContentReachable é a 1ª chamada (AC-011-020, AC-011-022, estrutural)', () => {
  it('a 1ª linha executável do corpo (ignorando comentário e a abertura de `$transaction`) contém `assertRawContentReachable(`', () => {
    const source = readSource(TIRA_SERVICE);
    const body = extractFunctionBody(source, 'export async function reorderMnemonicFrames');
    const line = firstExecutableLine(body);

    // Mutante: mover a validação do `order` (ou a busca de `stripId`) para
    // ANTES de `assertRawContentReachable` faz esta asserção reprovar — a
    // guarda de alcance por autoria deixaria de ser a 1ª barreira.
    expect(line).toContain('assertRawContentReachable(');
  });
});
