import { z } from 'zod';

import { PUBLICATION_VARIANTS } from '../../domain/types';

/**
 * Schemas Zod do módulo Publicação (COMP-025-001) — param `:id` e corpo `{ variant }`
 * de `POST /contents/:id/publication` (`publication.routes.ts`, TASK-025-009).
 * `PUBLICATION_VARIANTS` é reusado de `domain/types.ts` (TASK-025-002), nunca
 * redeclarado como array literal aqui (lição [Código] DRY).
 */
export const exportPublicationParamsSchema = z.object({
  id: z.uuid('Identificador de conteúdo bruto inválido.'),
});

export const exportPublicationBodySchema = z.object({
  variant: z.enum(PUBLICATION_VARIANTS),
});

export type ExportPublicationBodyInput = z.infer<typeof exportPublicationBodySchema>;
