import {
  createVisualAssociationBodySchema,
  listVisualAssociationsQuerySchema,
  suggestCategoriesQuerySchema,
  updateVisualAssociationBodySchema,
  visualAssociationIdParamSchema,
} from '../../src/modules/visual-associations/visual-associations.schema';

/**
 * `visual-associations.schema.ts` (TASK-023-003 / COMP-023-001) — item do Inclui sem
 * AC vinculado (override-erros no topo da TASK): o oráculo é o contrato do próprio
 * schema — caso válido e caso inválido (com mensagem pt-BR asserida) para cada um dos
 * 5 schemas, mais os 2 casos extras de `listVisualAssociationsQuerySchema` (defaults e
 * teto de `perPage`).
 */

describe('createVisualAssociationBodySchema', () => {
  it('aceita { category, cognitiveDescription } válidos', () => {
    const result = createVisualAssociationBodySchema.safeParse({
      category: 'Tributário',
      cognitiveDescription: 'Ilustra o fato gerador.',
    });
    expect(result.success).toBe(true);
  });

  it('rejeita category e cognitiveDescription vazios, nomeando os dois campos em pt-BR', () => {
    const result = createVisualAssociationBodySchema.safeParse({
      category: '',
      cognitiveDescription: '',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /informe a categoria/i.test(i.message))).toBe(true);
      expect(
        result.error.issues.some((i) => /informe a função cognitiva da imagem/i.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejeita a ausência dos dois campos, nomeando os dois campos em pt-BR', () => {
    const result = createVisualAssociationBodySchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /informe a categoria/i.test(i.message))).toBe(true);
      expect(
        result.error.issues.some((i) => /informe a função cognitiva da imagem/i.test(i.message)),
      ).toBe(true);
    }
  });
});

describe('updateVisualAssociationBodySchema', () => {
  it('aceita { category } isolado (parcial)', () => {
    const result = updateVisualAssociationBodySchema.safeParse({ category: 'Nova categoria' });
    expect(result.success).toBe(true);
  });

  it('rejeita { category: "" } com a mesma mensagem de createVisualAssociationBodySchema', () => {
    const result = updateVisualAssociationBodySchema.safeParse({ category: '' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /informe a categoria/i.test(i.message))).toBe(true);
    }
  });
});

describe('visualAssociationIdParamSchema', () => {
  it('aceita um UUID v7 válido', () => {
    const result = visualAssociationIdParamSchema.safeParse({
      id: '018f4d4a-1b1e-7c3a-8b1a-000000000001',
    });
    expect(result.success).toBe(true);
  });

  it('rejeita { id: "nao-e-uuid" } com mensagem pt-BR', () => {
    const result = visualAssociationIdParamSchema.safeParse({ id: 'nao-e-uuid' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          /identificador de associação visual inválido/i.test(i.message),
        ),
      ).toBe(true);
    }
  });
});

describe('listVisualAssociationsQuerySchema', () => {
  it('aceita {} com defaults page: 1 e perPage: 20', () => {
    const result = listVisualAssociationsQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.perPage).toBe(20);
    }
  });

  it('aceita { category, page: "2", perPage: "50" }, coagindo string para número', () => {
    const result = listVisualAssociationsQuerySchema.safeParse({
      category: 'Tributário',
      page: '2',
      perPage: '50',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.perPage).toBe(50);
    }
  });

  it('rejeita { perPage: "101" } — acima do teto de 100', () => {
    const result = listVisualAssociationsQuerySchema.safeParse({ perPage: '101' });
    expect(result.success).toBe(false);
  });
});

describe('suggestCategoriesQuerySchema', () => {
  it('aceita { q: "trib" }', () => {
    const result = suggestCategoriesQuerySchema.safeParse({ q: 'trib' });
    expect(result.success).toBe(true);
  });

  it('rejeita { q: "" } com mensagem pt-BR', () => {
    const result = suggestCategoriesQuerySchema.safeParse({ q: '' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /informe o termo de busca/i.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejeita a ausência de q com mensagem pt-BR', () => {
    const result = suggestCategoriesQuerySchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /informe o termo de busca/i.test(i.message))).toBe(
        true,
      );
    }
  });
});
