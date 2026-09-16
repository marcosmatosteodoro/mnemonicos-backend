import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prova ESTRUTURAL (leitura textual, sem AST — mesmo mecanismo de
 * `tira.service.guard-order.test.ts`) de que `assertRawContentReachable` é a
 * 1ª chamada dentro do corpo de CADA uma das 4 funções de
 * `contrasts.service.ts` (`createContrast`/`listContrasts`/`updateContrast`/
 * `removeContrast`), e que `updateContrast`/`removeContrast` avaliam
 * `actor.role === 'ADMIN' || existing.authorId === actor.id` só DEPOIS de ler
 * a linha do Contraste e ANTES de qualquer `update`/`delete` (TASK-027-003,
 * PLAN §6 DEC-027-005) — 1 teste por função (4 no total), cada um cobrindo
 * as duas checagens que se aplicam a ela. A prova COMPORTAMENTAL completa
 * (EDITOR não alcança `RawContent` de outro autor; autor-ou-ADMIN na
 * escrita) vive em `contrasts.service.integration.test.ts` — não duplicada
 * aqui.
 */
const CONTRASTS_SERVICE = resolve(__dirname, '../../src/modules/contrasts/contrasts.service.ts');

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Extrai o corpo de uma função pelo casamento de chaves balanceadas — mesmo
 * mecanismo de `tira.service.guard-order.test.ts`. `requiredAnchor` é um
 * CONTROLE POSITIVO obrigatório: se o extrator mirar o alvo errado, a
 * extração falha alto em vez de devolver um trecho vazio/errado sobre o qual
 * as asserções de ordem abaixo passariam verdes sem provar nada.
 */
function extractFunctionBody(
  source: string,
  signatureAnchor: string,
  requiredAnchor: string,
): string {
  const anchorIndex = source.indexOf(signatureAnchor);
  if (anchorIndex === -1) {
    throw new Error(`assinatura não encontrada: ${signatureAnchor}`);
  }

  const openParenIndex = source.indexOf('(', anchorIndex);
  if (openParenIndex === -1) {
    throw new Error(`lista de parâmetros não encontrada: ${signatureAnchor}`);
  }

  let parenDepth = 0;
  let afterParamsIndex = -1;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') parenDepth += 1;
    else if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        afterParamsIndex = i + 1;
        break;
      }
    }
  }
  if (afterParamsIndex === -1) {
    throw new Error(`lista de parâmetros não fechada: ${signatureAnchor}`);
  }

  const openBraceIndex = source.indexOf('{', afterParamsIndex);
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
        const body = source.slice(openBraceIndex + 1, i);
        if (!body.includes(requiredAnchor)) {
          throw new Error(
            `controle positivo falhou: corpo extraído de "${signatureAnchor}" não contém ` +
              `"${requiredAnchor}" — o extrator pode ter mirado o alvo errado`,
          );
        }
        return body;
      }
    }
  }
  throw new Error(`chave de fechamento não encontrada: ${signatureAnchor}`);
}

/**
 * A 1ª linha EXECUTÁVEL do corpo: descarta comentário/linha vazia e também a
 * linha que só ABRE um escopo aninhado (`return db.$transaction(async (tx) =>
 * {`) — essa linha não é, ela mesma, uma chamada de guarda, é o envelope da
 * transação em que a guarda roda.
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

  const isScopeOpener = (line: string): boolean =>
    line.endsWith('=> {') || line.endsWith(') {') || line === 'try {';

  const line = lines.find((candidate) => !isScopeOpener(candidate));
  if (line === undefined) {
    throw new Error('nenhuma linha executável encontrada no corpo da função');
  }
  return line;
}

/** Âncora de controle positivo do corpo de cada função — distinta do que está sendo provado. */
const REQUIRED_ANCHOR: Record<string, string> = {
  createContrast: '.$transaction(',
  listContrasts: 'contrast.findMany(',
  updateContrast: '.$transaction(',
  removeContrast: '.$transaction(',
};

/** Âncora textual da escrita final de `updateContrast`/`removeContrast` — `null` para `createContrast`/`listContrasts` (sem guarda autor-ou-ADMIN). */
const WRITE_ANCHOR: Record<string, string | null> = {
  createContrast: null,
  listContrasts: null,
  updateContrast: 'contrast.update(',
  removeContrast: 'contrast.delete(',
};

describe.each([
  ['createContrast', 'export async function createContrast'],
  ['listContrasts', 'export async function listContrasts'],
  ['updateContrast', 'export async function updateContrast'],
  ['removeContrast', 'export async function removeContrast'],
])('%s — ordem das guardas (TASK-027-003, estrutural)', (name, signatureAnchor) => {
  it('assertRawContentReachable é a 1ª chamada; quando aplicável, autor-ou-ADMIN roda depois da leitura do Contraste e antes da escrita', () => {
    const source = readSource(CONTRASTS_SERVICE);
    const body = extractFunctionBody(source, signatureAnchor, REQUIRED_ANCHOR[name]!);
    const line = firstExecutableLine(body);

    // Mutante: mover qualquer leitura/checagem para ANTES de
    // `assertRawContentReachable` faz esta asserção reprovar — a guarda de
    // alcance por autoria do `RawContent` pai deixaria de ser a 1ª barreira.
    expect(line).toContain('assertRawContentReachable(');

    const writeAnchor = WRITE_ANCHOR[name];
    if (writeAnchor == null) return;

    const readIndex = body.indexOf('contrast.findUnique(');
    const guardIndex = body.indexOf("actor.role !== 'ADMIN'");
    const writeIndex = body.indexOf(writeAnchor);

    expect(readIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(-1);

    // Mutante: mover a checagem `actor.role/authorId` para ANTES da leitura
    // (`contrast.findUnique`) ou para DEPOIS da escrita (`contrast.update`/
    // `contrast.delete`) faz esta asserção reprovar — o autor-ou-ADMIN
    // deixaria de ser checado no ponto exigido pela TASK.
    expect(readIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(writeIndex);
  });
});
