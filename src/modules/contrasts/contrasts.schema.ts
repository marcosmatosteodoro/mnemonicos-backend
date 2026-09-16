import { z } from 'zod';

/**
 * Schemas Zod de Contraste (COMP-027-001 / TASK-027-003) — `createContrastSchema`
 * e `updateContrastSchema` compartilham o mesmo shape (`confusableText`/
 * `distinctionText`, `.trim().min(1)`, NFR-026-002): Contraste não tem edição
 * parcial — o formulário único (`contrast-form.tsx`) sempre envia os 2 campos,
 * em criação OU edição. `contrastIdParamSchema` valida os 2 uuids da rota
 * (`:id`/`:contrastId`) antes de o service ser chamado — mesmo padrão de
 * `rawContentIdParamSchema` (`contents.schema.ts`).
 */
const contrastFieldsSchema = z.object({
  confusableText: z.string().trim().min(1, 'Informe o confundível.'),
  distinctionText: z.string().trim().min(1, 'Informe a distinção.'),
});

export const createContrastSchema = contrastFieldsSchema;

export type CreateContrastInput = z.infer<typeof createContrastSchema>;

export const updateContrastSchema = contrastFieldsSchema;

export type UpdateContrastInput = z.infer<typeof updateContrastSchema>;

export const contrastIdParamSchema = z.object({
  id: z.uuid('Identificador de conteúdo bruto inválido.'),
  contrastId: z.uuid('Identificador de contraste inválido.'),
});

export type ContrastIdParam = z.infer<typeof contrastIdParamSchema>;
