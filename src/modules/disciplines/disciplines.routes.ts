import { Router } from 'express';

import { requireRole } from '../../http/middlewares/authorize';
import { listDisciplinesQuerySchema } from './disciplines.schema';
import { listDisciplines } from './disciplines.service';

export const disciplinesRoutes = Router();

/**
 * GET /disciplines — exige sessão (EDITOR ou ADMIN) desde a fatia F1
 * (A-002-019; SPEC §4.1.9). `requireRole` declara `"GET /disciplines"` em
 * `ROUTE_ROLES` na montagem: sem essa declaração a rota nasceria negada pela
 * barreira deny-by-default (DEC-003-005). O contrato definitivo de `/disciplines`
 * (filtros, forma da resposta) é da fatia F2 — aqui só entra a exigência de
 * sessão e a declaração de papel.
 *
 * O Express 5 encaminha promises rejeitadas para o error handler, então não é
 * preciso try/catch nem wrapper de async aqui.
 */
disciplinesRoutes.get(
  '/disciplines',
  requireRole('GET', '/disciplines', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const query = listDisciplinesQuerySchema.parse(req.query);
    const result = await listDisciplines(query);

    res.json(result);
  },
);
