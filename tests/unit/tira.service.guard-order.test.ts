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
 *
 * A busca pela `{` do corpo salta a LISTA DE PARÂMETROS por parênteses
 * balanceados a partir do 1º `(` após a âncora — um parâmetro com tipo
 * inline (ex.: `options?: { suppressOpeningEvent?: boolean }`,
 * COMP-025-007) contém uma `{` que NÃO é o corpo da função; procurar a 1ª
 * `{` "crua" após a âncora (sem pular os parênteses) pegaria essa `{` errada.
 *
 * `requiredAnchor`, quando informado, é um CONTROLE POSITIVO: o corpo
 * extraído precisa contê-lo — se o extrator mirar o alvo errado de novo no
 * futuro (outra âncora textual coincidente antes do corpo real), a extração
 * falha alto em vez de devolver um trecho vazio/errado sobre o qual as
 * asserções de ordem abaixo passariam verdes sem provar nada.
 */
function extractFunctionBody(
  source: string,
  signatureAnchor: string,
  requiredAnchor?: string,
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
        if (requiredAnchor !== undefined && !body.includes(requiredAnchor)) {
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
 * {`, `return await db.$transaction(...)`, ou o `try {` que envelopa a
 * `$transaction` quando a função precisa mapear um erro do banco antes de
 * propagar — `linkVisualAssociationToFrame`, TASK-023-011 retry) — essa linha
 * não é, ela mesma, uma chamada de guarda, é o envelope da transação (ou do
 * `try`) em que a guarda roda (mesmo padrão de `saveRuleBreakdown`/
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

  const isScopeOpener = (line: string): boolean =>
    line.endsWith('=> {') || line.endsWith(') {') || line === 'try {';

  const line = lines.find((candidate) => !isScopeOpener(candidate));
  if (line === undefined) {
    throw new Error('nenhuma linha executável encontrada no corpo da função');
  }
  return line;
}

describe('reorderMnemonicFrames — assertRawContentReachable é a 1ª chamada (AC-011-020, AC-011-022, estrutural)', () => {
  it('a 1ª linha executável do corpo (ignorando comentário e a abertura de `$transaction`) contém `assertRawContentReachable(`', () => {
    const source = readSource(TIRA_SERVICE);
    const body = extractFunctionBody(
      source,
      'export async function reorderMnemonicFrames',
      '.$transaction(',
    );
    const line = firstExecutableLine(body);

    // Mutante: mover a validação do `order` (ou a busca de `stripId`) para
    // ANTES de `assertRawContentReachable` faz esta asserção reprovar — a
    // guarda de alcance por autoria deixaria de ser a 1ª barreira.
    expect(line).toContain('assertRawContentReachable(');
  });
});

/**
 * TASK-012-007/TASK-023-011 (AC-011-020, AC-011-022, estrutural): 5 funções
 * são pontos de entrada de escrita sobre tabela escopada por autoria herdada
 * — as 3 de CRUD de Quadro (TASK-012-007) e as 2 de vínculo de associação
 * visual (`linkVisualAssociationToFrame`/`unlinkVisualAssociationFromFrame`,
 * TASK-023-011) — cada uma exige a MESMA prova estrutural de
 * `reorderMnemonicFrames` acima (mesma régua, "[Segurança] Guarda reusada
 * continua exigindo prova comportamental própria por novo método de
 * escrita" — a prova COMPORTAMENTAL vive em
 * `tira.service.integration.test.ts`; esta é só a prova de ORDEM).
 */
describe.each([
  ['addMnemonicFrame', 'export async function addMnemonicFrame'],
  ['updateMnemonicFrameText', 'export async function updateMnemonicFrameText'],
  ['removeMnemonicFrame', 'export async function removeMnemonicFrame'],
  ['linkVisualAssociationToFrame', 'export async function linkVisualAssociationToFrame'],
  ['unlinkVisualAssociationFromFrame', 'export async function unlinkVisualAssociationFromFrame'],
])(
  '%s — assertRawContentReachable é a 1ª chamada (AC-011-020, AC-011-022, estrutural)',
  (_name, signatureAnchor) => {
    it('a 1ª linha executável do corpo (ignorando comentário e a abertura de `$transaction`) contém `assertRawContentReachable(`', () => {
      const source = readSource(TIRA_SERVICE);
      const body = extractFunctionBody(source, signatureAnchor, '.$transaction(');
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
      const outerBody = extractFunctionBody(source, signatureAnchor, '.$transaction(');
      // Âncora do controle positivo (`mnemonicStrip.findUnique(`) é distinta
      // de `assertStripPrerequisites(` — a própria asserção da linha abaixo —
      // para o controle não ficar circular com o que está sendo provado.
      const transactionBody = extractFunctionBody(
        outerBody,
        'async (tx) => {',
        'mnemonicStrip.findUnique(',
      );
      const line = firstExecutableLine(transactionBody);

      // Mutante: ler `mnemonicStrip.findUnique` (ou qualquer outra coisa)
      // ANTES de `assertStripPrerequisites` faz esta asserção reprovar — a
      // guarda de alcance por autoria (dentro dela) deixaria de ser a 1ª
      // barreira.
      expect(line).toContain('assertStripPrerequisites(');
    });
  },
);

/**
 * Extrai o trecho do corpo EXTERNO da função que vem ANTES da entrada em
 * `$transaction` — universo que `firstExecutableLine`/`transactionBody` acima
 * NÃO cobre (aquele mira só o corpo do CALLBACK). Corta em `.$transaction(`:
 * o texto devolvido não inclui essa chamada em si (só o que vem antes dela),
 * e para `openMnemonicStrip` também não inclui o `catch` (que vem DEPOIS,
 * mais adiante no corpo).
 */
function extractPreamble(outerBody: string): string {
  const transactionCallIndex = outerBody.indexOf('.$transaction(');
  if (transactionCallIndex === -1) {
    throw new Error('chamada de $transaction não encontrada no corpo da função');
  }
  return outerBody.slice(0, transactionCallIndex);
}

/**
 * Achado correlato (retry): a prova acima (`transactionBody`) só enxerga o
 * corpo do CALLBACK da transação — um bypass poderia ser plantado no corpo
 * EXTERNO da função, ANTES de `db.$transaction(`, fora desse universo, sem
 * que nenhuma das duas provas de ordem acima acusasse. Esta prova
 * complementar fecha a lacuna: nenhuma chamada Prisma no formato
 * `<cliente>.<model>.<método>(` aparece no preâmbulo — nenhum fast-path de
 * leitura pode escapar por fora da transação.
 */
describe.each([
  ['getMnemonicStrip', 'export async function getMnemonicStrip'],
  ['openMnemonicStrip', 'export async function openMnemonicStrip'],
])(
  '%s — nenhuma chamada Prisma no corpo EXTERNO antes de entrar em $transaction (retry, achado correlato: universo do teste estrutural)',
  (_name, signatureAnchor) => {
    it('o preâmbulo (antes de `db.$transaction(`) não contém nenhuma chamada `<cliente>.<model>.<método>(`', () => {
      const source = readSource(TIRA_SERVICE);
      const outerBody = extractFunctionBody(source, signatureAnchor, '.$transaction(');
      const preamble = extractPreamble(outerBody);

      // Mutante: plantar, ANTES de `db.$transaction(`, algo como
      // `const cached = await db.mnemonicStrip.findFirst({ where: {
      // ruleBreakdownId } }); if (cached) return cached;` devolveria a Strip
      // existente sem nunca passar por `assertStripPrerequisites` (que só
      // roda dentro do callback) — esta asserção reprova, pois o preâmbulo
      // passaria a conter `db.mnemonicStrip.findFirst(`. O padrão cobre
      // também o cliente de módulo (`prisma`, importado no topo do arquivo e
      // default do próprio parâmetro `db`) — não só o parâmetro injetado —
      // para que o mesmo bypass escrito via `prisma.` não escape do universo.
      expect(preamble).not.toMatch(/\b(tx|db|prisma)\.\w+\.\w+\(/);
    });
  },
);

describe('assertStripPrerequisites — assertRawContentReachable é a 1ª chamada (guarda compartilhada por getMnemonicStrip e openMnemonicStrip, EMENDA Wave 5/DEC-012-011)', () => {
  it('a 1ª linha executável do corpo contém `assertRawContentReachable(`', () => {
    const source = readSource(TIRA_SERVICE);
    // Âncora do controle positivo (`ruleBreakdown.findUnique(`) é distinta de
    // `assertRawContentReachable(` — a própria asserção da linha abaixo —
    // para o controle não ficar circular com o que está sendo provado.
    const body = extractFunctionBody(
      source,
      'async function assertStripPrerequisites',
      'ruleBreakdown.findUnique(',
    );
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
