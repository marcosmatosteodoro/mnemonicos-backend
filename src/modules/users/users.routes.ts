import { Router } from 'express';

import { requireRole } from '../../http/middlewares/authorize';
import { verifyOrigin } from '../auth/auth.routes';
import {
  createInternalUser,
  disableUser,
  listInternalUsers,
  resetUserPassword,
} from './users.service';
import {
  createUserSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  userIdParamSchema,
} from './users.schema';

/**
 * Superfície HTTP da gestão de contas internas (COMP-003-015), inteira restrita a
 * `ADMIN`. **Cada rota** declara o próprio par método+caminho via
 * `requireRole('<MÉTODO>', '<caminho completo>', 'ADMIN')` — a assinatura
 * método-aware da EMENDA da Wave 4 (DEC-003-005). Nunca
 * `usersRoutes.use(requireRole(...))` cego no topo: o guard cego derivava a
 * declaração de `req.path` relativo ao mount e envenenava `ROUTE_ROLES` (achado
 * crítico do gate 8 da Wave 4). `requireRole` declara em `ROUTE_ROLES` na
 * avaliação da chamada (montagem), então `requireAuth` já barra o não-ADMIN e o
 * não-declarado antes deste guard — que fica como defesa em profundidade.
 *
 * O `path` de cada `requireRole` é o caminho completo visto por `requireAuth` a
 * partir da raiz de `apiRoutes` (a árvore é montada plana em TASK-003-011).
 *
 * As **3 mutações de estado** (`POST /users`, `PATCH /users/:id/disable`,
 * `POST /users/:id/reset-password`) passam por `verifyOrigin` (COMP-003-010)
 * antes do handler: Route Handlers não herdam proteção CSRF e o cookie de sessão
 * é `sameSite: 'lax'`, então um POST/PATCH cross-site forjado ainda leva o
 * cookie — `Origin`/`Referer` fora de `CORS_ORIGINS` → 403 sem efeito (S2).
 *
 * Sem rota de auto-registro na superfície montada (FR-002-016 / AC-002-018). Sem
 * `try/catch`: o Express 5 encaminha a rejeição ao `errorHandler`.
 */
export const usersRoutes = Router();

/** GET /users — lista paginada de contas, sem material de senha/token. */
usersRoutes.get('/users', requireRole('GET', '/users', 'ADMIN'), async (req, res) => {
  const query = listUsersQuerySchema.parse(req.query);
  res.json(await listInternalUsers(query));
});

/** POST /users — cria conta interna com papel fixado (`EDITOR`/`ADMIN`). */
usersRoutes.post(
  '/users',
  verifyOrigin,
  requireRole('POST', '/users', 'ADMIN'),
  async (req, res) => {
    const input = createUserSchema.parse(req.body);
    res.status(201).json(await createInternalUser(input));
  },
);

/** PATCH /users/:id/disable — desativa (reversível) + revoga sessões; guarda do último ADMIN. */
usersRoutes.patch(
  '/users/:id/disable',
  verifyOrigin,
  requireRole('PATCH', '/users/:id/disable', 'ADMIN'),
  async (req, res) => {
    const { id } = userIdParamSchema.parse(req.params);
    await disableUser(id);
    res.status(200).json({ id, status: 'disabled' as const });
  },
);

/** POST /users/:id/reset-password — redefine a senha e revoga as sessões da conta. */
usersRoutes.post(
  '/users/:id/reset-password',
  verifyOrigin,
  requireRole('POST', '/users/:id/reset-password', 'ADMIN'),
  async (req, res) => {
    const { id } = userIdParamSchema.parse(req.params);
    const { password } = resetPasswordSchema.parse(req.body);
    await resetUserPassword(id, password);
    res.status(204).end();
  },
);
