import { Router, type Request } from 'express';
import multer from 'multer';

import { env } from '../../config/env';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import type { ContentActor } from '../contents/contents.service';
import { mimeTypeForFormat, type RasterImageFormat } from './image-signature';
import {
  createVisualAssociationBodySchema,
  listVisualAssociationsQuerySchema,
  suggestCategoriesQuerySchema,
  updateVisualAssociationBodySchema,
  visualAssociationIdParamSchema,
} from './visual-associations.schema';
import {
  createVisualAssociation,
  getVisualAssociationBinary,
  listVisualAssociationCategories,
  listVisualAssociations,
  removeVisualAssociation,
  updateVisualAssociation,
} from './visual-associations.service';

/**
 * Superfície HTTP do acervo de associações visuais (COMP-023-006) — cobre criação,
 * edição, remoção (TASK-023-008/010), listagem paginada (`GET /visual-associations`) e
 * sugestão de categoria (`GET /visual-associations/categories`, TASK-023-014), e a
 * entrega do binário (`GET /visual-associations/:id/image`, TASK-023-016).
 *
 * `upload` (`multer`, `memoryStorage()` — DEC-023-003, nunca `diskStorage()`: o service
 * só persiste depois de `detectImageSignature` confirmar o formato) é instanciado UMA
 * ÚNICA VEZ no topo do módulo, nunca por requisição. `limits.fileSize` cobre o ARQUIVO
 * (`NFR-022-004`/`env.VISUAL_ASSOCIATIONS_MAX_FILE_SIZE_BYTES`); `files`/`fields`/
 * `fieldSize` cobrem quantidade/tamanho de campo NO TRANSPORTE MULTIPART — o `multer`
 * não atua em corpo `application/json` (só intercepta `multipart/form-data`), então o
 * teto de tamanho de `category`/`cognitiveDescription` que vale nas DUAS vias é o
 * `.max(500, ...)` do schema Zod (`visual-associations.schema.ts`), não `fieldSize`.
 *
 * `verifyOrigin` é o 1º handler nas 3 rotas mutantes (defesa CSRF). Nas 2 com arquivo a
 * ordem é `verifyOrigin` → `upload.single('image')` → `requireRole(...)` (COMP-023-006 do
 * PLAN); `DELETE` não tem arquivo, então é `verifyOrigin` → `requireRole(...)` direto.
 * `requireAuth` (barreira global, `routes.ts`) já resolve sessão + papel via
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
 * Allowlist fechada dos `Content-Type` que `GET /visual-associations/:id/image` pode
 * responder (TASK-023-016) — derivada de `mimeTypeForFormat` (`image-signature.ts`,
 * COMP-023-002) sobre os 3
 * formatos raster, nunca um literal duplicado à mão: `mimeType` é coluna `String`
 * livre no schema (não um enum de banco), então o `Content-Type` da resposta NUNCA
 * ecoa a coluna diretamente — só um valor deste conjunto fechado sai no header.
 */
const IMAGE_RASTER_FORMATS: readonly RasterImageFormat[] = ['PNG', 'JPEG', 'WEBP'];
const IMAGE_MIME_TYPE_ALLOWLIST: ReadonlySet<string> = new Set(
  IMAGE_RASTER_FORMATS.map(mimeTypeForFormat),
);

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
 * GET /visual-associations — lista/busca por categoria, paginada (FR-022-010/011).
 * Leitura pura, sem `verifyOrigin` (mesmo raciocínio de `GET /contents`,
 * `contents.routes.ts` — CSRF só se aplica a mutação de estado).
 */
visualAssociationsRoutes.get(
  '/visual-associations',
  requireRole('GET', '/visual-associations', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const query = listVisualAssociationsQuerySchema.parse(req.query);
    const result = await listVisualAssociations(query);
    res.json(result);
  },
);

/**
 * GET /visual-associations/categories — sugestão de categoria (FR-022-025). Registrada
 * ANTES de `GET /visual-associations/:id/image` (TASK-023-016) — caminho estático
 * precede `:param` na árvore montada (aqui sem colisão real: os dois têm nº de
 * segmentos diferente, mas a ordem segue a convenção do módulo).
 */
visualAssociationsRoutes.get(
  '/visual-associations/categories',
  requireRole('GET', '/visual-associations/categories', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const query = suggestCategoriesQuerySchema.parse(req.query);
    const categories = await listVisualAssociationCategories(query);
    res.json(categories);
  },
);

/**
 * GET /visual-associations/:id/image — entrega o binário já armazenado
 * (COMP-023-005/006, TASK-023-016, DEC-023-002/DEC-023-004): `res.type(...).send(...)`
 * sobre o `Buffer` já em memória, NUNCA `res.sendFile`/`express.static` — não há
 * caminho de arquivo em nenhum momento desta rota, a superfície de path traversal não
 * existe aqui. Leitura pura, SEM `verifyOrigin` (mesmo raciocínio de `GET
 * /contents/:id/strip`, NFR-022-005): a barreira é a sessão EDITOR/ADMIN válida
 * (`requireRole` abaixo), NÃO uma restrição de alcance por autoria de FR-022-018 — a
 * leitura/busca/vínculo do acervo é comum a todo EDITOR/ADMIN (FR-022-023, A-023-001
 * [assumido] do PLAN).
 *
 * `id` inexistente → 404. `mimeType` fora do `IMAGE_MIME_TYPE_ALLOWLIST` (não deveria
 * acontecer — defesa em profundidade contra corrupção/bug futuro) → `Error` puro
 * (não `AppError`), que o `errorHandler` despacha como 500 genérico: o valor da
 * coluna nunca chega à resposta, nem no `Content-Type` nem no corpo.
 */
visualAssociationsRoutes.get(
  '/visual-associations/:id/image',
  requireRole('GET', '/visual-associations/:id/image', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = visualAssociationIdParamSchema.parse(req.params);
    const binary = await getVisualAssociationBinary(id);
    if (binary === null) {
      throw new NotFoundError('Associação visual não encontrada.');
    }
    if (!IMAGE_MIME_TYPE_ALLOWLIST.has(binary.mimeType)) {
      throw new Error(`mimeType fora do allowlist esperado: ${binary.mimeType}`);
    }

    res.type(binary.mimeType).set('Content-Disposition', 'inline').send(binary.imageData);
  },
);

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

/**
 * DELETE /visual-associations/:id — remove a associação visual (FR-022-007/008);
 * guarda de autoria e trava de vínculo ativo rodam dentro do service (DEC-023-006,
 * decisão 4.140). Sem corpo de sucesso: `removeVisualAssociation` devolve `void`.
 */
visualAssociationsRoutes.delete(
  '/visual-associations/:id',
  verifyOrigin,
  requireRole('DELETE', '/visual-associations/:id', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = visualAssociationIdParamSchema.parse(req.params);
    await removeVisualAssociation(id, actorOf(req));
    res.status(204).end();
  },
);
