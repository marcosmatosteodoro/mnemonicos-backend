import { z } from 'zod';

import { PUBLICATION_VARIANTS } from '../../domain/types';

/**
 * Schema Zod do corpo `{ variant }` de `POST /contents/:id/publication`
 * (`publication.routes.ts`, TASK-025-009). `PUBLICATION_VARIANTS` é reusado de
 * `domain/types.ts` (TASK-025-002), nunca redeclarado como array literal aqui (lição
 * [Código] DRY). O param `:id` NÃO tem schema próprio aqui — `publication.routes.ts`
 * importa `rawContentIdParamSchema` direto de `../contents/contents.schema` (mesmo campo,
 * mesma mensagem pt-BR; mesmo padrão já usado por `tira.routes.ts`).
 */
export const exportPublicationBodySchema = z.object({
  variant: z.enum(PUBLICATION_VARIANTS),
});

export type ExportPublicationBodyInput = z.infer<typeof exportPublicationBodySchema>;
