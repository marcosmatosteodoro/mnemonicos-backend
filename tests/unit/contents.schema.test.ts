import {
  createRawContentSchema,
  updateRawContentSchema,
} from '../../src/modules/contents/contents.schema';

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
