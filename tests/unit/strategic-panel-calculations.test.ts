import {
  aggregateStrategicPanel,
  computeContentMetrics,
  type ContentMetrics,
  type ContentMetricsInput,
  type ContentMetricsStageEvent,
  type StagePeriod,
} from '../../src/modules/strategic-panel/strategic-panel-calculations';
import type { ProductionStageType } from '../../src/domain/types';
import type { VersionedContentFields } from '../../src/modules/content-versions/versioned-content-diff';

/**
 * Prova unitária (TASK-035-004, COMP-035-010/011) — 1 cenário por FR/AC de
 * FEAT-034-002, sem banco: `computeContentMetrics`/`aggregateStrategicPanel` são
 * funções puras, fixtures montadas à mão. AC-034-011 (soft-delete) não é desta TASK —
 * a função pura recebe só o que já foi filtrado pela leitura (TASK-035-005).
 */

const BASE_CONTENT: ContentMetricsInput['content'] = {
  id: 'content-1',
  radarClass: 'ALTA',
  disciplineName: 'Direito Tributário',
  topicName: 'Obrigação Tributária',
};

function assertDefined<T>(value: T | undefined): asserts value is T {
  if (value === undefined) {
    throw new Error('valor esperado definido');
  }
}

function contentBrutoEvents(sequence: bigint, occurredAt: Date): ContentMetricsStageEvent[] {
  return [
    { stageType: 'CONTEUDO_BRUTO', transitionType: 'ABERTURA', sequence, occurredAt },
    {
      stageType: 'CONTEUDO_BRUTO',
      transitionType: 'CONCLUSAO',
      sequence: sequence + 1n,
      occurredAt,
    },
  ];
}

function buildInput(overrides: Partial<ContentMetricsInput> = {}): ContentMetricsInput {
  return {
    content: BASE_CONTENT,
    stageEvents: [],
    tiraPublications: [],
    latestVersion: null,
    ...overrides,
  };
}

const NAO_PERCORRIDA: StagePeriod = { status: 'nao-percorrida' };

function buildStagePeriodsAllNaoPercorrida(): Record<ProductionStageType, StagePeriod> {
  return {
    CONTEUDO_BRUTO: NAO_PERCORRIDA,
    QUEBRA_DA_REGRA: NAO_PERCORRIDA,
    TIRA_MNEMONICA: NAO_PERCORRIDA,
    ASSOCIACAO_VISUAL: NAO_PERCORRIDA,
    PUBLICACAO_PDF: NAO_PERCORRIDA,
    MATERIAL_REFORCO: NAO_PERCORRIDA,
    VERSAO_EDITORIAL: NAO_PERCORRIDA,
    APROVACAO_VERSAO: NAO_PERCORRIDA,
  };
}

let contentCounter = 0;
function buildContentMetrics(overrides: Partial<ContentMetrics> = {}): ContentMetrics {
  contentCounter += 1;
  return {
    contentId: `content-${contentCounter}`,
    disciplineName: 'Direito Tributário',
    topicName: 'Obrigação Tributária',
    totalTime: { reason: 'sem-medida' },
    timePerPage: null,
    perStage: buildStagePeriodsAllNaoPercorrida(),
    reworkCountByStage: {},
    concluded: false,
    approvedButAltered: false,
    mostAdvancedStage: 'CONTEUDO_BRUTO',
    priority: 'MEDIA',
    ageMs: null,
    ...overrides,
  };
}

