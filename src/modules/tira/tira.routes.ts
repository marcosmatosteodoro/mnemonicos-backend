import { Router, type Request } from 'express';

import { UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import { rawContentIdParamSchema } from '../contents/contents.schema';
import type { ContentActor } from '../contents/contents.service';
import {
  addMnemonicFrame,
  getMnemonicStrip,
  openMnemonicStrip,
  removeMnemonicFrame,
  reorderMnemonicFrames,
  updateMnemonicFrameText,
} from './tira.service';
import {
  addMnemonicFrameSchema,
  mnemonicFrameIdParamSchema,
  reorderMnemonicFramesSchema,
  updateMnemonicFrameSchema,
} from './tira.schema';

/**
 * Superfície HTTP da Tira mnemônica (COMP-012-006 principal) — **só expõe** a
 * regra de negócio já resolvida em `tira.service.ts` (TASK-012-005/006/007):
 * nenhum Prisma aqui, nenhuma validação de alcance reimplementada.
 *
 * **Árvore plana** (nada de `.use('/prefixo', sub)`), mesmo padrão de
 * `contents.routes.ts` — o caminho que `requireRole` declara em `ROUTE_ROLES`
 * tem de ser exatamente o `req.path` comparado por `requireAuth`. **Cada**
 * rota tem seu próprio `requireRole('<MÉTODO>', '<caminho completo>',
 * 'EDITOR', 'ADMIN')` **na avaliação da montagem** — nunca dentro do handler
 * (lição [Arquitetura]: `requireRole` declara em `ROUTE_ROLES` ao ser
 * chamado; um `requireRole` dentro do handler só declararia na 1ª
 * requisição, tarde demais para `assertDenyByDefault`/`requireAuth`, que já
 * rodaram na montagem/na barreira).
 *
 * A rota estática `PUT /contents/:id/strip/frames/order` monta ao lado da
 * rota com `:frameId` (`PATCH`/`DELETE /contents/:id/strip/frames/:frameId`)
 * — topologia adversarial mínima (lição [Segurança] "topologia adversarial"):
 * cada uma das 6 chaves abaixo é uma entrada INDEPENDENTE em `ROUTE_ROLES`,
 * nenhuma herda a declaração da vizinha — inclusive o par `GET`/`POST` no
 * MESMO caminho (`/contents/:id/strip`), mesma topologia adversarial de "2º
 * método no mesmo path".
 *
 * `verifyOrigin` (COMP-003-010) é o **1º handler** nas 5 mutações (`POST
 * /contents/:id/strip`, `POST .../frames`, `PATCH`, `DELETE`, `PUT`) —
 * ausente na leitura (`GET /contents/:id/strip`).
 *
 * **EMENDA Wave 5/DEC-012-011 (achado de CSRF do security-engineer, gate
 * 8)**: `GET /contents/:id/strip` deixou de ser get-or-generate — o cookie de
 * sessão `sameSite: 'lax'` acompanha navegação top-level, e o projeto proíbe
 * `verifyOrigin` em `GET`; um `GET` que escrevesse ficaria sem defesa CSRF
 * (sonda provou forjar `actorId` da vítima no evento ABERTURA). A geração
 * migrou para a rota nova `POST /contents/:id/strip` (com `verifyOrigin`); o
 * `GET` agora é **leitura pura** (`getMnemonicStrip`) — 404 quando a Tira
 * ainda não foi aberta, nunca cria.
 *
 * O ator da requisição é sempre `req.auth` (resolvido por `requireAuth` a
 * partir da sessão no servidor), nunca um id de rota/query (NFR-002-002) — é
 * ele que `assertRawContentReachable` (chamado dentro do service) usa para
 * restringir EDITOR à própria autoria.
 *
 * Sem `try/catch`: o Express 5 encaminha a rejeição ao `errorHandler`. Erro
 * previsto = `AppError` (`NotFoundError`/`ConflictError` do service viram
 * 404/409 automaticamente).
 */
export const tiraRoutes = Router();

/**
 * `req.auth` sempre existe aqui (as 6 rotas rodam depois de `requireAuth` +
 * `requireRole`, que já recusaram sessão ausente) — a checagem é defesa em
 * profundidade, mesmo padrão de `contents.routes.ts:58-61`.
 */
function actorOf(req: Request): ContentActor {
  if (req.auth === undefined) throw new UnauthorizedError();
  return { id: req.auth.userId, role: req.auth.role };
}

/**
 * GET /contents/:id/strip — leitura pura (EMENDA Wave 5/DEC-012-011): NUNCA
 * gera. Sem `verifyOrigin` (leitura de verdade, sem efeito colateral de
 * escrita). 404 quando o `:id` é inalcançável ou quando a Tira ainda não foi
 * aberta (AC-011-022/AC-011-023); 409 quando a Quebra da regra do
 * `rawContentId` ainda não foi salva (AC-011-023).
 */
tiraRoutes.get(
  '/contents/:id/strip',
  requireRole('GET', '/contents/:id/strip', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const strip = await getMnemonicStrip(id, actorOf(req));
    res.json(strip);
  },
);

/**
 * POST /contents/:id/strip — abertura get-or-generate idempotente
 * (FR-011-001/FR-011-002; antiga responsabilidade do `GET`, migrada por
 * EMENDA Wave 5/DEC-012-011). `verifyOrigin` como 1º handler (defesa CSRF: a
 * geração é a mutação que a sonda do security-engineer explorou via `GET`).
 * 404 quando o `:id` é inalcançável (AC-011-022); 409 quando a Quebra da
 * regra do `rawContentId` ainda não foi salva (AC-011-023).
 */
tiraRoutes.post(
  '/contents/:id/strip',
  verifyOrigin,
  requireRole('POST', '/contents/:id/strip', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const strip = await openMnemonicStrip(id, actorOf(req));
    res.json(strip);
  },
);

/** POST /contents/:id/strip/frames — adiciona um Quadro à Tira (FR-011-003). */
tiraRoutes.post(
  '/contents/:id/strip/frames',
  verifyOrigin,
  requireRole('POST', '/contents/:id/strip/frames', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const input = addMnemonicFrameSchema.parse(req.body);
    const strip = await addMnemonicFrame(id, input, actorOf(req));
    res.status(201).json(strip);
  },
);

/**
 * PATCH /contents/:id/strip/frames/:frameId — edita o texto de um Quadro
 * (FR-011-004). `:frameId` só é aceito se pertencer à cadeia do `:id` da URL
 * — a amarração vive no service, a rota só transporta o 404.
 */
tiraRoutes.patch(
  '/contents/:id/strip/frames/:frameId',
  verifyOrigin,
  requireRole('PATCH', '/contents/:id/strip/frames/:frameId', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const { frameId } = mnemonicFrameIdParamSchema.parse(req.params);
    const input = updateMnemonicFrameSchema.parse(req.body);
    const strip = await updateMnemonicFrameText(id, frameId, input, actorOf(req));
    res.json(strip);
  },
);

/**
 * DELETE /contents/:id/strip/frames/:frameId — remove um Quadro (FR-011-005).
 * Mesma amarração de `:frameId` à cadeia do `:id` de `PATCH` acima.
 */
tiraRoutes.delete(
  '/contents/:id/strip/frames/:frameId',
  verifyOrigin,
  requireRole('DELETE', '/contents/:id/strip/frames/:frameId', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const { frameId } = mnemonicFrameIdParamSchema.parse(req.params);
    const strip = await removeMnemonicFrame(id, frameId, actorOf(req));
    res.json(strip);
  },
);

/**
 * PUT /contents/:id/strip/frames/order — reordena os Quadros da Tira
 * (FR-011-006). Rota **estática**, ao lado da rota `:frameId` acima — chave
 * própria em `ROUTE_ROLES`, nunca herdada.
 */
tiraRoutes.put(
  '/contents/:id/strip/frames/order',
  verifyOrigin,
  requireRole('PUT', '/contents/:id/strip/frames/order', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const input = reorderMnemonicFramesSchema.parse(req.body);
    const strip = await reorderMnemonicFrames(id, input, actorOf(req));
    res.json(strip);
  },
);
