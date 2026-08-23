import { z } from 'zod';

export const listDisciplinesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(120).optional(),
});

export type ListDisciplinesQuery = z.infer<typeof listDisciplinesQuerySchema>;
