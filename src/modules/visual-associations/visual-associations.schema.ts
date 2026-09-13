import { z } from 'zod';

/**
 * Schemas Zod do módulo Associação visual (COMP-023-001 / TASK-023-003). Cobrem os
 * campos de texto da associação (`category`/`cognitiveDescription`), o param `:id`,
 * a query de listagem (`category?`/`page?`/`perPage?`) e a de sugestão de categoria
 * (`q`). O arquivo enviado (multipart) não passa pelo Zod — é validado por assinatura
 * de bytes no service (`image-signature.ts`, COMP-023-002/COMP-023-005).
 */

/**
 * Criação de associação visual (FR-022-001/002/003/004). `error` no topo de cada
 * `z.string()` cobre o campo AUSENTE (`invalid_type`); `.min(1, ...)` cobre o campo
 * PRESENTE e vazio (`too_small`) — mesma mensagem pt-BR nos dois ramos, exigido pelo
 * Critério de pronto desta TASK ("rejeita... e a ausência dos dois campos... com
 * mensagem pt-BR").
 */
export const createVisualAssociationBodySchema = z.object({
  category: z.string({ error: 'Informe a categoria.' }).trim().min(1, 'Informe a categoria.'),
  cognitiveDescription: z
    .string({ error: 'Informe a função cognitiva da imagem.' })
    .trim()
    .min(1, 'Informe a função cognitiva da imagem.'),
});

export type CreateVisualAssociationBodyInput = z.infer<typeof createVisualAssociationBodySchema>;

/**
 * Edição in-place (FR-022-006) — mesmos campos, todos opcionais: a chamada de
 * serviço pode enviar só o subconjunto alterado, nunca um formulário completo
 * obrigatório.
 */
export const updateVisualAssociationBodySchema = createVisualAssociationBodySchema.partial();

export type UpdateVisualAssociationBodyInput = z.infer<typeof updateVisualAssociationBodySchema>;

/** `:id` das rotas de `visual-associations.routes.ts` (COMP-023-006). */
export const visualAssociationIdParamSchema = z.object({
  id: z.uuid('Identificador de associação visual inválido.'),
});

export type VisualAssociationIdParam = z.infer<typeof visualAssociationIdParamSchema>;

/**
 * Query de `listVisualAssociations` (FR-022-010/011) — mesmo padrão de paginação de
 * `listRawContentsQuerySchema` (`contents.schema.ts`).
 */
export const listVisualAssociationsQuerySchema = z.object({
  category: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListVisualAssociationsQuery = z.infer<typeof listVisualAssociationsQuerySchema>;

/**
 * Sugestão de categoria (FR-022-025). Mensagem pt-BR explícita nos dois ramos
 * (ausente/vazio) — exigida pelo Critério de pronto desta TASK; a interface pública
 * do PLAN-023 (COMP-023-001) omite a mensagem, mas Critérios de pronto prevalecem
 * sobre a transcrição literal do Escopo quando os dois divergem (mesma régua
 * aplicada a "Implementação sugerida").
 */
export const suggestCategoriesQuerySchema = z.object({
  q: z.string({ error: 'Informe o termo de busca.' }).trim().min(1, 'Informe o termo de busca.'),
});

export type SuggestCategoriesQuery = z.infer<typeof suggestCategoriesQuerySchema>;