describe('computeContentMetrics — Exportação de referência (AC-034-003, AC-034-024)', () => {
  it('usa a 1ª Exportação Tira ocorrida depois do fechamento, ignorando a anterior e as posteriores (AC-034-003)', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const beforeClosureExport = new Date('2026-01-03T00:00:00Z');
    const closure = new Date('2026-01-10T00:00:00Z');
    const referenceExport = new Date('2026-01-15T00:00:00Z');
    const laterExport = new Date('2026-02-01T00:00:00Z');

    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'PUBLICACAO_PDF',
        transitionType: 'CONCLUSAO',
        sequence: 3n,
        occurredAt: beforeClosureExport,
      },
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 4n,
        occurredAt: closure,
      },
      {
        stageType: 'PUBLICACAO_PDF',
        transitionType: 'CONCLUSAO',
        sequence: 5n,
        occurredAt: referenceExport,
      },
      {
        stageType: 'PUBLICACAO_PDF',
        transitionType: 'CONCLUSAO',
        sequence: 6n,
        occurredAt: laterExport,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-03-01T00:00:00Z'),
      buildInput({
        stageEvents,
        tiraPublications: [
          { occurredAt: beforeClosureExport, pageCount: 3 },
          { occurredAt: referenceExport, pageCount: 8 },
          { occurredAt: laterExport, pageCount: 20 },
        ],
      }),
    );

    expect(metrics.totalTime).toEqual({
      ms: referenceExport.getTime() - start.getTime(),
      pageCount: 8,
    });
  });

  it('Exportações só da Variante Resumo (sem correlação Tira) → sem medida (AC-034-024)', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const closure = new Date('2026-01-10T00:00:00Z');
    const resumoExport = new Date('2026-01-15T00:00:00Z');

    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 3n,
        occurredAt: closure,
      },
      {
        stageType: 'PUBLICACAO_PDF',
        transitionType: 'CONCLUSAO',
        sequence: 4n,
        occurredAt: resumoExport,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-03-01T00:00:00Z'),
      buildInput({ stageEvents, tiraPublications: [] }),
    );

    expect(metrics.totalTime).toEqual({ reason: 'sem-medida' });
  });
});

describe('computeContentMetrics — tempo total e tempo por página (AC-034-004)', () => {
  it('tempo total e tempo por página calculados por valor exato', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const closure = new Date('2026-01-05T00:00:00Z');
    const exportedAt = new Date('2026-01-15T00:00:00Z');

    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 3n,
        occurredAt: closure,
      },
      {
        stageType: 'PUBLICACAO_PDF',
        transitionType: 'CONCLUSAO',
        sequence: 4n,
        occurredAt: exportedAt,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents, tiraPublications: [{ occurredAt: exportedAt, pageCount: 10 }] }),
    );

    const expectedMs = exportedAt.getTime() - start.getTime();
    expect(metrics.totalTime).toEqual({ ms: expectedMs, pageCount: 10 });
    expect(metrics.timePerPage).toBe(expectedMs / 10);
  });
});

describe('computeContentMetrics — tempo por etapa com retrabalho (AC-034-005)', () => {
  it('soma o intervalo do 1º ao ÚLTIMO evento da etapa, incluindo retrabalho posterior à conclusão, e divide pelas páginas medidas', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const quebraAbertura = new Date('2026-01-02T00:00:00Z');
    const quebraConclusao = new Date('2026-01-04T00:00:00Z');
    const quebraRetrabalho = new Date('2026-01-06T00:00:00Z');
    const closure = new Date('2026-01-10T00:00:00Z');
    const exportedAt = new Date('2026-01-20T00:00:00Z');

    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'QUEBRA_DA_REGRA',
        transitionType: 'ABERTURA',
        sequence: 3n,
        occurredAt: quebraAbertura,
      },
      {
        stageType: 'QUEBRA_DA_REGRA',
        transitionType: 'CONCLUSAO',
        sequence: 4n,
        occurredAt: quebraConclusao,
      },
      {
        stageType: 'QUEBRA_DA_REGRA',
        transitionType: 'RETRABALHO',
        sequence: 5n,
        occurredAt: quebraRetrabalho,
      },
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 6n,
        occurredAt: closure,
      },
      {
        stageType: 'PUBLICACAO_PDF',
        transitionType: 'CONCLUSAO',
        sequence: 7n,
        occurredAt: exportedAt,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents, tiraPublications: [{ occurredAt: exportedAt, pageCount: 5 }] }),
    );

    const expectedStageMs = quebraRetrabalho.getTime() - quebraAbertura.getTime();
    expect(metrics.perStage.QUEBRA_DA_REGRA).toEqual({
      status: 'medido',
      ms: expectedStageMs,
      msPerPage: expectedStageMs / 5,
    });
  });
});

describe('computeContentMetrics — sem Exportação Tira medida (AC-034-006)', () => {
  it('Conteúdo ativo sem nenhuma Exportação Tira com página medida → tempo por página null, nunca zero', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const closure = new Date('2026-01-05T00:00:00Z');
    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 3n,
        occurredAt: closure,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents, tiraPublications: [] }),
    );

    expect(metrics.timePerPage).toBeNull();
    expect(metrics.totalTime).toEqual({ reason: 'sem-medida' });
  });
});

