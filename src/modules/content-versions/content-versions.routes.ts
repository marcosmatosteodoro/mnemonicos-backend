import { Router, type Request } from 'express';

import { UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import { rawContentIdParamSchema } from '../contents/contents.schema';
import type { ContentActor } from '../contents/contents.service';
import {
  approveContentVersionParamsSchema,
  approveContentVersionSchema,
  closeContentVersionSchema,
} from './content-versions.schema';
import {
  approveContentVersion,
  closeContentVersion,
  listContentVersions,
} from './content-versions.service';

/**
 * Superfície HTTP de Versão editorial (COMP-029-006 / TASK-029-002):
 * `POST`/`GET /contents/:id/versions`. **Só expõe** a regra já resolvida em
 * `content-versions.service.ts`: nenhum Prisma aqui. Sem `PATCH`/`DELETE` —
 * append-only (FR-028-004/AC-028-006).
 *
 * `verifyOrigin` é o 1º handler na mutação (`POST`); `requireRole('<MÉTODO>',
 * '<caminho completo>', 'EDITOR', 'ADMIN')` nas 2 — mesma topologia de
 * `contrasts.routes.ts`.
 */
export const contentVersionsRoutes = Router();

/**
 * `req.auth` sempre existe aqui (as 2 rotas rodam depois de `requireAuth` +
 * `requireRole`, que já recusaram sessão ausente) — a checagem é defesa em
 * profundidade, mesmo padrão de `contrasts.routes.ts`.
 */
function actorOf(req: Request): ContentActor {
  if (req.auth === undefined) throw new UnauthorizedError();
  return { id: req.auth.userId, role: req.auth.role };
}

/** POST /contents/:id/versions — fecha uma nova Versão editorial; authorId vem do ator. */
contentVersionsRoutes.post(
  '/contents/:id/versions',
  verifyOrigin,
  requireRole('POST', '/contents/:id/versions', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const input = closeContentVersionSchema.parse(req.body);
    const created = await closeContentVersion(id, input, actorOf(req));
    res.status(201).json(created);
  },
);

/** GET /contents/:id/versions — lista o histórico de Versões do Conteúdo bruto `:id`. */
contentVersionsRoutes.get(
  '/contents/:id/versions',
  requireRole('GET', '/contents/:id/versions', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const versions = await listContentVersions(id, actorOf(req));
    res.json(versions);
  },
);

/**
 * POST /contents/:id/versions/:number/approve — aprova a Versão vigente
 * `:number` de `:id` (FR-030-016: ADMIN only, sem `'EDITOR'` — deny-by-default).
 * Responde `200` (atualiza um recurso já existente, ao contrário do `201` de
 * `POST /contents/:id/versions`, que cria uma Versão nova).
 */
contentVersionsRoutes.post(
  '/contents/:id/versions/:number/approve',
  verifyOrigin,
  requireRole('POST', '/contents/:id/versions/:number/approve', 'ADMIN'),
  async (req, res) => {
    const { id, number } = approveContentVersionParamsSchema.parse({
      id: req.params.id,
      number: req.params.number,
    });
    const input = approveContentVersionSchema.parse(req.body);
    const approved = await approveContentVersion(id, number, input, actorOf(req));
    res.status(200).json(approved);
  },
);
