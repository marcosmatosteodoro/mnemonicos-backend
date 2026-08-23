import { Router } from 'express';

import { listDisciplinesQuerySchema } from './disciplines.schema';
import { listDisciplines } from './disciplines.service';

export const disciplinesRoutes = Router();

/**
 * GET /disciplines
 * O Express 5 encaminha promises rejeitadas para o error handler, então não é
 * preciso try/catch nem wrapper de async aqui.
 */
disciplinesRoutes.get('/disciplines', async (req, res) => {
  const query = listDisciplinesQuerySchema.parse(req.query);
  const result = await listDisciplines(query);

  res.json(result);
});
