import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Rede de paridade cross-repo das interfaces do Painel estratégico
 * (FEAT-034-002, COMP-035-017/018). Análoga a `domain-types-parity.test.ts` e
 * ao molde direto `visual-associations-frontend-contract.test.ts`, mas para
 * os tipos de `strategic-panel-calculations.ts` (backend) ×
 * `src/types/domain.ts` (frontend): lê os arquivos como texto e prova que
 * NOME e TIPO de cada campo são idênticos dos dois lados — não um fixture
 * que se autoconfirma a partir de um dos lados. O texto de tipo é
 * normalizado (espaços, ordem dos membros de união) e passa por um mapa
 * explícito de nomes backend→frontend antes da comparação (`StagePeriod`→
 * `StagePeriodResponse`, `TimePerPageAggregate`→`TimePerPageAggregateResponse`,
 * `ModuleAggregate`/`ReworkTotals`/`BacklogItem`/`ContentMetrics`→`*Response`);
 * `ContentStageType`/`PresentationPriority` usam o MESMO nome nos dois lados,
 * sem mapa — `PresentationPriority` tem `it()` própria, comparando a união de
 * literais declarada, não só o nome referenciado por um campo.
 *
 * Uniões (`StagePeriod`/`TimePerPageAggregate`) são comparadas por
 * ocorrência `campo: tipo` de CADA ramo (multiset ordenado), não por um mapa
 * deduplicado por nome — um campo com o mesmo nome em ramos diferentes
 * (`status` em `StagePeriod`) não se sobrescreve.
 *
 * Limite conhecido (RISK-006-006, INDEX.md): este teste compara
 * DECLARAÇÃO×DECLARAÇÃO, não o retorno real de `toStrategicPanelResponse` ×
 * interface — uma chave nova ali sem a mesma chave em `ContentMetrics`/etc.
 * (backend) OU sem o espelho aqui (frontend) não é acusada por este teste.
 *
 * Repos symlinkados no workspace (mesmo padrão de `domain-types-parity.test.ts`):
 * os arquivos do frontend são lidos por caminho relativo a partir daqui.
 */
const BACKEND_CALCULATIONS = resolve(
  __dirname,
  '../../src/modules/strategic-panel/strategic-panel-calculations.ts',
);
const BACKEND_PRESENTATION_PRIORITY = resolve(
  __dirname,
  '../../src/domain/presentation-priority.ts',
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

/** Nomes de tipo que mudam de sufixo entre backend e frontend — aplicado ao
 * texto de tipo do lado backend antes de comparar com o frontend (os demais
 * identificadores usados nestes campos, como `ProductionStageType`,
 * `ContentStageType` e `PresentationPriority`, são idênticos nos dois lados). */
const BACKEND_TO_FRONTEND_TYPE_NAMES: Record<string, string> = {
  StagePeriod: 'StagePeriodResponse',
  TimePerPageAggregate: 'TimePerPageAggregateResponse',
  ModuleAggregate: 'ModuleAggregateResponse',
  ReworkTotals: 'ReworkTotalsResponse',
  BacklogItem: 'BacklogItemResponse',
  ContentMetrics: 'ContentMetricsResponse',
};

function mapBackendTypeNames(typeText: string): string {
  let mapped = typeText;
  for (const [backendName, frontendName] of Object.entries(BACKEND_TO_FRONTEND_TYPE_NAMES)) {
    mapped = mapped.replace(new RegExp(`\\b${backendName}\\b`, 'g'), frontendName);
  }
  return mapped;
}

/** Separa uma união de nível 1 respeitando aninhamento de `{}`/`<>`/`()` — os
 * ramos-objeto de `totalTime` (`{ ms: number; ... } | { reason: ... }`) têm
 * `|` interno (dentro de `reason`) que não pode virar um ramo próprio. */
function splitTopLevelUnion(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '{' || char === '<' || char === '(') depth += 1;
    if (char === '}' || char === '>' || char === ')') depth -= 1;
    if (char === '|' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

/** Normaliza texto de tipo para comparação: espaços colapsados e, quando é
 * uma união de nível 1, membros ordenados (a ordem declarada não é contrato). */
function normalizeTypeText(typeText: string): string {
  const collapsed = typeText.trim().replace(/\s+/g, ' ');
  const members = splitTopLevelUnion(collapsed);
  if (members.length === 1) {
    return collapsed;
  }
  return [...members].sort().join(' | ');
}

function normalizeTypeRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([name, type]) => [name, normalizeTypeText(type)]),
  );
}

