import {
  addMnemonicFrameSchema,
  mnemonicFrameIdParamSchema,
  reorderMnemonicFramesSchema,
  updateMnemonicFrameSchema,
} from '../../src/modules/tira/tira.schema';
import { rawContentIdParamSchema } from '../../src/modules/contents/contents.schema';

/**
 * `tira.schema.ts` (TASK-012-003 / COMP-012-003) — item do Inclui sem AC
 * vinculado (override-erros no topo da TASK): o oráculo é o contrato do
 * próprio schema — caso válido e caso inválido (com mensagem pt-BR asserida)
 * para cada um dos 4 schemas.
 */

describe('addMnemonicFrameSchema', () => {
  it('aceita { text, position } válidos', () => {
    const result = addMnemonicFrameSchema.safeParse({ text: 'CONCEITO reescrito', position: 1 });
    expect(result.success).toBe(true);
  });

  it('rejeita text vazio e position 0, nomeando os dois campos em pt-BR', () => {
    const result = addMnemonicFrameSchema.safeParse({ text: '', position: 0 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /informe|texto/i.test(i.message))).toBe(true);
      expect(result.error.issues.some((i) => /posição|position/i.test(i.message))).toBe(true);
    }
  });
});

describe('updateMnemonicFrameSchema', () => {
  it('aceita { text } válido', () => {
    const result = updateMnemonicFrameSchema.safeParse({ text: 'Ação revisada' });
    expect(result.success).toBe(true);
  });

  it('rejeita text vazio com mensagem pt-BR', () => {
    const result = updateMnemonicFrameSchema.safeParse({ text: '' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /informe|texto/i.test(i.message))).toBe(true);
    }
  });
});

describe('reorderMnemonicFramesSchema', () => {
  const uuid1 = '018f4d4a-1b1e-7c3a-8b1a-000000000001';
  const uuid2 = '018f4d4a-1b1e-7c3a-8b1a-000000000002';

  it('aceita { order: [uuid1, uuid2] } (≥1 item)', () => {
    const result = reorderMnemonicFramesSchema.safeParse({ order: [uuid1, uuid2] });
    expect(result.success).toBe(true);
  });

  it('rejeita { order: [] } com mensagem pt-BR sobre lista mínima', () => {
    const result = reorderMnemonicFramesSchema.safeParse({ order: [] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /informe|quadro|sequência/i.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejeita { order: ["nao-e-uuid"] } com mensagem pt-BR sobre identificador mal formado', () => {
    const result = reorderMnemonicFramesSchema.safeParse({ order: ['nao-e-uuid'] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /identificador/i.test(i.message))).toBe(true);
    }
  });
});

describe('mnemonicFrameIdParamSchema', () => {
  it('aceita um UUID v7 válido', () => {
    const result = mnemonicFrameIdParamSchema.safeParse({
      frameId: '018f4d4a-1b1e-7c3a-8b1a-000000000001',
    });
    expect(result.success).toBe(true);
  });

  it('rejeita frameId mal formado com mensagem pt-BR', () => {
    const result = mnemonicFrameIdParamSchema.safeParse({ frameId: 'nao-e-uuid' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /identificador de quadro inválido/i.test(i.message)),
      ).toBe(true);
    }
  });
});

describe('rawContentIdParamSchema — reusado (não redeclarado) de contents.schema', () => {
  it('aceita um UUID válido no param `:id`', () => {
    const result = rawContentIdParamSchema.safeParse({
      id: '018f4d4a-1b1e-7c3a-8b1a-000000000003',
    });
    expect(result.success).toBe(true);
  });
});