describe('computeContentMetrics — correções após revisão (AC-034-009, item c)', () => {
  it('retrabalho de Conteúdo bruto DEPOIS do fechamento entra na contagem da etapa (caso pós-fechamento)', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const closure = new Date('2026-01-05T00:00:00Z');
    const reworkAfter = new Date('2026-01-10T00:00:00Z');
    const stageEvents: ContentMetricsStageEvent[] = [
      { stageType: 'CONTEUDO_BRUTO', transitionType: 'ABERTURA', sequence: 1n, occurredAt: start },
      { stageType: 'CONTEUDO_BRUTO', transitionType: 'CONCLUSAO', sequence: 2n, occurredAt: start },
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 3n,
        occurredAt: closure,
      },
      {
        stageType: 'CONTEUDO_BRUTO',
        transitionType: 'RETRABALHO',
        sequence: 4n,
        occurredAt: reworkAfter,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents }),
    );

    expect(metrics.reworkCountByStage).toEqual({ CONTEUDO_BRUTO: 1 });
  });

  it('retrabalho ANTERIOR ao fechamento não entra em nenhuma contagem (caso pré-fechamento — par coincidente)', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const reworkBefore = new Date('2026-01-03T00:00:00Z');
    const closure = new Date('2026-01-05T00:00:00Z');
    const stageEvents: ContentMetricsStageEvent[] = [
      { stageType: 'CONTEUDO_BRUTO', transitionType: 'ABERTURA', sequence: 1n, occurredAt: start },
      { stageType: 'CONTEUDO_BRUTO', transitionType: 'CONCLUSAO', sequence: 2n, occurredAt: start },
      {
        stageType: 'CONTEUDO_BRUTO',
        transitionType: 'RETRABALHO',
        sequence: 3n,
        occurredAt: reworkBefore,
      },
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 4n,
        occurredAt: closure,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents }),
    );

    expect(metrics.reworkCountByStage).toEqual({});
  });
});

describe('computeContentMetrics — Conteúdo sem evento de criação (AC-034-020 parte cálculo)', () => {
  it('sem evento CONTEUDO_BRUTO → tudo "sem registro"/"sem medida" nomeado, etapa "sem registro"', () => {
    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents: [] }),
    );

    expect(metrics.totalTime).toEqual({ reason: 'sem-registro' });
    expect(metrics.timePerPage).toBeNull();
    expect(metrics.ageMs).toBeNull();
    expect(metrics.mostAdvancedStage).toBe('sem-registro');
  });
});

describe('computeContentMetrics — Exportação de referência sem página (AC-034-019)', () => {
  it('referência sem pageCount + reexportação posterior COM pageCount → sem medida (reexportação não substitui a referência)', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const closure = new Date('2026-01-05T00:00:00Z');
    const referenceExportAt = new Date('2026-01-10T00:00:00Z');
    const reexportAt = new Date('2026-01-20T00:00:00Z');

    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 3n,
        occurredAt: closure,
      },
      {
        stageType: 'PUBLICACAO_PDF',
        transitionType: 'CONCLUSAO',
        sequence: 4n,
        occurredAt: referenceExportAt,
      },
      {
        stageType: 'PUBLICACAO_PDF',
        transitionType: 'CONCLUSAO',
        sequence: 5n,
        occurredAt: reexportAt,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({
        stageEvents,
        tiraPublications: [
          { occurredAt: referenceExportAt, pageCount: null },
          { occurredAt: reexportAt, pageCount: 12 },
        ],
      }),
    );

    expect(metrics.totalTime).toEqual({ reason: 'sem-medida' });
    expect(metrics.timePerPage).toBeNull();
  });
});

describe('computeContentMetrics — os 4 estados de tempo por etapa, mesma etapa (AC-034-021)', () => {
  it('abertura sem conclusão → "em-aberto"', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const abertura = new Date('2026-01-02T00:00:00Z');
    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'QUEBRA_DA_REGRA',
        transitionType: 'ABERTURA',
        sequence: 3n,
        occurredAt: abertura,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents }),
    );

    expect(metrics.perStage.QUEBRA_DA_REGRA).toEqual({ status: 'em-aberto' });
  });

  it('etapa sem nenhum evento → "não percorrida"', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const stageEvents: ContentMetricsStageEvent[] = [...contentBrutoEvents(1n, start)];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents }),
    );

    expect(metrics.perStage.QUEBRA_DA_REGRA).toEqual({ status: 'nao-percorrida' });
  });

  it('evento sem abertura correspondente → "sem duração medida"', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const semAbertura = new Date('2026-01-03T00:00:00Z');
    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'QUEBRA_DA_REGRA',
        transitionType: 'CONCLUSAO',
        sequence: 3n,
        occurredAt: semAbertura,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-02-01T00:00:00Z'),
      buildInput({ stageEvents }),
    );

    expect(metrics.perStage.QUEBRA_DA_REGRA).toEqual({ status: 'sem-duracao-medida' });
  });
});

