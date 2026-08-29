import type { AuthContext } from '../modules/auth/auth.service';

/**
 * Aumento de `Express.Request` com a identidade da requisição autenticada.
 *
 * `req.auth` é anexado por `requireAuth` (`src/http/middlewares/authenticate.ts`)
 * a partir da sessão resolvida no servidor — **nunca** de parâmetro de rota ou de
 * query (NFR-002-002). Fica `undefined` em rota pública e em qualquer ponto antes
 * de `requireAuth`.
 *
 * O contrato `AuthContext` que atravessa middleware → rotas → services é o de
 * `auth.service.ts` (Wave 3); reaproveitado aqui para não duplicar a forma.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
