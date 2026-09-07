import { z } from 'zod';

/**
 * Schemas Zod do módulo Tira mnemônica (COMP-012-003 / TASK-012-003). Cobrem as
 * 3 mutações de Quadro (adicionar, editar texto, reordenar) e o param
 * `:frameId` das rotas.
 */

/**
 * Texto do Quadro — fonte única da regra (`z.string().trim().min(1, ...)`)
 * reusada por `addMnemonicFrameSchema` e `updateMnemonicFrameSchema` (mesmo
 * campo `text` da mesma entidade, mesma mensagem pt-BR).
 */
const frameTextSchema = z.string().trim().min(1, 'Informe o texto do quadro.');

/** Adicionar Quadro à Tira (FR-011-003). */
export const addMnemonicFrameSchema = z.object({
  text: frameTextSchema,
  position: z.number().int().min(1, 'A posição deve ser um número inteiro maior ou igual a 1.'),
});

export type AddMnemonicFrameInput = z.infer<typeof addMnemonicFrameSchema>;

/** Editar o texto de um Quadro existente (FR-011-004). */
export const updateMnemonicFrameSchema = z.object({
  text: frameTextSchema,
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
