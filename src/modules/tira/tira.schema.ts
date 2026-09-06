import { z } from 'zod';

// Reuso explícito: `:id` (rawContentId) das rotas de `tira.routes.ts` é o mesmo
// parâmetro já validado em `contents.schema.ts` — nunca redeclarado aqui
// (TASK-012-003, COMP-012-003).
import { rawContentIdParamSchema } from '../contents/contents.schema';

/**
 * Schemas Zod do módulo Tira mnemônica (COMP-012-003 / TASK-012-003). Cobrem as
 * 3 mutações de Quadro (adicionar, editar texto, reordenar) e o param
 * `:frameId` das rotas — nenhuma rota nem service entra nesta TASK
 * (COMP-012-004/COMP-012-006 são tasks à parte).
 */

/** Adicionar Quadro à Tira (FR-011-003). */
export const addMnemonicFrameSchema = z.object({
  text: z.string().trim().min(1, 'Informe o texto do quadro.'),
  position: z.number().int().min(1, 'A posição deve ser um número inteiro maior ou igual a 1.'),
});

export type AddMnemonicFrameInput = z.infer<typeof addMnemonicFrameSchema>;

/** Editar o texto de um Quadro existente (FR-011-004). */
export const updateMnemonicFrameSchema = z.object({
  text: z.string().trim().min(1, 'Informe o texto do quadro.'),
});

export type UpdateMnemonicFrameInput = z.infer<typeof updateMnemonicFrameSchema>;

/**
 * Reordenar os Quadros da Tira (FR-011-006) — `order` é o array completo de
 * ids de Quadro na sequência final desejada (mesma semântica do §4 F-5 do
 * PLAN-012), nunca um delta parcial.
 */
export const reorderMnemonicFramesSchema = z.object({
  order: z
    .array(z.uuid('Identificador de quadro inválido.'), {
      error: 'Informe a lista de quadros na sequência final desejada.',
    })
    .min(1, 'Informe ao menos um quadro na sequência.'),
});

export type ReorderMnemonicFramesInput = z.infer<typeof reorderMnemonicFramesSchema>;

/** `:frameId` das rotas de `tira.routes.ts` (COMP-012-006). */
export const mnemonicFrameIdParamSchema = z.object({
  frameId: z.uuid('Identificador de quadro inválido.'),
});

export type MnemonicFrameIdParam = z.infer<typeof mnemonicFrameIdParamSchema>;

// Re-exportado (não redeclarado) para que `tira.routes.ts` (COMP-012-006)
// valide `:id` sem precisar importar de `contents.schema` diretamente.
export { rawContentIdParamSchema };
