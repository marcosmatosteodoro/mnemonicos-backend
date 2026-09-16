import { z } from 'zod';

/**
 * Schemas Zod de Flashcard (COMP-027-010 / TASK-027-004) — `createFlashcardSchema`
 * e `updateFlashcardSchema` compartilham o mesmo shape (`question`/`answer`,
 * `.trim().min(1)`, NFR-026-002): Flashcard não tem edição parcial — o
 * formulário único (`flashcard-form.tsx`) sempre envia os 2 campos, em
 * criação OU edição. `flashcardIdParamSchema` valida os 2 uuids da rota
 * (`:id`/`:flashcardId`) antes de o service ser chamado — mesmo padrão de
 * `contrastIdParamSchema` (`contrasts.schema.ts`).
 */
const flashcardFieldsSchema = z.object({
  question: z.string().trim().min(1, 'Informe a pergunta.'),
  answer: z.string().trim().min(1, 'Informe a resposta.'),
});

export const createFlashcardSchema = flashcardFieldsSchema;

export type CreateFlashcardInput = z.infer<typeof createFlashcardSchema>;

export const updateFlashcardSchema = flashcardFieldsSchema;

export type UpdateFlashcardInput = z.infer<typeof updateFlashcardSchema>;

export const flashcardIdParamSchema = z.object({
  id: z.uuid('Identificador de conteúdo bruto inválido.'),
  flashcardId: z.uuid('Identificador de flashcard inválido.'),
});

export type FlashcardIdParam = z.infer<typeof flashcardIdParamSchema>;
