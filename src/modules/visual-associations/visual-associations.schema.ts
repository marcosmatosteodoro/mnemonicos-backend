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
 * PRESENTE e vazio (`too_small`) — sem o `error` no topo, campo ausente cai no
 * texto padrão em inglês do Zod, não na mensagem pt-BR abaixo. `.max(500, ...)` é o
 * teto de tamanho: esta é a ÚNICA fronteira que cobre as duas vias de transporte —
 * `multer`'s `limits.fieldSize` (`visual-associations.routes.ts`) só atua sobre corpo
 * multipart, então um `PATCH`/`POST` com `Content-Type: application/json` passaria
 * ilimitado (até o teto de `express.json()` do app inteiro) sem este `.max()`.
 */
export const createVisualAssociationBodySchema = z.object({
  category: z
    .string({ error: 'Informe a categoria.' })
    .trim()
    .min(1, 'Informe a categoria.')
    .max(500, 'Categoria excede o tamanho máximo permitido (500 caracteres).'),
  cognitiveDescription: z
    .string({ error: 'Informe a função cognitiva da imagem.' })
    .trim()
    .min(1, 'Informe a função cognitiva da imagem.')
    .max(500, 'Função cognitiva da imagem excede o tamanho máximo permitido (500 caracteres).'),
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
 * Sugestão de categoria (FR-022-025). Mesmo par `error`/`.min(1, ...)` de
 * `createVisualAssociationBodySchema` — mensagem pt-BR nos dois ramos (ausente/vazio).
 */
export const suggestCategoriesQuerySchema = z.object({
  q: z.string({ error: 'Informe o termo de busca.' }).trim().min(1, 'Informe o termo de busca.'),
});

export type SuggestCategoriesQuery = z.infer<typeof suggestCategoriesQuerySchema>;
