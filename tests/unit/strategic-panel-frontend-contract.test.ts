import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Rede de paridade cross-repo das interfaces do Painel estratégico
 * (FEAT-034-002, COMP-035-017/018). Análoga a `domain-types-parity.test.ts` e
 * ao molde direto `visual-associations-frontend-contract.test.ts`, mas para
 * os tipos de `strategic-panel-calculations.ts` (backend) ×
 * `src/types/domain.ts` (frontend): lê os dois arquivos como texto e prova
 * que os NOMES e a FORMA dos campos são idênticos dos dois lados — não um
 * fixture que se autoconfirma a partir de um dos lados.
 *
 * Nomes canônicos (backend vence — a fonte real do dado; ver também
 * `strategic-panel.routes.ts:toStrategicPanelResponse`, que reproduz estes
 * mesmos campos allowlist a allowlist):
 *   - `StrategicPanelPayload` ⇆ `StrategicPanelResponse`: `contents`/`factory`/
 *     `modules`/`rework`/`backlog`.
 *   - `ContentMetrics` ⇆ `ContentMetricsResponse`: os 12 campos por Conteúdo
 *     (FR-034-004/005/006/011/025).
 *   - `TimePerPageAggregate` ⇆ `TimePerPageAggregateResponse` e `StagePeriod`
 *     ⇆ `StagePeriodResponse`: uniões — comparadas pelos campos de TODOS os
 *     ramos, sem distinguir por ramo (o extrator é o mesmo dos `interface`,
 *     generalizado).
 *   - `ModuleAggregate` ⇆ `ModuleAggregateResponse`, `ReworkTotals` ⇆
 *     `ReworkTotalsResponse`, `BacklogItem` ⇆ `BacklogItemResponse`.
 *
 * Limite conhecido (RISK-006-006, INDEX.md): este teste compara
 * DECLARAÇÃO×DECLARAÇÃO, não o retorno real de `toStrategicPanelResponse` ×
 * interface — uma chave nova ali sem a mesma chave em `ContentMetrics`/etc.
 * (backend) OU sem o espelho aqui (frontend) não é acusada por este teste.
 *
 * Repos symlinkados no workspace (mesmo padrão de `domain-types-parity.test.ts`):
 * o arquivo do frontend é lido pelo caminho relativo a partir daqui.
 */
const BACKEND_CALCULATIONS = resolve(
  __dirname,
  '../../src/modules/strategic-panel/strategic-panel-calculations.ts',
);
const FRONTEND_TYPES = resolve(__dirname, '../../../mnemonicos-frontend/src/types/domain.ts');

function readSourceFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `arquivo não encontrado: ${path}\n` +
        'checkout irmão mnemonicos-frontend ausente — este teste de paridade ' +
        'exige os dois repos no workspace.',
    );
  }
  return readFileSync(path, 'utf8');
}

/**
 * Extrai os nomes de campo de uma `export interface <name> { ... }` pela
 * leitura textual do arquivo (sem AST) — mesmo mecanismo de
 * `extractSessionUserFields` em `domain-types-parity.test.ts`, generalizado
 * para qualquer interface. Assume corpo sem chave `{`/`}` aninhada balanceada
 * (campos com tipo objeto inline, como `totalTime`/`completion`, ainda batem
 * porque a captura para no 1º `\n}` de nível 1 — ver `extractTypeUnionFields`
 * para o caso de união multi-linha).
 */
