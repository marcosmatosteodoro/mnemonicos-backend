import { Router, type Request } from 'express';

import { UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import { rawContentIdParamSchema } from '../contents/contents.schema';
import type { ContentActor } from '../contents/contents.service';
import {
  createFlashcardSchema,
  flashcardIdParamSchema,
  updateFlashcardSchema,
} from './flashcards.schema';
import {
  createFlashcard,
  listFlashcards,
  removeFlashcard,
  updateFlashcard,
} from './flashcards.service';

/**
 * Superfície HTTP de Flashcard (COMP-027-012 / TASK-027-004): `POST`/`GET
 * /contents/:id/flashcards`, `PATCH`/`DELETE /contents/:id/flashcards/:flashcardId`.
 * **Só expõe** a regra de negócio já resolvida em `flashcards.service.ts`:
 * nenhum Prisma aqui, nenhuma validação de alcance/autoria reimplementada.
 *
 * `verifyOrigin` é o 1º handler nas 3 mutações (`POST`/`PATCH`/`DELETE`);
 * `requireRole('<MÉTODO>', '<caminho completo>', 'EDITOR', 'ADMIN')` nas 4,
 * na avaliação da montagem — mesma topologia de `contents.routes.ts`/
 * `contrasts.routes.ts` (NFR-026-001).
 */
export const flashcardsRoutes = Router();

/**
 * `req.auth` sempre existe aqui (as 4 rotas rodam depois de `requireAuth` +
 * `requireRole`, que já recusaram sessão ausente) — a checagem é defesa em
 * profundidade, mesmo padrão de `contrasts.routes.ts`.
 */
function actorOf(req: Request): ContentActor {
  if (req.auth === undefined) throw new UnauthorizedError();
  return { id: req.auth.userId, role: req.auth.role };
}

/** POST /contents/:id/flashcards — cria o Flashcard; `authorId` vem do ator, nunca do corpo. */
flashcardsRoutes.post(
  '/contents/:id/flashcards',
  verifyOrigin,
  requireRole('POST', '/contents/:id/flashcards', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const input = createFlashcardSchema.parse(req.body);
    const created = await createFlashcard(id, input, actorOf(req));
    res.status(201).json(created);
  },
);

/** GET /contents/:id/flashcards — lista os Flashcards do Conteúdo bruto `:id`. */
flashcardsRoutes.get(
  '/contents/:id/flashcards',
  requireRole('GET', '/contents/:id/flashcards', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const flashcards = await listFlashcards(id, actorOf(req));
    res.json(flashcards);
  },
);

/** PATCH /contents/:id/flashcards/:flashcardId — edita in-place; autor ou ADMIN. */
flashcardsRoutes.patch(
  '/contents/:id/flashcards/:flashcardId',
  verifyOrigin,
  requireRole('PATCH', '/contents/:id/flashcards/:flashcardId', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id, flashcardId } = flashcardIdParamSchema.parse(req.params);
    const input = updateFlashcardSchema.parse(req.body);
    const updated = await updateFlashcard(id, flashcardId, input, actorOf(req));
    res.json(updated);
  },
);

/** DELETE /contents/:id/flashcards/:flashcardId — DELETE físico do Flashcard; autor ou ADMIN. */
flashcardsRoutes.delete(
  '/contents/:id/flashcards/:flashcardId',
  verifyOrigin,
  requireRole('DELETE', '/contents/:id/flashcards/:flashcardId', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id, flashcardId } = flashcardIdParamSchema.parse(req.params);
    await removeFlashcard(id, flashcardId, actorOf(req));
    res.status(204).end();
  },
);
