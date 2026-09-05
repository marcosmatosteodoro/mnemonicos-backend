import type * as ContentsSchemaModule from '../../src/modules/contents/contents.schema';
import {
  createRawContentSchema,
  listRawContentsQuerySchema,
  saveRuleBreakdownSchema,
  updateRawContentSchema,
} from '../../src/modules/contents/contents.schema';
import type * as DomainTypesModule from '../../src/domain/types';

type SchemaModule = typeof ContentsSchemaModule;

/**
 * `contents.schema.ts` (TASK-006-006 / COMP-006-002) — recusa e nomeia o campo
 * (AC-005-002, AC-005-003, AC-005-004, AC-005-015); `updateRawContentSchema`
 * nunca aceita `authorId`; as duas obrigatoriedades de fonte (create/update)
 * partem do mesmo refinamento.
 */

const validInput = {
  topicId: 'topic-1',
  rawText: 'Art. 113 do CTN define a obrigação tributária.',
  radarClass: 'ALTA' as const,
};

describe('createRawContentSchema — caminho feliz', () => {
  it('aceita o conjunto mínimo de campos (sem fonte normativa)', () => {
    const result = createRawContentSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('aceita fonte normativa completa (tipo + citação + link)', () => {
    const result = createRawContentSchema.safeParse({
      ...validInput,
      sourceType: 'CTN',
      sourceCitation: 'CTN, art. 113',
      sourceUrl: 'https://planalto.gov.br/ctn',
    });
    expect(result.success).toBe(true);
  });
});

describe('createRawContentSchema — recusa e nomeia o campo (AC-005-002, AC-005-003, AC-005-004)', () => {
  it('radarClass ausente → falha, nomeando radarClass nos issues', () => {
    const { radarClass: _radarClass, ...withoutRadarClass } = validInput;
    const result = createRawContentSchema.safeParse(withoutRadarClass);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'radarClass')).toBe(true);
    }
  });

  it('radarClass fora de {ALTA,MEDIA,DETALHE,EXCECAO,PEGADINHA} → falha', () => {
    const result = createRawContentSchema.safeParse({ ...validInput, radarClass: 'SUPER_ALTA' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'radarClass')).toBe(true);
    }
  });

  it('rawText e topicId ausentes → falha listando os dois campos', () => {
    const result = createRawContentSchema.safeParse({ radarClass: 'ALTA' });

    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((issue) => issue.path[0]);
      expect(fields).toEqual(expect.arrayContaining(['rawText', 'topicId']));
    }
  });
});

describe('createRawContentSchema — fonte normativa (AC-005-015)', () => {
  it('sourceType presente sem sourceCitation → falha em sourceCitation', () => {
    const result = createRawContentSchema.safeParse({ ...validInput, sourceType: 'CTN' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'sourceCitation')).toBe(true);
    }
  });

  it('sourceType fora do conjunto conhecido → falha', () => {
    const result = createRawContentSchema.safeParse({
      ...validInput,
      sourceType: 'DECRETO',
      sourceCitation: 'Decreto qualquer',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'sourceType')).toBe(true);
    }
  });
});