function extractInterfaceFields(source: string, interfaceName: string): string[] {
  const pattern = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`);
  const match = pattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`declaração de interface ${interfaceName} não encontrada`);
  }
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*'))
    .map((line) => /^(\w+)\??\s*:/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

/**
 * Extrai os nomes de campo de uma `export type <name> = | {...} | {...};`
 * (união de object literals, separador `;` DENTRO de cada ramo) — captura até
 * o primeiro `};` literal, que só ocorre no fechamento do ÚLTIMO ramo (os
 * ramos intermediários terminam em `}` seguido de nova linha, nunca `};`).
 * Campos de todos os ramos são somados (Set) — sem distinguir por ramo, na
 * mesma disciplina rasa de `extractInterfaceFields`.
 */
function extractTypeUnionFields(source: string, typeName: string): string[] {
  const pattern = new RegExp(`export type ${typeName} =([\\s\\S]*?\\};)`);
  const match = pattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`declaração de type ${typeName} não encontrada`);
  }
  const fields = [...body.matchAll(/(\w+)\??\s*:/g)].map((m) => m[1] ?? '');
  return [...new Set(fields)];
}

describe('paridade cross-repo — Painel estratégico (StrategicPanelResponse/subtipos)', () => {
  const backendSource = readSourceFile(BACKEND_CALCULATIONS);
  const frontendSource = readSourceFile(FRONTEND_TYPES);

  it('StrategicPanelPayload/StrategicPanelResponse: mesmo conjunto de campos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'StrategicPanelPayload').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'StrategicPanelResponse').sort();

    expect(backendFields).toEqual(['contents', 'factory', 'modules', 'rework', 'backlog'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `backlog` só do frontend (ex.: `backlogItems`) faz
    // esta comparação reprovar.
    expect(frontendFields).not.toContain('backlogItems');
  });

  it('ContentMetrics/ContentMetricsResponse: mesmo conjunto de campos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'ContentMetrics').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ContentMetricsResponse').sort();

    expect(backendFields).toEqual(
      [
        'contentId',
        'disciplineName',
        'topicName',
        'totalTime',
        'timePerPage',
        'perStage',
        'reworkCountByStage',
        'concluded',
        'approvedButAltered',
        'mostAdvancedStage',
        'priority',
        'ageMs',
      ].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `contentId` só do frontend (ex.: `rawContentId`) faz
    // esta comparação reprovar.
    expect(frontendFields).not.toContain('rawContentId');
  });

  it('TimePerPageAggregate/TimePerPageAggregateResponse: mesmo conjunto de campos (união dos 2 ramos) nos dois repositórios', () => {
    const backendFields = extractTypeUnionFields(backendSource, 'TimePerPageAggregate').sort();
    const frontendFields = extractTypeUnionFields(
      frontendSource,
      'TimePerPageAggregateResponse',
    ).sort();

    expect(backendFields).toEqual(['status', 'average', 'median', 'n', 'activeTotal'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `activeTotal` só do frontend (ex.: `total`) faz esta
    // comparação reprovar.
    expect(frontendFields).not.toContain('total');
  });

  it('StagePeriod/StagePeriodResponse: mesmo conjunto de campos (união dos 2 ramos) nos dois repositórios', () => {
    const backendFields = extractTypeUnionFields(backendSource, 'StagePeriod').sort();
    const frontendFields = extractTypeUnionFields(frontendSource, 'StagePeriodResponse').sort();

    expect(backendFields).toEqual(['status', 'ms', 'msPerPage'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `msPerPage` só do frontend (ex.: `perPageMs`) faz esta
    // comparação reprovar.
    expect(frontendFields).not.toContain('perPageMs');
  });

  it('ModuleAggregate/ModuleAggregateResponse: mesmo conjunto de campos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'ModuleAggregate').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ModuleAggregateResponse').sort();

    expect(backendFields).toEqual(
      ['disciplineName', 'topicName', 'timePerPage', 'completion'].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `completion` só do frontend (ex.: `progress`) faz
    // esta comparação reprovar.
    expect(frontendFields).not.toContain('progress');
  });

  it('ReworkTotals/ReworkTotalsResponse: mesmo conjunto de campos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'ReworkTotals').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ReworkTotalsResponse').sort();

    expect(backendFields).toEqual(['byStage', 'contentsWithCorrection'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `byStage` só do backend (ex.: `stageBreakdown`) faz
    // esta comparação reprovar.
    expect(backendFields).not.toContain('stageBreakdown');
  });

  it('BacklogItem/BacklogItemResponse: mesmo conjunto de campos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'BacklogItem').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'BacklogItemResponse').sort();

    expect(backendFields).toEqual(
      [
        'contentId',
        'disciplineName',
        'topicName',
        'mostAdvancedStage',
        'priority',
        'ageMs',
        'approvedButAltered',
      ].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `ageMs` só do frontend (ex.: `age`) faz esta
    // comparação reprovar.
    expect(frontendFields).not.toContain('age');
  });
});