/**
 * Tipo declarado (texto bruto) de cada campo de `export interface <name> { ... }`
 * — mesma extração textual usada para os nomes, guardando também o que vem
 * depois de `campo:` até o `;` de fim de linha (1 campo por linha, forma
 * usada nos dois repos para estes tipos).
 */
function extractInterfaceFieldTypes(source: string, interfaceName: string): Record<string, string> {
  const pattern = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`);
  const match = pattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`declaração de interface ${interfaceName} não encontrada`);
  }
  const result: Record<string, string> = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('//') || line.startsWith('*')) continue;
    const fieldMatch = /^(\w+)\??\s*:\s*(.+);$/.exec(line);
    const name = fieldMatch?.[1];
    const type = fieldMatch?.[2];
    if (name !== undefined && type !== undefined) {
      result[name] = type;
    }
  }
  return result;
}

function extractInterfaceFields(source: string, interfaceName: string): string[] {
  return Object.keys(extractInterfaceFieldTypes(source, interfaceName));
}

/**
 * `campo: tipo` de CADA ramo de `export type <name> = | {...} | {...};` — em
 * lista (nunca um mapa deduplicado): um campo com o mesmo nome em ramos
 * diferentes (`status` em `StagePeriod`) vira uma entrada própria por
 * ocorrência, comparada como multiset.
 */
function extractTypeUnionFieldEntries(source: string, typeName: string): string[] {
  const pattern = new RegExp(`export type ${typeName} =([\\s\\S]*?\\};)`);
  const match = pattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`declaração de type ${typeName} não encontrada`);
  }
  const fieldPattern = /(\w+)\??\s*:\s*([^;{}]+?)\s*(?=;|\})/g;
  const entries: string[] = [];
  for (const fieldMatch of body.matchAll(fieldPattern)) {
    const name = fieldMatch[1];
    const type = fieldMatch[2];
    if (name !== undefined && type !== undefined) {
      entries.push(`${name}: ${type}`);
    }
  }
  return entries;
}

function normalizeFieldTypeEntry(entry: string): string {
  const separatorIndex = entry.indexOf(':');
  const name = entry.slice(0, separatorIndex).trim();
  const type = entry.slice(separatorIndex + 1).trim();
  return `${name}: ${normalizeTypeText(type)}`;
}

function normalizedSortedEntries(entries: string[]): string[] {
  return entries.map(normalizeFieldTypeEntry).sort();
}

function extractTypeUnionFields(source: string, typeName: string): string[] {
  const entries = extractTypeUnionFieldEntries(source, typeName);
  return [...new Set(entries.map((entry) => entry.slice(0, entry.indexOf(':')).trim()))];
}

/** Texto bruto do lado direito de `export type <name> = <...>;` (alias
 * simples, sem `interface`/união multi-ramo) — usado só para
 * `PresentationPriority`. */
function extractTypeAliasText(source: string, typeName: string): string {
  const pattern = new RegExp(`export type ${typeName} = ([^;]+);`);
  const match = pattern.exec(source);
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`declaração de type ${typeName} não encontrada`);
  }
  return value;
}

/**
 * Confere nome+tipo de cada campo de uma interface backend×frontend:
 * (a) controle positivo — os tipos REAIS extraídos do backend batem com
 * `expectedBackendTypes`, escrito à mão (guarda contra o extrator ficar
 * vazio/mudo em silêncio); (b) os tipos do frontend batem com os do backend
 * mapeados (nome de tipo backend→frontend aplicado).
 */
function assertFieldTypeParity(
  backendSource: string,
  backendTypeName: string,
  frontendSource: string,
  frontendTypeName: string,
  expectedBackendTypes: Record<string, string>,
): void {
  const backendTypes = normalizeTypeRecord(
    extractInterfaceFieldTypes(backendSource, backendTypeName),
  );
  expect(backendTypes).toEqual(normalizeTypeRecord(expectedBackendTypes));

  const frontendTypes = normalizeTypeRecord(
    extractInterfaceFieldTypes(frontendSource, frontendTypeName),
  );
  const mappedBackendTypes = normalizeTypeRecord(
    Object.fromEntries(
      Object.entries(backendTypes).map(([name, type]) => [name, mapBackendTypeNames(type)]),
    ),
  );
  expect(frontendTypes).toEqual(mappedBackendTypes);
}

describe('paridade cross-repo — Painel estratégico (StrategicPanelResponse/subtipos)', () => {
  const backendSource = readSourceFile(BACKEND_CALCULATIONS);
  const backendPresentationPrioritySource = readSourceFile(BACKEND_PRESENTATION_PRIORITY);
  const frontendSource = readSourceFile(FRONTEND_TYPES);

  it('StrategicPanelPayload/StrategicPanelResponse: mesmo conjunto de campos e tipos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'StrategicPanelPayload').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'StrategicPanelResponse').sort();

    expect(backendFields).toEqual(['contents', 'factory', 'modules', 'rework', 'backlog'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `backlog` só do frontend (ex.: `backlogItems`) faz
    // esta comparação reprovar.

    assertFieldTypeParity(
      backendSource,
      'StrategicPanelPayload',
      frontendSource,
      'StrategicPanelResponse',
      {
        contents: 'ContentMetrics[]',
        factory: '{ timePerPage: TimePerPageAggregate }',
        modules: 'ModuleAggregate[]',
        rework: 'ReworkTotals',
        backlog: 'BacklogItem[]',
      },
    );
  });

  it('ContentMetrics/ContentMetricsResponse: mesmo conjunto de campos e tipos nos dois repositórios', () => {
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

    assertFieldTypeParity(
      backendSource,
      'ContentMetrics',
      frontendSource,
      'ContentMetricsResponse',
      {
        contentId: 'string',
        disciplineName: 'string',
        topicName: 'string',
        // Mutante: mudar para `string | null` faz esta comparação reprovar.
        totalTime: "{ ms: number; pageCount: number } | { reason: 'sem-medida' | 'sem-registro' }",
        timePerPage: 'number | null',
        perStage: 'Record<ProductionStageType, StagePeriod>',
        // Mutante: usar `ProductionStageType` (8 etapas) em vez de
        // `ContentStageType` (5) faz esta comparação reprovar.
        reworkCountByStage: 'Partial<Record<ContentStageType, number>>',
        concluded: 'boolean',
        approvedButAltered: 'boolean',
        mostAdvancedStage: "ProductionStageType | 'sem-registro'",
        priority: 'PresentationPriority',
        ageMs: 'number | null',
      },
    );
  });

  it('TimePerPageAggregate/TimePerPageAggregateResponse: mesmo conjunto de campos e tipos (união dos 2 ramos) nos dois repositórios', () => {
    const backendFields = extractTypeUnionFields(backendSource, 'TimePerPageAggregate').sort();
    const frontendFields = extractTypeUnionFields(
      frontendSource,
      'TimePerPageAggregateResponse',
    ).sort();

    expect(backendFields).toEqual(['status', 'average', 'median', 'n', 'activeTotal'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `activeTotal` só do frontend (ex.: `total`) faz esta
    // comparação reprovar.

    const expectedBackendEntries = normalizedSortedEntries([
      "status: 'medido'",
      'average: number',
      'median: number',
      'n: number',
      'activeTotal: number',
      "status: 'sem-medida'",
      // 2º ramo: `n`/`activeTotal` reaparecem — mutante "`n` removido de um
      // ramo" derruba a contagem deste multiset.
      'n: number',
      'activeTotal: number',
    ]);
    const backendEntries = normalizedSortedEntries(
      extractTypeUnionFieldEntries(backendSource, 'TimePerPageAggregate'),
    );
    expect(backendEntries).toEqual(expectedBackendEntries);

    const frontendEntries = normalizedSortedEntries(
      extractTypeUnionFieldEntries(frontendSource, 'TimePerPageAggregateResponse'),
    );
    const mappedBackendEntries = backendEntries.map((entry) => mapBackendTypeNames(entry)).sort();
    expect(frontendEntries).toEqual(mappedBackendEntries);
  });

  it('StagePeriod/StagePeriodResponse: mesmo conjunto de campos e tipos (união dos 2 ramos) nos dois repositórios', () => {
    const backendFields = extractTypeUnionFields(backendSource, 'StagePeriod').sort();
    const frontendFields = extractTypeUnionFields(frontendSource, 'StagePeriodResponse').sort();

    expect(backendFields).toEqual(['status', 'ms', 'msPerPage'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `msPerPage` só do frontend (ex.: `perPageMs`) faz esta
    // comparação reprovar.

    const expectedBackendEntries = normalizedSortedEntries([
      // Mutante: `'medido'` → `'medida'` num dos lados faz esta comparação
      // reprovar (a entrada não casa mais com a do outro lado).
      "status: 'medido'",
      'ms: number',
      'msPerPage: number | null',
      "status: 'em-aberto' | 'nao-percorrida' | 'sem-duracao-medida'",
    ]);
    const backendEntries = normalizedSortedEntries(
      extractTypeUnionFieldEntries(backendSource, 'StagePeriod'),
    );
    expect(backendEntries).toEqual(expectedBackendEntries);

    const frontendEntries = normalizedSortedEntries(
      extractTypeUnionFieldEntries(frontendSource, 'StagePeriodResponse'),
    );
    const mappedBackendEntries = backendEntries.map((entry) => mapBackendTypeNames(entry)).sort();
    expect(frontendEntries).toEqual(mappedBackendEntries);
  });

  it('ModuleAggregate/ModuleAggregateResponse: mesmo conjunto de campos e tipos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'ModuleAggregate').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ModuleAggregateResponse').sort();

    expect(backendFields).toEqual(
      ['disciplineName', 'topicName', 'timePerPage', 'completion'].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `completion` só do frontend (ex.: `progress`) faz
    // esta comparação reprovar.

    assertFieldTypeParity(
      backendSource,
      'ModuleAggregate',
      frontendSource,
      'ModuleAggregateResponse',
      {
        disciplineName: 'string',
        topicName: 'string',
        timePerPage: 'TimePerPageAggregate',
        completion: '{ active: number; concluded: number }',
      },
    );
  });

  it('ReworkTotals/ReworkTotalsResponse: mesmo conjunto de campos e tipos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'ReworkTotals').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ReworkTotalsResponse').sort();

    expect(backendFields).toEqual(['byStage', 'contentsWithCorrection'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `byStage` só do backend (ex.: `stageBreakdown`) faz
    // esta comparação reprovar.

    assertFieldTypeParity(backendSource, 'ReworkTotals', frontendSource, 'ReworkTotalsResponse', {
      // Mutante: usar `ProductionStageType` (8 etapas) em vez de
      // `ContentStageType` (5) faz esta comparação reprovar.
      byStage: 'Partial<Record<ContentStageType, number>>',
      contentsWithCorrection: 'number',
    });
  });

  it('BacklogItem/BacklogItemResponse: mesmo conjunto de campos e tipos nos dois repositórios', () => {
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

    assertFieldTypeParity(backendSource, 'BacklogItem', frontendSource, 'BacklogItemResponse', {
      contentId: 'string',
      disciplineName: 'string',
      topicName: 'string',
      mostAdvancedStage: "ProductionStageType | 'sem-registro'",
      priority: 'PresentationPriority',
      ageMs: 'number | null',
      approvedButAltered: 'boolean',
    });
  });

  it('PresentationPriority: mesma união de literais nos dois repositórios', () => {
    const backendPriority = normalizeTypeText(
      extractTypeAliasText(backendPresentationPrioritySource, 'PresentationPriority'),
    );
    const frontendPriority = normalizeTypeText(
      extractTypeAliasText(frontendSource, 'PresentationPriority'),
    );

    expect(backendPriority).toBe(normalizeTypeText("'ALTA' | 'MEDIA' | 'BAIXA'"));
    expect(frontendPriority).toBe(backendPriority);
    // Mutante: alterar um literal só de um lado (ex.: `'MEDIA'` → `'MÉDIA'`)
    // faz esta comparação reprovar.
  });
});
