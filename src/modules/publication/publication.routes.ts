import { Router, type Request } from 'express';

import { UnauthorizedError } from '../../http/errors';
import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import { rawContentIdParamSchema } from '../contents/contents.schema';
import type { ContentActor } from '../contents/contents.service';
import { exportPublicationBodySchema } from './publication.schema';
import { exportPublication } from './publication.service';

/**
 * Superfície HTTP da exportação de PDF (COMP-025-006, PLAN-025 §3) — único ponto de
 * entrada de `exportPublication` (`publication.service.ts`, TASK-025-008): recebe o
 * pedido, valida com os schemas de TASK-025-006 e transporta o `Buffer`/erro de volta
 * ao cliente.
 *
 * **Esta rota é a barreira de autorização REAL do pipeline (NFR-024-003)**:
 * `publication.service.ts` deliberadamente não checa papel/sessão — todo o
 * deny-by-default EDITOR/ADMIN depende de `requireRole(...)` abaixo, avaliado na
 * montagem (mesmo padrão de `tira.routes.ts`/`visual-associations.routes.ts`).
 *
 * `verifyOrigin` é o 1º handler (DEC-025-004): a rota TEM efeito colateral real (pode
 * auto-gerar a Tira e sempre grava 2 eventos em sucesso, mesmo devolvendo um binário
 * como resposta) — mesma razão de DEC-012-011, que moveu a geração de Tira de `GET`
 * para `POST`.
 *
 * Sem `try/catch`: o Express 5 encaminha a rejeição ao `errorHandler` —
 * `NotFoundError`/`GenerationTimeoutError` do service viram 404/503 automaticamente
 * (o único caminho para `ConflictError`, via `openMnemonicStrip`, é inalcançável
 * aqui: a Quebra da regra já foi confirmada no Passo 2 de `exportPublication`).
 */
export const publicationRoutes = Router();

/**
 * `req.auth` sempre existe aqui (a rota roda depois de `requireAuth` + `requireRole`,
 * que já recusaram sessão ausente/papel insuficiente) — a checagem é defesa em
 * profundidade, mesmo padrão de `tira.routes.ts`/`visual-associations.routes.ts`.
 */
function actorOf(req: Request): ContentActor {
  if (req.auth === undefined) throw new UnauthorizedError();
  return { id: req.auth.userId, role: req.auth.role };
}

/**
 * POST /contents/:id/publication — exporta o PDF (rascunho) da Variante pedida no
 * corpo (DEC-025-004: 1 rota, `variant` no corpo, nunca 2 rotas por Variante nem
 * `GET` com efeito colateral). `:id` validado por `rawContentIdParamSchema` (reuso de
 * `contents.schema.ts`, mesmo padrão de `tira.routes.ts` — sem schema de param
 * próprio deste módulo).
 *
 * Sucesso: binário `application/pdf`, `Content-Disposition: attachment` — nunca
 * `inline` (distingue de `visual-associations.routes.ts`, que serve imagem para
 * exibição embutida; aqui é download, FR-024-008).
 */
publicationRoutes.post(
  '/contents/:id/publication',
  verifyOrigin,
  requireRole('POST', '/contents/:id/publication', 'EDITOR', 'ADMIN'),
  async (req, res) => {
    const { id } = rawContentIdParamSchema.parse(req.params);
    const input = exportPublicationBodySchema.parse(req.body);
    const { buffer, filename } = await exportPublication(id, input, actorOf(req));

    res
      .type('application/pdf')
      .set('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buffer);
  },
);