describe('contents.schema — enums vêm de domain/types (fonte única, retry Wave 2)', () => {
  it('remover um valor de PROOF_RADAR_CLASSES em domain/types faz o schema também rejeitá-lo (mesma fonte, sem redeclaração local)', () => {
    let mutatedSchema: SchemaModule | undefined;

    jest.isolateModules(() => {
      jest.doMock('../../src/domain/types', () => {
        const actual = jest.requireActual<typeof DomainTypesModule>('../../src/domain/types');
        return {
          ...actual,
          PROOF_RADAR_CLASSES: actual.PROOF_RADAR_CLASSES.filter((value) => value !== 'PEGADINHA'),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mutatedSchema = require('../../src/modules/contents/contents.schema') as SchemaModule;
    });

    const result = mutatedSchema?.createRawContentSchema.safeParse({
      ...validInput,
      radarClass: 'PEGADINHA',
    });

    expect(result?.success).toBe(false);

    jest.dontMock('../../src/domain/types');
  });
});

describe('createRawContentSchema — sourceUrl: allowlist de esquema http(s) (retry Wave 2, gate 8)', () => {
  it('recusa javascript: (XSS armazenado em potencial)', () => {
    const result = createRawContentSchema.safeParse({
      ...validInput,
      sourceUrl: 'javascript:alert(1)',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'sourceUrl')).toBe(true);
    }
  });

  it('recusa data: (XSS armazenado em potencial)', () => {
    const result = createRawContentSchema.safeParse({
      ...validInput,
      sourceUrl: 'data:text/html,x',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'sourceUrl')).toBe(true);
    }
  });

  it('aceita https:// válido', () => {
    const result = createRawContentSchema.safeParse({
      ...validInput,
      sourceUrl: 'https://planalto.gov.br/ctn',
    });

    expect(result.success).toBe(true);
  });
});

describe('listRawContentsQuerySchema — só page/perPage (NFR-005-004, TASK-006-008)', () => {
  it('parse de um objeto com filtro estranho devolve exatamente { page, perPage } — chaves de filtro somem', () => {
    const result = listRawContentsQuerySchema.parse({
      page: 2,
      perPage: 10,
      disciplineId: 'x',
      radarClass: 'ALTA',
    });

    expect(result).toEqual({ page: 2, perPage: 10 });
    expect(Object.keys(result).sort()).toEqual(['page', 'perPage']);
  });

  it('omissão de page/perPage aplica os defaults documentados (1 / 20)', () => {
    const result = listRawContentsQuerySchema.parse({});
    expect(result).toEqual({ page: 1, perPage: 20 });
  });

  it('coerção numérica: strings vindas de query string viram number', () => {
    const result = listRawContentsQuerySchema.parse({ page: '3', perPage: '15' });
    expect(result).toEqual({ page: 3, perPage: 15 });
  });
});

describe('saveRuleBreakdownSchema — obrigatórios vs. opcionais (TASK-006-009, AC-005-022)', () => {
  const minimalBreakdown = {
    concept: 'Vínculo jurídico entre Fisco e contribuinte.',
    action: 'Cobrar o tributo devido.',
    object: 'A obrigação tributária.',
    essence: 'Nasce da ocorrência do fato gerador.',
  };

  it('aceita o conjunto mínimo (concept, action, object, essence) sem condition/exception', () => {
    const result = saveRuleBreakdownSchema.safeParse(minimalBreakdown);
    expect(result.success).toBe(true);
  });

  it('aceita com condition/exception explicitamente vazios ("não se aplica" — A-005-009)', () => {
    const result = saveRuleBreakdownSchema.safeParse({
      ...minimalBreakdown,
      condition: '',
      exception: '',
    });
    expect(result.success).toBe(true);
  });

  it('aceita com condition/exception preenchidos', () => {
    const result = saveRuleBreakdownSchema.safeParse({
      ...minimalBreakdown,
      condition: 'Quando há substituição tributária.',
      exception: 'Salvo isenção legal expressa.',
    });
    expect(result.success).toBe(true);
  });

  it('aceita condition/exception explicitamente null (EMENDA pós gate 1-7, Wave 3) — round-trip ler→editar→salvar de T014 reenvia null, não 400', () => {
    const result = saveRuleBreakdownSchema.safeParse({
      ...minimalBreakdown,
      condition: null,
      exception: null,
    });

    expect(result.success).toBe(true);
    // null colapsa para undefined na saída — mesma semântica de "não se
    // aplica" que a string vazia, nunca um `null` distinto no output do parse.
    if (result.success) {
      expect(result.data.condition).toBeUndefined();
      expect(result.data.exception).toBeUndefined();
    }
  });

  it('condition/exception vazios/null saem como undefined do parse (não preservam o valor de entrada)', () => {
    const empty = saveRuleBreakdownSchema.safeParse({
      ...minimalBreakdown,
      condition: '',
      exception: '',
    });
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(empty.data.condition).toBeUndefined();
      expect(empty.data.exception).toBeUndefined();
    }
  });

  it('falta concept → rejeita e nomeia concept', () => {
    const { concept: _concept, ...withoutConcept } = minimalBreakdown;
    const result = saveRuleBreakdownSchema.safeParse(withoutConcept);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'concept')).toBe(true);
    }
  });

  it('falta action → rejeita e nomeia action', () => {
    const { action: _action, ...withoutAction } = minimalBreakdown;
    const result = saveRuleBreakdownSchema.safeParse(withoutAction);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'action')).toBe(true);
    }
  });

  it('falta object → rejeita e nomeia object', () => {
    const { object: _object, ...withoutObject } = minimalBreakdown;
    const result = saveRuleBreakdownSchema.safeParse(withoutObject);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'object')).toBe(true);
    }
  });

  it('falta essence → rejeita e nomeia essence', () => {
    const { essence: _essence, ...withoutEssence } = minimalBreakdown;
    const result = saveRuleBreakdownSchema.safeParse(withoutEssence);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'essence')).toBe(true);
    }
  });

  it('essence vazia (string em branco) → rejeita — não-vazio é a régua, não só presença', () => {
    const result = saveRuleBreakdownSchema.safeParse({ ...minimalBreakdown, essence: '   ' });
    expect(result.success).toBe(false);
  });
});

describe('updateRawContentSchema — sem authorId (contrato §273(b))', () => {
  it('.parse ignora authorId estranho ao input — nunca alcança o resultado', () => {
    const parsed = updateRawContentSchema.parse({ rawText: 'novo texto', authorId: 'outro-id' });

    expect('authorId' in parsed).toBe(false);
  });

  it('aceita atualização parcial (só um campo, sem os demais obrigatórios da criação)', () => {
    const result = updateRawContentSchema.safeParse({ rawText: 'novo texto' });
    expect(result.success).toBe(true);
  });

  it('reusa a mesma obrigatoriedade de fonte: sourceType sem sourceCitation → falha (FR-005-007)', () => {
    const result = updateRawContentSchema.safeParse({ sourceType: 'CTN' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'sourceCitation')).toBe(true);
    }
  });
});
