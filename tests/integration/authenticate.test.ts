import cookieParser from 'cookie-parser';
import express, { type Express, Router } from 'express';
import request from 'supertest';

import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../src/http/cookies';
import { requireAuth } from '../../src/http/middlewares/authenticate';
import { requireRole } from '../../src/http/middlewares/authorize';
import { errorHandler } from '../../src/http/middlewares/error-handler';
import { PUBLIC_PATH_ALLOWLIST } from '../../src/http/public-paths';
import { declareRouteRoles, resetRouteRoles } from '../../src/http/route-roles';
import { logger } from '../../src/lib/logger';
import type { AuthContext } from '../../src/modules/auth/auth.service';
import { resolveAccessSession } from '../../src/modules/auth/auth.service';

/**
 * `requireAuth` sobre uma `app` mínima montada com `supertest` (integração de
 * rota — perfil §7). A fronteira de processo é `resolveAccessSession` (a consulta
 * de sessão ao banco): mockada, para o foco ser a decisão do middleware —
 * allowlist pública, deny-by-default por `ROUTE_ROLES`, fail secure, identidade
 * sempre da sessão. Cobre AC-002-010, AC-002-012, AC-002-014, AC-002-015.
 */

jest.mock('../../src/modules/auth/auth.service', () => ({
  resolveAccessSession: jest.fn(),
}));

const mockResolve = jest.mocked(resolveAccessSession);

const EDITOR_CTX: AuthContext = { userId: 'user-A', role: 'EDITOR', sessionId: 'sess-A' };

interface RouteSpec {
  path: string;
  roles?: readonly AuthContext['role'][];
}

/**
 * `requireAuth` num router antes das rotas de teste; `errorHandler` real ao fim
 * (traduz `UnauthorizedError`/`ForbiddenError` em 401/403). Cada rota-alvo
 * devolve um marcador no corpo e registra a passagem em `reached` — um 401/403
 * que corta a cadeia antes do handler deixa `reached` sem chamadas.
 */
function buildApp(routes: RouteSpec[]): { app: Express; reached: jest.Mock } {
  const reached = jest.fn();
  const app = express();
  app.use(cookieParser());

  const api = Router();
  api.use(requireAuth);

  for (const spec of routes) {
    const guards = spec.roles ? [requireRole(...spec.roles)] : [];
    api.get(spec.path, ...guards, (req, res) => {
      reached(spec.path);
      res.json({ marker: 'conteudo-da-rota', auth: req.auth ?? null });
    });
  }

  app.use(api);
  app.use(errorHandler);
  return { app, reached };
}

beforeEach(() => {
  resetRouteRoles();
  mockResolve.mockReset();
  mockResolve.mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AC-002-010 / AC-002-012: rota não-pública sem sessão', () => {
  it('responde 401, sem corpo específico da rota, e o handler seguinte não roda', async () => {
    declareRouteRoles('/relatorios', ['EDITOR', 'ADMIN']);
    const { app, reached } = buildApp([{ path: '/relatorios', roles: ['EDITOR', 'ADMIN'] }]);

    const res = await request(app).get('/relatorios');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    expect(JSON.stringify(res.body)).not.toContain('conteudo-da-rota');
    expect(reached).not.toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith('', expect.any(Date));
  });
});

describe('AC-002-010: allowlist pública passa sem sessão', () => {
  it('cada caminho de PUBLIC_PATH_ALLOWLIST responde 200 sem cookie e sem resolver sessão', async () => {
    const { app, reached } = buildApp(PUBLIC_PATH_ALLOWLIST.map((path) => ({ path })));

    for (const path of PUBLIC_PATH_ALLOWLIST) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    }

    expect(reached).toHaveBeenCalledTimes(PUBLIC_PATH_ALLOWLIST.length);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('PUBLIC_PATH_ALLOWLIST é exatamente os quatro caminhos previstos', () => {
    expect([...PUBLIC_PATH_ALLOWLIST].sort()).toEqual([
      '/auth/login',
      '/auth/refresh',
      '/health',
      '/health/db',
    ]);
  });
});

describe('AC-002-014: rota autenticada sem declaração de papel', () => {
  it('nega com 403 mesmo com sessão de EDITOR válida (falha fechada)', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const { app, reached } = buildApp([{ path: '/sem-papel' }]);

    const res = await request(app).get('/sem-papel').set('Cookie', `${ACCESS_COOKIE}=token-valido`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(reached).not.toHaveBeenCalled();
  });

  it('o MESMO caminho passa quando declarado em ROUTE_ROLES — prova que o 403 vem da ausência de declaração', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    declareRouteRoles('/sem-papel', ['EDITOR', 'ADMIN']);
    const { app, reached } = buildApp([{ path: '/sem-papel' }]);

    const res = await request(app).get('/sem-papel').set('Cookie', `${ACCESS_COOKIE}=token-valido`);

    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledWith('/sem-papel');
  });
});