describe('computeContentMetrics — paridade do evento de Tira com F9', () => {
  it('latestTiraOccurredAt escolhido pelo evento TIRA_MNEMONICA de MAIOR sequence, nunca pelo de maior occurredAt', () => {
    const fields: VersionedContentFields = {
      rawText: 'texto',
      radarClass: 'ALTA',
      sourceType: null,
      sourceCitation: null,
      sourceUrl: null,
      concept: 'conceito',
      action: 'ação',
      object: 'objeto',
      condition: null,
      exception: null,
      essence: 'essência',
    };
    const start = new Date('2026-01-01T00:00:00Z');
    const closedAt = new Date('2026-01-10T00:00:00Z');
    // sequence 3 (MENOR) ocorre DEPOIS do fechamento — se o código escolhesse por
    // `occurredAt`, este evento (o mais recente no relógio) venceria e derrubaria
    // `concluded`.
    const tiraLowerSequenceAfterClosure = new Date('2026-01-15T00:00:00Z');
    // sequence 4 (MAIOR) ocorre ANTES do fechamento — é o que deve vencer por `sequence`.
    const tiraHigherSequenceBeforeClosure = new Date('2026-01-08T00:00:00Z');

    const stageEvents: ContentMetricsStageEvent[] = [
      ...contentBrutoEvents(1n, start),
      {
        stageType: 'TIRA_MNEMONICA',
        transitionType: 'CONCLUSAO',
        sequence: 3n,
        occurredAt: tiraLowerSequenceAfterClosure,
      },
      {
        stageType: 'TIRA_MNEMONICA',
        transitionType: 'RETRABALHO',
        sequence: 4n,
        occurredAt: tiraHigherSequenceBeforeClosure,
      },
      {
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        sequence: 5n,
        occurredAt: closedAt,
      },
    ];

    const metrics = computeContentMetrics(
      new Date('2026-03-01T00:00:00Z'),
      buildInput({
        stageEvents,
        latestVersion: { closedAt, approvedById: 'admin-1', contentSnapshot: fields },
        currentVersionedFields: fields,
      }),
    );

    expect(metrics.concluded).toBe(true);
  });
});

describe('aggregateStrategicPanel — agregado de tempo por página do Módulo (AC-034-007)', () => {
  it('média, mediana, n e cobertura de um Módulo com mix de medidos/não-medidos', () => {
    const metrics = [
      buildContentMetrics({ timePerPage: 100 }),
      buildContentMetrics({ timePerPage: 200 }),
      buildContentMetrics({ timePerPage: 300 }),
      buildContentMetrics({ timePerPage: null }),
    ];

    const payload = aggregateStrategicPanel(new Date('2026-02-01T00:00:00Z'), metrics);

    const [moduleAggregate] = payload.modules;
    assertDefined(moduleAggregate);
    expect(moduleAggregate.timePerPage).toEqual({
      status: 'medido',
      average: 200,
      median: 200,
      n: 3,
      activeTotal: 4,
    });
  });
});

describe('aggregateStrategicPanel — Conclusão por Módulo (AC-034-008 parte cálculo)', () => {
  it('ativos e concluídos corretos com mix de Concluídos e não-Concluídos', () => {
    const metrics = [
      buildContentMetrics({ concluded: true }),
      buildContentMetrics({ concluded: true }),
      buildContentMetrics({ concluded: false }),
    ];

    const payload = aggregateStrategicPanel(new Date('2026-02-01T00:00:00Z'), metrics);

    const [moduleAggregate] = payload.modules;
    assertDefined(moduleAggregate);
    expect(moduleAggregate.completion).toEqual({ active: 3, concluded: 2 });
  });
});

