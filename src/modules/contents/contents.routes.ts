import { Router, type Request } from 'express';

import { UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import {
  createRawContentSchema,
  listRawContentsQuerySchema,
  rawContentIdParamSchema,
  saveRuleBreakdownSchema,
  updateRawContentSchema,
} from './contents.schema';
import {
  createRawContent,
  getRawContent,
  getRuleBreakdown,
  listRawContents,
  saveRuleBreakdown,
  softDeleteRawContent,
  updateRawContent,
  type ContentActor,
} from './contents.service';

/**
 * Superfície HTTP do Conteúdo bruto e da Quebra da regra (COMP-006-004
 * principal, COMP-006-005, COMP-006-006 — TASK-006-011). **Só expõe** a regra
 * de negócio já resolvida em `contents.service.ts` (TASK-006-006/008/009):
 * nenhum Prisma aqui, nenhuma validação de alcance reimplementada.
 *
 * **Árvore plana** (nada de `.use('/prefixo', sub)`) — o caminho que
 * `requireRole` declara em `ROUTE_ROLES` tem de ser exatamente o `req.path`
 * comparado por `requireAuth`. **Cada** rota tem seu próprio
 * `requireRole('<MÉTODO>', '<caminho completo>', 'EDITOR', 'ADMIN')` **na
 * avaliação da montagem** — nunca dentro do handler (a lição [Arquitetura]:
 * `requireRole` declara em `ROUTE_ROLES` ao ser chamado; um `requireRole`
 * dentro do handler só declararia na 1ª requisição, tarde demais para
 * `assertDenyByDefault`/`requireAuth`, que já rodaram na montagem/na barreira).
 *
 * `verifyOrigin` (COMP-003-010) é o **1º handler** nas 4 mutações (`POST`,
 * `PATCH`, `DELETE`, `PUT`) — mesma razão de `users.routes.ts`: Route Handlers
 * não herdam proteção CSRF e o cookie de sessão é `sameSite: 'lax'`.
 *
 * O ator da requisição é sempre `req.auth` (resolvido por `requireAuth` a
 * partir da sessão no servidor), nunca um id de rota/query (NFR-002-002) — é
 * ele que `scopeWhere`/`assertRawContentReachable` usam para restringir EDITOR
 * à própria autoria.
 *
 * Sem `try/catch`: o Express 5 encaminha a rejeição ao `errorHandler`. Erro
 * previsto = `AppError` (`NotFoundError` do service vira 404 automaticamente).
 */
export const contentsRoutes = Router();

/**
 * `req.auth` sempre existe aqui (as 7 rotas rodam depois de `requireAuth` +
 * `requireRole`, que já recusaram sessão ausente) — a checagem é defesa em
 * profundidade, mesmo padrão de `auth.routes.ts` (`changeOwnPassword`/`me`).
 */
function actorOf(req: Request): ContentActor {
  if (req.auth === undefined) throw new UnauthorizedError();
  return { id: req.auth.userId, role: req.auth.role };
}

/** GET /contents — listagem paginada, resumo com `sourceCitation` (AC-005-016). */
contentsRoutes.get(
  '/contents',
  requireRole('GET', '/contents', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const query = listRawContentsQuerySchema.parse(req.query);
    const result = await listRawContents(query, actorOf(req));
    res.json(result);
  },
);

/** POST /contents — cria o Conteúdo bruto; `authorId` vem do ator, nunca do corpo. */
contentsRoutes.post(
  '/contents',
  verifyOrigin,
  requireRole('POST', '/contents', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const input = createRawContentSchema.parse(req.body);
    const created = await createRawContent(input, actorOf(req).id);
    res.status(201).json(created);
  },
);

/** GET /contents/:id — detalhe; 404 quando inexistente, removido ou fora do alcance. */
contentsRoutes.get(
  '/contents/:id',
  requireRole('GET', '/contents/:id', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const detail = await getRawContent(id, actorOf(req));
    res.json(detail);
  },
);

/** PATCH /contents/:id — edição parcial; autoria intocada, carimbo de última alteração. */
contentsRoutes.patch(
  '/contents/:id',
  verifyOrigin,
  requireRole('PATCH', '/contents/:id', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const input = updateRawContentSchema.parse(req.body);
    const updated = await updateRawContent(id, input, actorOf(req));
    res.json(updated);
  },
);

/** DELETE /contents/:id — remoção reversível (soft-delete). */
contentsRoutes.delete(
  '/contents/:id',
  verifyOrigin,
  requireRole('DELETE', '/contents/:id', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    await softDeleteRawContent(id, actorOf(req));
    res.status(204).end();
  },
);

/** GET /contents/:id/breakdown — Quebra da regra do Conteúdo bruto `:id`. */
contentsRoutes.get(
  '/contents/:id/breakdown',
  requireRole('GET', '/contents/:id/breakdown', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const breakdown = await getRuleBreakdown(id, actorOf(req));
    res.json(breakdown);
  },
);

/** PUT /contents/:id/breakdown — upsert 1:1 da Quebra da regra. */
contentsRoutes.put(
  '/contents/:id/breakdown',
  verifyOrigin,
  requireRole('PUT', '/contents/:id/breakdown', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const input = saveRuleBreakdownSchema.parse(req.body);
    const saved = await saveRuleBreakdown(id, input, actorOf(req));
    res.json(saved);
  },
);