describe('AC-002-012: papel conferido no servidor a cada requisição', () => {
  it('rota requireRole(ADMIN) + sessão de EDITOR → 403, sem passar pelo cliente', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    declareRouteRoles('/admin-only', ['ADMIN']);
    const { app, reached } = buildApp([{ path: '/admin-only', roles: ['ADMIN'] }]);

    const res = await request(app)
      .get('/admin-only')
      .set('Cookie', `${ACCESS_COOKIE}=token-valido`);

    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it('resolve a sessão a cada requisição — duas chamadas, dois resolves com o token de cada uma', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    declareRouteRoles('/painel', ['EDITOR', 'ADMIN']);
    const { app } = buildApp([{ path: '/painel', roles: ['EDITOR', 'ADMIN'] }]);

    await request(app).get('/painel').set('Cookie', `${ACCESS_COOKIE}=t1`);
    await request(app).get('/painel').set('Cookie', `${ACCESS_COOKIE}=t2`);

    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(mockResolve).toHaveBeenNthCalledWith(1, 't1', expect.any(Date));
    expect(mockResolve).toHaveBeenNthCalledWith(2, 't2', expect.any(Date));
  });
});

describe('AC-002-015 / NFR-002-002: identidade da sessão, nunca do parâmetro', () => {
  it('req.auth.userId é o da sessão mesmo com :userId e ?userId divergentes', async () => {
    mockResolve.mockResolvedValue({ userId: 'user-A', role: 'EDITOR', sessionId: 'sess-A' });
    declareRouteRoles('/contas/:userId', ['EDITOR', 'ADMIN']);
    const { app } = buildApp([{ path: '/contas/:userId', roles: ['EDITOR', 'ADMIN'] }]);

    const res = await request(app)
      .get('/contas/user-B?userId=user-C')
      .set('Cookie', `${ACCESS_COOKIE}=token-valido`);

    expect(res.status).toBe(200);
    expect(res.body.auth.userId).toBe('user-A');
  });
});

describe('contrato AuthContext em req.auth após requireAuth', () => {
  it('os três campos chegam preenchidos e tipados no handler', async () => {
    const ctx: AuthContext = { userId: 'u-1', role: 'ADMIN', sessionId: 's-1' };
    mockResolve.mockResolvedValue(ctx);
    declareRouteRoles('/eu', ['EDITOR', 'ADMIN']);

    const app = express();
    app.use(cookieParser());
    const api = Router();
    api.use(requireAuth);
    api.get('/eu', (req, res) => {
      if (!req.auth) {
        res.status(500).json({ typed: false });
        return;
      }
      const { userId, role, sessionId } = req.auth;
      res.json({ userId, role, sessionId });
    });
    app.use(api);
    app.use(errorHandler);

    const res = await request(app).get('/eu').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.body).toEqual({ userId: 'u-1', role: 'ADMIN', sessionId: 's-1' });
  });
});

describe('ACCESS_COOKIE é a chave lida', () => {
  it('cookie com outro nome → 401; com ACCESS_COOKIE → resolve e passa', async () => {
    mockResolve.mockImplementation((token: string) =>
      Promise.resolve(token === 'bom' ? EDITOR_CTX : null),
    );
    declareRouteRoles('/x', ['EDITOR', 'ADMIN']);
    const { app } = buildApp([{ path: '/x', roles: ['EDITOR', 'ADMIN'] }]);

    const wrong = await request(app).get('/x').set('Cookie', `${REFRESH_COOKIE}=bom`);
    const right = await request(app).get('/x').set('Cookie', `${ACCESS_COOKIE}=bom`);

    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
  });

  it('nomes de cookie fixados', () => {
    expect(ACCESS_COOKIE).toBe('mnemo_access');
    expect(REFRESH_COOKIE).toBe('mnemo_refresh');
  });
});

describe('cookie ausente ou request sem parser de cookie', () => {
  it('sem cookie-parser montado (req.cookies indefinido) → resolve com token vazio e nega 401', async () => {
    mockResolve.mockResolvedValue(null);
    declareRouteRoles('/w', ['EDITOR', 'ADMIN']);

    const app = express();
    const api = Router();
    api.use(requireAuth);
    api.get('/w', requireRole('EDITOR', 'ADMIN'), (_req, res) => res.json({ ok: true }));
    app.use(api);
    app.use(errorHandler);

    const res = await request(app).get('/w');

    expect(res.status).toBe(401);
    expect(mockResolve).toHaveBeenCalledWith('', expect.any(Date));
  });
});

describe('fail secure: erro ao resolver a sessão nega', () => {
  it('resolveAccessSession que rejeita → 401 (não 500), handler não roda, causa ao log', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockResolve.mockRejectedValue(new Error('banco indisponível'));
    declareRouteRoles('/z', ['EDITOR', 'ADMIN']);
    const { app, reached } = buildApp([{ path: '/z', roles: ['EDITOR', 'ADMIN'] }]);

    const res = await request(app).get('/z').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
