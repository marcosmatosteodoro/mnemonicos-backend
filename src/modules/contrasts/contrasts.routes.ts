import { Router, type Request } from 'express';

import { UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import { rawContentIdParamSchema } from '../contents/contents.schema';
import type { ContentActor } from '../contents/contents.service';
import {
  contrastIdParamSchema,
  createContrastSchema,
  updateContrastSchema,
} from './contrasts.schema';
import { createContrast, listContrasts, removeContrast, updateContrast } from './contrasts.service';

/**
 * Superfície HTTP de Contraste (COMP-027-003 / TASK-027-003): `POST`/`GET
 * /contents/:id/contrasts`, `PATCH`/`DELETE /contents/:id/contrasts/:contrastId`.
 * **Só expõe** a regra de negócio já resolvida em `contrasts.service.ts`:
 * nenhum Prisma aqui, nenhuma validação de alcance/autoria reimplementada.
 *
 * `verifyOrigin` é o 1º handler nas 3 mutações (`POST`/`PATCH`/`DELETE`);
 * `requireRole('<MÉTODO>', '<caminho completo>', 'EDITOR', 'ADMIN')` nas 4,
 * na avaliação da montagem — mesma topologia de `contents.routes.ts`/
 * `tira.routes.ts` (NFR-026-001).
 */
export const contrastsRoutes = Router();

/**
 * `req.auth` sempre existe aqui (as 4 rotas rodam depois de `requireAuth` +
 * `requireRole`, que já recusaram sessão ausente) — a checagem é defesa em
 * profundidade, mesmo padrão de `contents.routes.ts:58-61`.
 */
function actorOf(req: Request): ContentActor {
  if (req.auth === undefined) throw new UnauthorizedError();
  return { id: req.auth.userId, role: req.auth.role };
}

/** POST /contents/:id/contrasts — cria o Contraste; `authorId` vem do ator, nunca do corpo. */
contrastsRoutes.post(
  '/contents/:id/contrasts',
  verifyOrigin,
  requireRole('POST', '/contents/:id/contrasts', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const input = createContrastSchema.parse(req.body);
    const created = await createContrast(id, input, actorOf(req));
    res.status(201).json(created);
  },
);

/** GET /contents/:id/contrasts — lista os Contrastes do Conteúdo bruto `:id`. */
contrastsRoutes.get(
  '/contents/:id/contrasts',
  requireRole('GET', '/contents/:id/contrasts', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const contrasts = await listContrasts(id, actorOf(req));
    res.json(contrasts);
  },
);

/** PATCH /contents/:id/contrasts/:contrastId — edita in-place; autor ou ADMIN. */
contrastsRoutes.patch(
  '/contents/:id/contrasts/:contrastId',
  verifyOrigin,
  requireRole('PATCH', '/contents/:id/contrasts/:contrastId', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id, contrastId } = contrastIdParamSchema.parse(req.params);
    const input = updateContrastSchema.parse(req.body);
    const updated = await updateContrast(id, contrastId, input, actorOf(req));
    res.json(updated);
  },
);

/** DELETE /contents/:id/contrasts/:contrastId — DELETE físico do Contraste; autor ou ADMIN. */
contrastsRoutes.delete(
  '/contents/:id/contrasts/:contrastId',
  verifyOrigin,
  requireRole('DELETE', '/contents/:id/contrasts/:contrastId', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id, contrastId } = contrastIdParamSchema.parse(req.params);
    await removeContrast(id, contrastId, actorOf(req));
    res.status(204).end();
  },
);
