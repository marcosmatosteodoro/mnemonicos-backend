import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prova ESTRUTURAL (leitura textual, mesmo mecanismo de
 * `contrasts.service.guard-order.test.ts`) da ORDEM exigida dentro do corpo
 * de `closeContentVersion` (TASK-029-002, PLAN §6 DEC-029-004/DEC-029-001):
 *
 *   (a) `tx.$queryRaw` com `FOR UPDATE` é a 1ª chamada do corpo — universo é o
 *       corpo INTEIRO da função, antes de qualquer outra chamada a `tx`/
 *       `assertRawContentReachable`;
 *   (b) `assertRawContentReachable(` aparece ANTES da leitura de detalhe de
 *       `RawContent` que alimenta a checagem `actor.role === 'ADMIN' ||`;
 *   (c) a leitura de `RuleBreakdown` acontece ANTES de
 *       `tx.contentVersion.findFirst`/`create`;
 *   (d) `recordProductionStageEvent(` é a ÚLTIMA chamada do corpo, depois de
 *       `tx.contentVersion.create`.
 *
 * Prova COMPORTAMENTAL completa (guarda de alcance recusando B, autor-ou-ADMIN,
 * fail-secure, corrida real) vive em `content-versions.service.integration.test.ts`
 * — não duplicada aqui (lição ativa "[Segurança] Guarda reusada continua
 * exigindo prova comportamental própria por novo método de escrita").
 */
const CONTENT_VERSIONS_SERVICE = resolve(
  __dirname,
  '../../src/modules/content-versions/content-versions.service.ts',
);

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Extrai o corpo de `closeContentVersion` por casamento de chaves balanceadas. */
function extractFunctionBody(source: string, signatureAnchor: string): string {
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
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }
  throw new Error(`chave de fechamento não encontrada: ${signatureAnchor}`);
}

describe('closeContentVersion — ordem das guardas (TASK-029-002, estrutural)', () => {
  const source = readSource(CONTENT_VERSIONS_SERVICE);
  const body = extractFunctionBody(source, 'export async function closeContentVersion');

  it('(a) $queryRaw com FOR UPDATE é a 1ª chamada do corpo, antes de qualquer outra chamada a tx/assertRawContentReachable', () => {
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

    const firstExecutable = lines.find((candidate) => !isScopeOpener(candidate));
    if (firstExecutable === undefined) {
      throw new Error('nenhuma linha executável encontrada no corpo da função');
    }

    // Mutante: mover qualquer leitura/checagem para ANTES do lock faz esta
    // asserção reprovar — DEC-029-004 exige o lock como 1ª decisão.
    expect(firstExecutable).toContain('tx.$queryRaw');

    const queryRawIndex = body.indexOf('tx.$queryRaw');
    const forUpdateIndex = body.indexOf('FOR UPDATE');
    const reachableIndex = body.indexOf('assertRawContentReachable(');

    expect(queryRawIndex).toBeGreaterThan(-1);
    expect(forUpdateIndex).toBeGreaterThan(queryRawIndex);
    expect(reachableIndex).toBeGreaterThan(forUpdateIndex);
  });

  it('(b) assertRawContentReachable aparece ANTES da leitura de detalhe do RawContent que alimenta a checagem autor-ou-ADMIN', () => {
    const reachableIndex = body.indexOf('assertRawContentReachable(');
    const detailReadIndex = body.indexOf('rawContent.findUniqueOrThrow(');
    const guardIndex = body.indexOf("actor.role !== 'ADMIN'");

    expect(reachableIndex).toBeGreaterThan(-1);
    expect(detailReadIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(-1);

    // Mutante: mover a leitura de detalhe ou a checagem autor-ou-ADMIN para
    // ANTES de assertRawContentReachable faz esta asserção reprovar.
    expect(reachableIndex).toBeLessThan(detailReadIndex);
    expect(detailReadIndex).toBeLessThan(guardIndex);
  });

  it('(c) a leitura de RuleBreakdown acontece ANTES de contentVersion.findFirst/create', () => {
    const ruleBreakdownReadIndex = body.indexOf('ruleBreakdown.findUnique(');
    const findFirstIndex = body.indexOf('contentVersion.findFirst(');
    const createIndex = body.indexOf('contentVersion.create(');

    expect(ruleBreakdownReadIndex).toBeGreaterThan(-1);
    expect(findFirstIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(-1);

    // Mutante: mover a checagem de RuleBreakdown para DEPOIS do cálculo do
    // número/criação faz esta asserção reprovar — FR-028-003 exige a recusa
    // ANTES de qualquer numeração/INSERT.
    expect(ruleBreakdownReadIndex).toBeLessThan(findFirstIndex);
    expect(findFirstIndex).toBeLessThan(createIndex);
  });

  it('(d) recordProductionStageEvent é a ÚLTIMA chamada do corpo, depois de contentVersion.create', () => {
    const createIndex = body.indexOf('contentVersion.create(');
    const recordIndex = body.indexOf('recordProductionStageEvent(');

    expect(createIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(-1);

    // Mutante: mover a emissão do evento para ANTES do create faz esta
    // asserção reprovar — DEC-029-005 exige o registro como último ato.
    expect(createIndex).toBeLessThan(recordIndex);

    // Nenhuma outra chamada a tx.* depois de recordProductionStageEvent
    // (é literalmente a última chamada do corpo).
    const afterRecord = body.slice(recordIndex + 'recordProductionStageEvent('.length);
    expect(afterRecord).not.toMatch(/tx\.\w+\.(create|update|delete|findFirst|findUnique)\(/);
  });
});
