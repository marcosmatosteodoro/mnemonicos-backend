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

/** Extrai o corpo de uma função por casamento de chaves balanceadas. */
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

/**
 * 1ª linha executável do corpo (ignora comentários e "abridores" de escopo —
 * `=> {`/`) {`/`try {`) — usada pelas provas de "X é a 1ª chamada do corpo".
 * Compartilhado pelos 2 blocos abaixo: sem este helper, uma prova de ordem
 * relativa entre 2 âncoras (ex.: "A antes de B") não detecta um mutante que
 * insere uma 3ª chamada ANTES das duas — só a posição ABSOLUTA (1ª linha do
 * corpo) fecha essa classe de mutante.
 */
function firstExecutableStatement(body: string): string {
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
  return firstExecutable;
}

describe('closeContentVersion — ordem das guardas (TASK-029-002, estrutural)', () => {
  const source = readSource(CONTENT_VERSIONS_SERVICE);
  const body = extractFunctionBody(source, 'export async function closeContentVersion');

  it('(a) $queryRaw com FOR UPDATE é a 1ª chamada do corpo, antes de qualquer outra chamada a tx/assertRawContentReachable', () => {
    // Mutante: mover qualquer leitura/checagem para ANTES do lock faz esta
    // asserção reprovar — DEC-029-004 exige o lock como 1ª decisão.
    expect(firstExecutableStatement(body)).toContain('tx.$queryRaw');

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

/**
 * Prova ESTRUTURAL da ORDEM exigida dentro do corpo de `approveContentVersion`
 * (PLAN-031 §6 DEC-031-001/006 emendada/009): mesmo mecanismo de
 * `extractFunctionBody` acima.
 *
 * Prova COMPORTAMENTAL completa vive em
 * `content-versions.service.integration.test.ts` — não duplicada aqui.
 */
describe('approveContentVersion — ordem das guardas (estrutural)', () => {
  const source = readSource(CONTENT_VERSIONS_SERVICE);
  const body = extractFunctionBody(source, 'export async function approveContentVersion');

  it('(a) tx.$queryRaw com FOR UPDATE é a 1ª chamada do corpo, ANTES de assertRawContentReachable', () => {
    // Mutante: mover qualquer leitura/checagem para ANTES do lock faz esta
    // asserção reprovar — DEC-031-001 herdada exige o lock como 1ª decisão.
    expect(firstExecutableStatement(body)).toContain('tx.$queryRaw');

    const queryRawIndex = body.indexOf('tx.$queryRaw');
    const forUpdateIndex = body.indexOf('FOR UPDATE');
    const reachableIndex = body.indexOf('assertRawContentReachable(');

    expect(queryRawIndex).toBeGreaterThan(-1);
    expect(forUpdateIndex).toBeGreaterThan(queryRawIndex);
    expect(reachableIndex).toBeGreaterThan(forUpdateIndex);
  });

  it('(b) contentVersion.findFirst (Versão vigente) ANTES de ruleBreakdown.findUniqueOrThrow — a guarda de existência vem antes do *OrThrow', () => {
    const findFirstIndex = body.indexOf('contentVersion.findFirst(');
    const ruleBreakdownIndex = body.indexOf('ruleBreakdown.findUniqueOrThrow(');

    expect(findFirstIndex).toBeGreaterThan(-1);
    expect(ruleBreakdownIndex).toBeGreaterThan(-1);

    // Mutante: mover a leitura de RuleBreakdown para ANTES da guarda de
    // existência da Versão faz esta asserção reprovar.
    expect(findFirstIndex).toBeLessThan(ruleBreakdownIndex);
  });

  it('(c) producerIds.has (segregação) ANTES de closureEvent (edição pós-fechamento)', () => {
    const producerIdsIndex = body.indexOf('producerIds.has(');
    const closureEventIndex = body.indexOf('closureEvent');

    expect(producerIdsIndex).toBeGreaterThan(-1);
    expect(closureEventIndex).toBeGreaterThan(-1);

    // Mutante: trocar a ordem das 2 guardas faz esta asserção reprovar —
    // precedência exigida: identidade (403 genérico) vence edição pós-fechamento.
    expect(producerIdsIndex).toBeLessThan(closureEventIndex);
  });

  it('(d) closureEvent (edição pós-fechamento) ANTES de snapshot.sourceType (fonte ausente)', () => {
    const closureEventIndex = body.indexOf('closureEvent');
    const sourceTypeIndex = body.indexOf('snapshot.sourceType');

    expect(closureEventIndex).toBeGreaterThan(-1);
    expect(sourceTypeIndex).toBeGreaterThan(-1);

    // Mutante: trocar a ordem das 2 guardas faz esta asserção reprovar —
    // precedência exigida: edição pós-fechamento vence fonte ausente.
    expect(closureEventIndex).toBeLessThan(sourceTypeIndex);
  });

  it('(e) ruleBreakdown.findUniqueOrThrow ANTES de resolveAlterationSignal', () => {
    const ruleBreakdownIndex = body.indexOf('ruleBreakdown.findUniqueOrThrow(');
    const resolveIndex = body.indexOf('resolveAlterationSignal(');

    expect(ruleBreakdownIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(-1);
    expect(ruleBreakdownIndex).toBeLessThan(resolveIndex);
  });

  it('(f) resolveAlterationSignal ANTES de contentVersion.updateMany', () => {
    const resolveIndex = body.indexOf('resolveAlterationSignal(');
    const updateManyIndex = body.indexOf('contentVersion.updateMany(');

    expect(resolveIndex).toBeGreaterThan(-1);
    expect(updateManyIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeLessThan(updateManyIndex);
  });

  it('(g) recordProductionStageEvent é a ÚLTIMA chamada do corpo, depois de contentVersion.updateMany', () => {
    const updateManyIndex = body.indexOf('contentVersion.updateMany(');
    const recordIndex = body.indexOf('recordProductionStageEvent(');

    expect(updateManyIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(-1);
    expect(updateManyIndex).toBeLessThan(recordIndex);

    const afterRecord = body.slice(recordIndex + 'recordProductionStageEvent('.length);
    expect(afterRecord).not.toMatch(
      /tx\.\w+\.(create|update|updateMany|delete|findFirst|findUnique|findUniqueOrThrow)\(/,
    );
  });
});
