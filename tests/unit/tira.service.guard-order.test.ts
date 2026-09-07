import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prova ESTRUTURAL (leitura textual, sem AST — mesmo mecanismo de
 * `extractInterfaceFields` de `contents-frontend-contract.test.ts`,
 * generalizado para corpo de FUNÇÃO em vez de interface) de que
 * `assertRawContentReachable` é a 1ª chamada dentro do corpo de
 * `reorderMnemonicFrames` (AC-011-020, AC-011-022, parte estrutural) e,
 * estendido por TASK-012-007, das 3 funções de CRUD de Quadro
 * (`addMnemonicFrame`/`updateMnemonicFrameText`/`removeMnemonicFrame`).
 * A prova COMPORTAMENTAL completa de alcance (EDITOR não alcança Tira de
 * outro EDITOR; soft-delete torna inalcançável) vive em
 * `tira.service.integration.test.ts` — não duplicada aqui.
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
 * `openMnemonicStrip`).
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

/**
 * TASK-012-007 (AC-011-020, AC-011-022, estrutural): as 3 funções de CRUD de
 * Quadro são NOVOS pontos de entrada de escrita sobre tabela escopada por
 * autoria herdada — cada uma exige a MESMA prova estrutural de
 * `reorderMnemonicFrames` acima (mesma régua, "[Segurança] Guarda reusada
 * continua exigindo prova comportamental própria por novo método de
 * escrita" — a prova COMPORTAMENTAL vive em
 * `tira.service.integration.test.ts`; esta é só a prova de ORDEM).
 */
describe.each([
  ['addMnemonicFrame', 'export async function addMnemonicFrame'],
  ['updateMnemonicFrameText', 'export async function updateMnemonicFrameText'],
  ['removeMnemonicFrame', 'export async function removeMnemonicFrame'],
])(
  '%s — assertRawContentReachable é a 1ª chamada (AC-011-020, AC-011-022, estrutural)',
  (_name, signatureAnchor) => {
    it('a 1ª linha executável do corpo (ignorando comentário e a abertura de `$transaction`) contém `assertRawContentReachable(`', () => {
      const source = readSource(TIRA_SERVICE);
      const body = extractFunctionBody(source, signatureAnchor);
      const line = firstExecutableLine(body);

      // Mutante: mover `findStripId`/a guarda de pertencimento para ANTES de
      // `assertRawContentReachable` faz esta asserção reprovar — a guarda de
      // alcance por autoria deixaria de ser a 1ª barreira.
      expect(line).toContain('assertRawContentReachable(');
    });
  },
);

/**
 * `getMnemonicStrip`/`openMnemonicStrip` (EMENDA Wave 5/DEC-012-011) não
 * chamam `assertRawContentReachable` diretamente — delegam à guarda
 * compartilhada `assertStripPrerequisites`, que a chama internamente. A prova
 * de ordem, aqui, é composta em 2 saltos: (1) `assertStripPrerequisites` é a
 * 1ª chamada dentro do corpo de CADA função (nada lido/checado antes dela);
 * (2) `assertRawContentReachable` é a 1ª chamada dentro do corpo de
 * `assertStripPrerequisites` (prova única, a guarda é compartilhada — não
 * duplicada por função). As duas juntas fecham a mesma prova de ordem que as
 * funções acima têm isoladamente; invertida qualquer ponta, uma das 2 quebra.
 *
 * `openMnemonicStrip` declara `let ruleBreakdownId` ANTES do `try`/
 * `$transaction` (necessário para o `catch` do `P2002`) — o corpo da função
 * inteira não serve para `firstExecutableLine` (a declaração não é chamada de
 * guarda nem abridora de escopo). Por isso a extração aqui mira o corpo do
 * callback da transação (`async (tx) => {`), não o corpo externo da função —
 * mesmo padrão aplicado às duas, por consistência.
 */
describe.each([
  ['getMnemonicStrip', 'export async function getMnemonicStrip'],
  ['openMnemonicStrip', 'export async function openMnemonicStrip'],
])(
  '%s — assertStripPrerequisites (guarda compartilhada) é a 1ª chamada dentro do corpo da transação (AC-011-022/AC-011-023, estrutural)',
  (_name, signatureAnchor) => {
    it('a 1ª linha executável do corpo da transação contém `assertStripPrerequisites(`', () => {
      const source = readSource(TIRA_SERVICE);
      const outerBody = extractFunctionBody(source, signatureAnchor);
      const transactionBody = extractFunctionBody(outerBody, 'async (tx) => {');
      const line = firstExecutableLine(transactionBody);

      // Mutante: ler `mnemonicStrip.findUnique` (ou qualquer outra coisa)
      // ANTES de `assertStripPrerequisites` faz esta asserção reprovar — a
      // guarda de alcance por autoria (dentro dela) deixaria de ser a 1ª
      // barreira.
      expect(line).toContain('assertStripPrerequisites(');
    });
  },
);

describe('assertStripPrerequisites — assertRawContentReachable é a 1ª chamada (guarda compartilhada por getMnemonicStrip e openMnemonicStrip, EMENDA Wave 5/DEC-012-011)', () => {
  it('a 1ª linha executável do corpo contém `assertRawContentReachable(`', () => {
    const source = readSource(TIRA_SERVICE);
    const body = extractFunctionBody(source, 'async function assertStripPrerequisites');
    const line = firstExecutableLine(body);

    // Mutante: mover a checagem da Quebra da regra (`ruleBreakdown.findUnique`
    // + `ConflictError`) para ANTES de `assertRawContentReachable` faz esta
    // asserção reprovar — vazaria, para `getMnemonicStrip` E
    // `openMnemonicStrip` ao mesmo tempo (guarda compartilhada), a existência
    // do `rawContentId` de outro autor: o 409 apareceria antes de confirmar o
    // alcance.
    expect(line).toContain('assertRawContentReachable(');
  });
});
