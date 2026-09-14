import {
  exportPublicationBodySchema,
  exportPublicationParamsSchema,
  type ExportPublicationBodyInput,
} from '../../src/modules/publication/publication.schema';

/**
 * `publication.schema.ts` (TASK-025-006 / COMP-025-001) — item do Inclui sem AC
 * vinculado: o oráculo é o contrato do próprio schema — caso válido e caso inválido
 * (com mensagem pt-BR asserida) para `exportPublicationParamsSchema`, e as 4 combinações
 * de `exportPublicationBodySchema` (2 válidas, 2 inválidas) exigidas pela TASK.
 */

describe('exportPublicationParamsSchema', () => {
  it('aceita um UUID válido', () => {
    const result = exportPublicationParamsSchema.safeParse({
      id: '018f4d4a-1b1e-7c3a-8b1a-000000000001',
    });
    expect(result.success).toBe(true);
  });

  it('rejeita { id: "não-é-uuid" } com a mensagem pt-BR', () => {
    const result = exportPublicationParamsSchema.safeParse({ id: 'não-é-uuid' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === 'Identificador de conteúdo bruto inválido.'),
      ).toBe(true);
    }
  });
});

describe('exportPublicationBodySchema', () => {
  it('aceita { variant: "RESUMO" }', () => {
    const result = exportPublicationBodySchema.safeParse({ variant: 'RESUMO' });
    expect(result.success).toBe(true);
  });

  it('aceita { variant: "TIRA" }', () => {
    const result = exportPublicationBodySchema.safeParse({ variant: 'TIRA' });
    expect(result.success).toBe(true);
  });

  it('rejeita { variant: "tira" } (minúsculo)', () => {
    const result = exportPublicationBodySchema.safeParse({ variant: 'tira' });
    expect(result.success).toBe(false);
  });

  it('rejeita { variant: "PDF" }', () => {
    const result = exportPublicationBodySchema.safeParse({ variant: 'PDF' });
    expect(result.success).toBe(false);
  });

  it('rejeita {} (variant ausente)', () => {
    const result = exportPublicationBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('ExportPublicationBodyInput tipa { variant: "TIRA" } sem erro de compilação', () => {
    const input: ExportPublicationBodyInput = { variant: 'TIRA' };
    expect(input.variant).toBe('TIRA');
  });
});