describe('aggregateStrategicPanel — correções após revisão totalizadas (FR-034-011/031)', () => {
  it('totaliza por etapa, sem somar etapas diferentes, e conta Conteúdos com ao menos 1 correção', () => {
    const metrics = [
      buildContentMetrics({ reworkCountByStage: { CONTEUDO_BRUTO: 2, QUEBRA_DA_REGRA: 1 } }),
      buildContentMetrics({ reworkCountByStage: { CONTEUDO_BRUTO: 3 } }),
      buildContentMetrics({ reworkCountByStage: {} }),
    ];

    const payload = aggregateStrategicPanel(new Date('2026-02-01T00:00:00Z'), metrics);

    expect(payload.rework).toEqual({
      byStage: { CONTEUDO_BRUTO: 5, QUEBRA_DA_REGRA: 1 },
      contentsWithCorrection: 2,
    });
  });
});

describe('aggregateStrategicPanel — backlog (AC-034-010, AC-034-020 parte backlog, item g)', () => {
  it('ordena por prioridade Alta→Média→Baixa (AC-034-010)', () => {
    const alta = buildContentMetrics({ contentId: 'alta', priority: 'ALTA', ageMs: 1000 });
    const media = buildContentMetrics({ contentId: 'media', priority: 'MEDIA', ageMs: 2000 });
    const baixa = buildContentMetrics({ contentId: 'baixa', priority: 'BAIXA', ageMs: 3000 });

    const payload = aggregateStrategicPanel(new Date('2026-02-01T00:00:00Z'), [baixa, alta, media]);

    expect(payload.backlog.map((item) => item.contentId)).toEqual(['alta', 'media', 'baixa']);
  });

  it('dentro da mesma prioridade, ordena do mais antigo para o mais novo — 2 idades DISTINTAS, ordem exata (item g)', () => {
    const older = buildContentMetrics({ contentId: 'older', priority: 'MEDIA', ageMs: 5_000_000 });
    const younger = buildContentMetrics({
      contentId: 'younger',
      priority: 'MEDIA',
      ageMs: 1_000_000,
    });

    const payload = aggregateStrategicPanel(new Date('2026-02-01T00:00:00Z'), [younger, older]);

    expect(payload.backlog.map((item) => item.contentId)).toEqual(['older', 'younger']);
  });

  it('idade "sem medida" (null) sempre depois de idade numérica, na mesma prioridade (AC-034-020 parte backlog)', () => {
    const numeric = buildContentMetrics({ contentId: 'numeric', priority: 'MEDIA', ageMs: 1000 });
    const semMedida = buildContentMetrics({
      contentId: 'sem-medida',
      priority: 'MEDIA',
      ageMs: null,
    });

    const payload = aggregateStrategicPanel(new Date('2026-02-01T00:00:00Z'), [semMedida, numeric]);

    expect(payload.backlog.map((item) => item.contentId)).toEqual(['numeric', 'sem-medida']);
  });

  it('Concluído não aparece no backlog', () => {
    const concluded = buildContentMetrics({ contentId: 'concluded', concluded: true });
    const active = buildContentMetrics({ contentId: 'active', concluded: false });

    const payload = aggregateStrategicPanel(new Date('2026-02-01T00:00:00Z'), [concluded, active]);

    expect(payload.backlog.map((item) => item.contentId)).toEqual(['active']);
  });
});

describe('aggregateStrategicPanel — Módulo com concluídos, sem aprovação e aprovado-alterado (AC-034-018 parte cálculo)', () => {
  it('ativos = concluídos + itens do backlog; o aprovado-e-alterado aparece no backlog com o marcador', () => {
    const concluded = buildContentMetrics({ contentId: 'concluded', concluded: true });
    const notApproved = buildContentMetrics({ contentId: 'not-approved', concluded: false });
    const approvedAltered = buildContentMetrics({
      contentId: 'approved-altered',
      concluded: false,
      approvedButAltered: true,
    });

    const payload = aggregateStrategicPanel(new Date('2026-02-01T00:00:00Z'), [
      concluded,
      notApproved,
      approvedAltered,
    ]);

    const [moduleAggregate] = payload.modules;
    assertDefined(moduleAggregate);
    expect(moduleAggregate.completion).toEqual({ active: 3, concluded: 1 });

    const approvedAlteredItem = payload.backlog.find(
      (item) => item.contentId === 'approved-altered',
    );
    assertDefined(approvedAlteredItem);
    expect(approvedAlteredItem.approvedButAltered).toBe(true);
    expect(payload.backlog.map((item) => item.contentId)).toEqual(
      expect.arrayContaining(['not-approved', 'approved-altered']),
    );
  });
});
