import { Router, type Request } from 'express';
import multer from 'multer';

import { env } from '../../config/env';
import { BadRequestError, UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import type { ContentActor } from '../contents/contents.service';
import {
  createVisualAssociationBodySchema,
  updateVisualAssociationBodySchema,
  visualAssociationIdParamSchema,
} from './visual-associations.schema';
import { createVisualAssociation, updateVisualAssociation } from './visual-associations.service';

/**
 * Superfície HTTP de escrita do acervo de associações visuais (COMP-023-006 /
 * TASK-023-008) — só as 2 rotas de criação/edição desta TASK; listagem, sugestão de
 * categoria, remoção e entrega do binário são TASKs seguintes (TASK-023-010/014/016),
 * que ESTENDEM este módulo (`visualAssociationsRoutes`), não o recriam.
 *
 * `upload` (`multer`, `memoryStorage()` — DEC-023-003, nunca `diskStorage()`: o service
 * só persiste depois de `detectImageSignature` confirmar o formato) é instanciado UMA
 * ÚNICA VEZ no topo do módulo, nunca por requisição. `limits.fileSize` cobre o ARQUIVO
 * (`NFR-022-004`/`env.VISUAL_ASSOCIATIONS_MAX_FILE_SIZE_BYTES`); `files`/`fields`/
 * `fieldSize` (achado do security-engineer, gate 8 da Wave 1, decisão 4.140) cobrem o
 * resto do corpo multipart — sem eles, `category`/`cognitiveDescription` (schemas Zod
 * sem `.max()`) ficariam ilimitados em tamanho/quantidade de campos.
 *
 * `verifyOrigin` é o 1º handler nas 2 rotas (mutações — defesa CSRF). A ordem
 * `verifyOrigin` → `upload.single('image')` → `requireRole(...)` é a do COMP-023-006 do
 * PLAN: `requireAuth` (barreira global, `routes.ts`) já resolve sessão + papel via
 * `ROUTE_ROLES`/`rolesForPath` ANTES de qualquer rota específica rodar — uma sessão sem
 * papel EDITOR/ADMIN nunca alcança este módulo, então `upload.single` só processa
 * multipart de quem já passou a barreira; `requireRole` aqui é defesa em profundidade
 * sobre a MESMA decisão (mesmo padrão de `tira.routes.ts`/`contents.routes.ts`).
 *
 * `req.file` (populado pelo `multer`) nunca expõe `originalname`/`mimetype` do cliente
 * ao service — só `buffer`/`size` (DEC-023-012).
 *
 * Sem `try/catch`: o Express 5 encaminha a rejeição ao `errorHandler`. `BadRequestError`/
 * `ForbiddenError`/`NotFoundError` do service viram 400/403/404 automaticamente;
 * `MulterError` (estouro de limite) vira 413/400 pela EMENDA de `error-handler.ts`
 * (COMP-023-017).
 */
export const visualAssociationsRoutes = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.VISUAL_ASSOCIATIONS_MAX_FILE_SIZE_BYTES,
    files: 1,
    fields: 2,
    fieldSize: 4096,
  },
});

/**
 * `req.auth` sempre existe aqui (as rotas rodam depois de `requireAuth` +
 * `requireRole`, que já recusaram sessão ausente) — a checagem é defesa em
 * profundidade, mesmo padrão de `tira.routes.ts`/`contents.routes.ts`.
 */
function actorOf(req: Request): ContentActor {
  if (req.auth === undefined) throw new UnauthorizedError();
  return { id: req.auth.userId, role: req.auth.role };
}

/**
 * POST /visual-associations — cria a associação visual (FR-022-001/002/003/004).
 * Arquivo OBRIGATÓRIO: ausência de `req.file` (campo `image` não enviado) recusa antes
 * de chamar o service — `createVisualAssociation` exige `file` não-opcional.
 */
visualAssociationsRoutes.post(
  '/visual-associations',
  verifyOrigin,
  upload.single('image'),
  requireRole('POST', '/visual-associations', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    if (req.file === undefined) {
      throw new BadRequestError('Envie uma imagem para criar a associação visual.');
    }

    const input = createVisualAssociationBodySchema.parse(req.body);
    const created = await createVisualAssociation(
      input,
      { buffer: req.file.buffer, sizeBytes: req.file.size },
      actorOf(req),
    );
    res.status(201).json(created);
  },
);

/**
 * PATCH /visual-associations/:id — edita in-place (FR-022-006); arquivo OPCIONAL —
 * sem `req.file`, `updateVisualAssociation` atualiza só os campos de texto enviados.
 * Guarda de autoria (`assertVisualAssociationWritable`) roda dentro do service
 * (FR-022-023/DEC-023-006).
 */
visualAssociationsRoutes.patch(
  '/visual-associations/:id',
  verifyOrigin,
  upload.single('image'),
  requireRole('PATCH', '/visual-associations/:id', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = visualAssociationIdParamSchema.parse(req.params);
    const input = updateVisualAssociationBodySchema.parse(req.body);
    const file =
      req.file === undefined ? undefined : { buffer: req.file.buffer, sizeBytes: req.file.size };

    const updated = await updateVisualAssociation(id, input, file, actorOf(req));
    res.json(updated);
  },
);
