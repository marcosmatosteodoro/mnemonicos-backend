import { rawContentIdParamSchema } from '../../src/modules/contents/contents.schema';
import {
  exportPublicationBodySchema,
  type ExportPublicationBodyInput,
} from '../../src/modules/publication/publication.schema';

/**
 * `publication.schema.ts` (TASK-025-006 / COMP-025-001) — item do Inclui sem AC
 * vinculado: o oráculo é o contrato do próprio schema — as 4 combinações de
 * `exportPublicationBodySchema` (2 válidas, 2 inválidas) exigidas pela TASK. O param
 * `:id` não tem schema próprio neste módulo (retry Wave 2, achado F4 — reusa
 * `rawContentIdParamSchema` de `contents.schema.ts`, testado por completo lá); o smoke
 * test abaixo só confirma o reuso, mesmo padrão de
 * `tira.schema.test.ts` ("rawContentIdParamSchema — reusado (não redeclarado)").
 */

describe('rawContentIdParamSchema — reusado (não redeclarado) de contents.schema', () => {
  it('aceita um UUID válido no param `:id`', () => {
    const result = rawContentIdParamSchema.safeParse({
      id: '018f4d4a-1b1e-7c3a-8b1a-000000000001',
    });
    expect(result.success).toBe(true);
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
