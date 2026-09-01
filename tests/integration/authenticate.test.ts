import type { IRouter, NextFunction, Request, RequestHandler, Response } from 'express';
import cookieParser from 'cookie-parser';
import express, { type Express, Router } from 'express';
import request from 'supertest';

import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../src/http/cookies';
import { ForbiddenError, UnauthorizedError } from '../../src/http/errors';
import { requireAuth } from '../../src/http/middlewares/authenticate';
import { requireRole } from '../../src/http/middlewares/authorize';
import { errorHandler } from '../../src/http/middlewares/error-handler';
import { isPublicPath, PUBLIC_PATH_ALLOWLIST } from '../../src/http/public-paths';
import {
  declareRouteRoles,
  type HttpMethod,
  resetRouteRoles,
  ROUTE_ROLES,
} from '../../src/http/route-roles';
import { logger } from '../../src/lib/logger';
import type { AuthContext } from '../../src/modules/auth/auth.service';
import { resolveAccessSession } from '../../src/modules/auth/auth.service';

/**
 * `requireAuth` — o **piso de autorização**. A fronteira de processo
 * (`resolveAccessSession`, a consulta de sessão ao banco) é mockada; o foco é a
 * decisão do middleware: allowlist pública exata, deny-by-default por
 * `ROUTE_ROLES` método-aware (nega o não-declarado **e** o papel errado), fail
 * secure, precedência 401-antes-de-403, identidade sempre da sessão. Cobre
 * AC-002-010, AC-002-011, AC-002-012, AC-002-014, AC-002-015.
 *
 * O retry da Wave 4 nasceu de um caminho feliz de MONTAGEM que nunca foi
 * exercido: a primeira suíte abaixo constrói a `app` real e prova que o par
 * `requireAuth` + `requireRole` autoriza um ADMIN legítimo sem ninguém popular o
 * registro à mão — o oráculo que faltava.
 */

jest.mock('../../src/modules/auth/auth.service', () => ({
  resolveAccessSession: jest.fn(),
}));

const mockResolve = jest.mocked(resolveAccessSession);

const ADMIN_CTX: AuthContext = { userId: 'user-admin', role: 'ADMIN', sessionId: 'sess-admin' };
const EDITOR_CTX: AuthContext = { userId: 'user-editor', role: 'EDITOR', sessionId: 'sess-editor' };

interface RouteSpec {
  method?: HttpMethod;
  path: string;
  /** Papéis para o guard `requireRole` **e** para a declaração em `ROUTE_ROLES`. */
  guardRoles?: readonly AuthContext['role'][];
}

/**
 * `express.json()` + `cookie-parser` + `requireAuth` num router antes das rotas;
 * `errorHandler` real ao fim (traduz `UnauthorizedError`/`ForbiddenError` em
 * 401/403). Cada rota-alvo devolve um marcador e registra a passagem em
 * `reached` — um 401/403 que corta a cadeia antes do handler deixa `reached`
 * sem chamadas. Nenhuma chamada manual a `declareRouteRoles`: a declaração sai
 * de `requireRole`, no ponto de montagem.
 */
function buildApp(routes: RouteSpec[]): { app: Express; reached: jest.Mock } {
  const reached = jest.fn();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const api = Router();
  api.use(requireAuth);

  for (const spec of routes) {
    const method = spec.method ?? 'GET';
    const guards = spec.guardRoles ? [requireRole(method, spec.path, ...spec.guardRoles)] : [];
    const handler: RequestHandler = (req, res) => {
      reached(`${method} ${spec.path}`);
      res.json({ marker: 'conteudo-da-rota', auth: req.auth ?? null });
    };
    mount(api, method, spec.path, [...guards, handler]);
  }

  app.use(api);
  app.use(errorHandler);
  return { app, reached };
}

/** Monta `handlers` no verbo certo do router — switch em vez de índice dinâmico
 * (a união de overloads de `IRouter` não é chamável sob um índice string). */
function mount(
  router: IRouter,
  method: HttpMethod,
  path: string,
  handlers: RequestHandler[],
): void {
  switch (method) {
    case 'GET':
      router.get(path, ...handlers);
      return;
    case 'POST':
      router.post(path, ...handlers);
      return;
    case 'PUT':
      router.put(path, ...handlers);
      return;
    case 'PATCH':
      router.patch(path, ...handlers);
      return;
    case 'DELETE':
      router.delete(path, ...handlers);
      return;
  }
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/qualquer',
    cookies: {},
    ip: '203.0.113.7',
    get: () => undefined,
    ...overrides,
  } as unknown as Request;
}

function auditEvents(info: jest.SpyInstance, type: string): Array<Record<string, unknown>> {
  return info.mock.calls
    .map((call) => (call[0] as { audit?: Record<string, unknown> }).audit)
    .filter((audit): audit is Record<string, unknown> => audit?.type === type);
}

beforeEach(() => {
  resetRouteRoles();
  mockResolve.mockReset();
  mockResolve.mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('[retry] MONTAGEM do caminho feliz — requireAuth + requireRole autorizam um ADMIN legítimo', () => {
  it('GET /gestao com ACCESS_COOKIE e sessão de ADMIN → 200, sem popular ROUTE_ROLES à mão', async () => {
    mockResolve.mockResolvedValue(ADMIN_CTX);
    const { app, reached } = buildApp([{ path: '/gestao', guardRoles: ['ADMIN'] }]);

    const res = await request(app).get('/gestao').set('Cookie', `${ACCESS_COOKIE}=token-adm`);

    expect(res.status).toBe(200);
    expect(res.body.marker).toBe('conteudo-da-rota');
    expect(reached).toHaveBeenCalledWith('GET /gestao');
    expect(mockResolve).toHaveBeenCalledWith('token-adm', expect.any(Date));
  });

  it('a declaração de ROUTE_ROLES aconteceu na montagem — antes da 1ª requisição', () => {
    buildApp([{ path: '/gestao', guardRoles: ['ADMIN'] }]);

    expect(ROUTE_ROLES.has('GET /gestao')).toBe(true);
    expect([...(ROUTE_ROLES.get('GET /gestao') ?? [])]).toEqual(['ADMIN']);
  });
});

describe('[retry] requireAuth é piso de autorização — papel errado em rota declarada', () => {
  it('sessão EDITOR numa rota GET /gestao declarada ADMIN → 403 mesmo SEM o guard requireRole na cadeia', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    // Só a declaração — nenhum guard requireRole montado na rota.
    declareRouteRoles('GET', '/gestao', ['ADMIN']);
    const { app, reached } = buildApp([{ path: '/gestao' }]);

    const res = await request(app).get('/gestao').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(reached).not.toHaveBeenCalled();
  });

  it('a MESMA rota com sessão de ADMIN → 200 (prova que o 403 vem do papel, não da ausência de declaração)', async () => {
    mockResolve.mockResolvedValue(ADMIN_CTX);
    declareRouteRoles('GET', '/gestao', ['ADMIN']);
    const { app, reached } = buildApp([{ path: '/gestao' }]);

    const res = await request(app).get('/gestao').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledWith('GET /gestao');
  });
});

describe('[retry] chave método-aware — DELETE não herda a declaração do GET', () => {
  function decksApp(): { app: Express; reached: jest.Mock } {
    return buildApp([
      { method: 'GET', path: '/decks/:id', guardRoles: ['EDITOR', 'ADMIN'] },
      { method: 'DELETE', path: '/decks/:id', guardRoles: ['ADMIN'] },
    ]);
  }

  it('GET e DELETE de /decks/:id com papéis distintos coexistem sem declareRouteRoles lançar', () => {
    expect(() => decksApp()).not.toThrow();
    expect([...(ROUTE_ROLES.get('GET /decks/:id') ?? [])].sort()).toEqual(['ADMIN', 'EDITOR']);
    expect([...(ROUTE_ROLES.get('DELETE /decks/:id') ?? [])]).toEqual(['ADMIN']);
  });

  it('DELETE /decks/42 + EDITOR → 403, embora GET /decks/42 + EDITOR → 200', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const { app, reached } = decksApp();

    const del = await request(app).delete('/decks/42').set('Cookie', `${ACCESS_COOKIE}=tok`);
    const get = await request(app).get('/decks/42').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(del.status).toBe(403);
    expect(get.status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
    expect(reached).toHaveBeenCalledWith('GET /decks/:id');
  });
});

describe('[retry] casamento por padrão não vaza para rota irmã não declarada (AC-002-014)', () => {
  it('2º método no mesmo caminho sem guarda — POST /decks/42 com só GET declarado → 403', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const { app, reached } = buildApp([
      { method: 'GET', path: '/decks/:id', guardRoles: ['EDITOR', 'ADMIN'] },
      { method: 'POST', path: '/decks/:id' }, // montada sem requireRole → sem chave POST
    ]);

    const res = await request(app).post('/decks/42').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it('rota irmã estática GET /decks/export, vizinha de GET /decks/:id (ADMIN), com sessão EDITOR → 403', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const { app, reached } = buildApp([
      { method: 'GET', path: '/decks/:id', guardRoles: ['ADMIN'] },
      { method: 'GET', path: '/decks/export' }, // sem requireRole, sem chave própria
    ]);

    const res = await request(app).get('/decks/export').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(reached).not.toHaveBeenCalled();
  });
});

describe('[retry] deny-by-default audita — MUT-A + authz.denied no ramo de requireAuth', () => {
  it('caminho ausente da allowlist e de ROUTE_ROLES, sessão válida → 403 + 1 evento authz.denied sem material sensível', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const { app, reached } = buildApp([{ path: '/sem-declaracao' }]);

    const res = await request(app).get('/sem-declaracao').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();

    const denied = auditEvents(info, 'authz.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      subject: 'user-editor',
      outcome: 'failure',
      type: 'authz.denied',
    });
    for (const forbidden of ['token', 'accessToken', 'refreshToken', 'cookie', 'password']) {
      expect(denied[0]).not.toHaveProperty(forbidden);
    }
    // supertest não emite header User-Agent → o evento sai sem a chave userAgent.
    expect(Object.keys(denied[0] ?? {}).sort()).toEqual(
      ['at', 'ip', 'outcome', 'subject', 'type'].sort(),
    );
  });
});

describe('[retry] authz.denied de requireAuth sem user-agent — evento sem a chave userAgent', () => {
  it('papel errado em rota declarada, request sem user-agent → 1 evento authz.denied com o conjunto EXATO de chaves', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    declareRouteRoles('GET', '/x', ['ADMIN']);
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const req = fakeReq({ path: '/x', method: 'GET', get: () => undefined });
    const next = jest.fn() as unknown as NextFunction;

    await requireAuth(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(ForbiddenError);
    const denied = auditEvents(info, 'authz.denied');
    expect(denied).toHaveLength(1);
    expect(Object.keys(denied[0] ?? {}).sort()).toEqual(
      ['at', 'ip', 'outcome', 'subject', 'type'].sort(),
    );
  });
});

describe('[retry] MUT-C — return provado em CADA ramo de recusa de requireAuth', () => {
  it('(a) sessão null → next(UnauthorizedError) exatamente 1×, corpo abaixo não roda', async () => {
    declareRouteRoles('GET', '/x', ['EDITOR', 'ADMIN']);
    mockResolve.mockResolvedValue(null);
    const req = fakeReq({ path: '/x', method: 'GET' });
    const next = jest.fn() as unknown as NextFunction;

    await expect(requireAuth(req, {} as Response, next)).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    expect(req.auth).toBeUndefined();
  });

  it('(b) papel errado em rota declarada → next(ForbiddenError) exatamente 1×, req.auth não é anexado', async () => {
    declareRouteRoles('GET', '/x', ['ADMIN']);
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const req = fakeReq({ path: '/x', method: 'GET' });
    const next = jest.fn() as unknown as NextFunction;

    await expect(requireAuth(req, {} as Response, next)).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(ForbiddenError);
    expect(req.auth).toBeUndefined();
  });

  it('(c) resolveAccessSession lança → nega com next(UnauthorizedError) 1×, causa ao log', async () => {
    const errSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    declareRouteRoles('GET', '/x', ['EDITOR', 'ADMIN']);
    mockResolve.mockRejectedValue(new Error('banco fora'));
    const req = fakeReq({ path: '/x', method: 'GET' });
    const next = jest.fn() as unknown as NextFunction;

    await expect(requireAuth(req, {} as Response, next)).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('[retry] MUT-B — precedência 401 antes de 403 no par que coincide', () => {
  it('sem sessão vence caminho não declarado (401 antes de 403)', async () => {
    mockResolve.mockResolvedValue(null); // sem sessão
    const { app } = buildApp([{ path: '/nunca-declarada' }]); // sem guardRoles → sem chave

    const res = await request(app).get('/nunca-declarada');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('mesma precedência na unidade: next recebe UnauthorizedError, nunca ForbiddenError', async () => {
    mockResolve.mockResolvedValue(null);
    const req = fakeReq({ path: '/nunca-declarada', method: 'GET' });
    const next = jest.fn() as unknown as NextFunction;

    await requireAuth(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    expect((next as jest.Mock).mock.calls[0][0]).not.toBeInstanceOf(ForbiddenError);
  });
});

describe('[retry] MUT-F — isPublicPath por igualdade exata do par método+caminho, nunca prefixo', () => {
  it('caminhos que só compartilham prefixo com a allowlist não são públicos', () => {
    expect(isPublicPath('GET', '/auth/login-como-admin')).toBe(false);
    expect(isPublicPath('GET', '/health/db-dump')).toBe(false);
    expect(isPublicPath('GET', '/health')).toBe(true);
    expect(isPublicPath('POST', '/auth/login')).toBe(true);
    // método fora do par declarado não é público (EMENDA DEC-003-005 Wave 6)
    expect(isPublicPath('POST', '/health')).toBe(false);
    expect(isPublicPath('GET', '/auth/login')).toBe(false);
  });

  it('requisição sem cookie a /auth/login-como-admin e /health/db-dump → 401 (não escapam pela allowlist)', async () => {
    mockResolve.mockResolvedValue(null);
    const { app } = buildApp([{ path: '/auth/login-como-admin' }, { path: '/health/db-dump' }]);

    const a = await request(app).get('/auth/login-como-admin');
    const b = await request(app).get('/health/db-dump');

    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(mockResolve).toHaveBeenCalledTimes(2);
  });
});

describe('AC-002-010: rota não-pública sem sessão + allowlist pública', () => {
  it('rota não-pública sem sessão → 401, sem corpo específico da rota, handler seguinte não roda', async () => {
    declareRouteRoles('GET', '/relatorios', ['EDITOR', 'ADMIN']);
    const { app, reached } = buildApp([{ path: '/relatorios', guardRoles: ['EDITOR', 'ADMIN'] }]);

    const res = await request(app).get('/relatorios');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toContain('conteudo-da-rota');
    expect(reached).not.toHaveBeenCalled();
  });

  it('cada par de PUBLIC_PATH_ALLOWLIST responde 200 sem cookie e sem resolver sessão', async () => {
    const specs = PUBLIC_PATH_ALLOWLIST.map((entry) => {
      const [method, path] = entry.split(' ') as [HttpMethod, string];
      return { method, path };
    });
    const { app, reached } = buildApp(specs);

    for (const { method, path } of specs) {
      const res = await (method === 'GET' ? request(app).get(path) : request(app).post(path));
      expect(res.status).toBe(200);
    }

    expect(reached).toHaveBeenCalledTimes(PUBLIC_PATH_ALLOWLIST.length);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('PUBLIC_PATH_ALLOWLIST é exatamente os quatro pares previstos', () => {
    expect([...PUBLIC_PATH_ALLOWLIST].sort()).toEqual([
      'GET /health',
      'GET /health/db',
      'POST /auth/login',
      'POST /auth/refresh',
    ]);
  });
});

describe('AC-002-012: papel conferido no servidor a cada requisição, sem passar pelo cliente', () => {
  it('rota requireRole(ADMIN) + sessão de EDITOR → 403', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const { app, reached } = buildApp([{ path: '/admin-only', guardRoles: ['ADMIN'] }]);

    const res = await request(app).get('/admin-only').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it('resolve a sessão a cada requisição — duas chamadas, dois resolves com o token de cada uma', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    const { app } = buildApp([{ path: '/painel', guardRoles: ['EDITOR', 'ADMIN'] }]);

    await request(app).get('/painel').set('Cookie', `${ACCESS_COOKIE}=t1`);
    await request(app).get('/painel').set('Cookie', `${ACCESS_COOKIE}=t2`);

    expect(mockResolve).toHaveBeenNthCalledWith(1, 't1', expect.any(Date));
    expect(mockResolve).toHaveBeenNthCalledWith(2, 't2', expect.any(Date));
  });
});

describe('AC-002-015 / NFR-002-002: identidade da sessão, nunca do parâmetro', () => {
  it('req.auth.userId é o da sessão mesmo com :userId e ?userId divergentes', async () => {
    mockResolve.mockResolvedValue({ userId: 'user-A', role: 'EDITOR', sessionId: 'sess-A' });
    const { app } = buildApp([{ path: '/contas/:userId', guardRoles: ['EDITOR', 'ADMIN'] }]);

    const res = await request(app)
      .get('/contas/user-B?userId=user-C')
      .set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(200);
    expect(res.body.auth.userId).toBe('user-A');
  });
});

describe('contrato AuthContext em req.auth após requireAuth', () => {
  it('os três campos chegam preenchidos e tipados no handler', async () => {
    const ctx: AuthContext = { userId: 'u-1', role: 'ADMIN', sessionId: 's-1' };
    mockResolve.mockResolvedValue(ctx);

    const app = express();
    app.use(cookieParser());
    const api = Router();
    api.use(requireAuth);
    api.get('/eu', requireRole('GET', '/eu', 'EDITOR', 'ADMIN'), (req, res) => {
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
    const { app } = buildApp([{ path: '/x', guardRoles: ['EDITOR', 'ADMIN'] }]);

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

    const app = express();
    const api = Router();
    api.use(requireAuth);
    api.get('/w', requireRole('GET', '/w', 'EDITOR', 'ADMIN'), (_req, res) =>
      res.json({ ok: true }),
    );
    app.use(api);
    app.use(errorHandler);

    const res = await request(app).get('/w');

    expect(res.status).toBe(401);
    expect(mockResolve).toHaveBeenCalledWith('', expect.any(Date));
  });
});

describe('fail secure: erro ao resolver a sessão nega (supertest)', () => {
  it('resolveAccessSession que rejeita → 401 (não 500), handler não roda, causa ao log', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockResolve.mockRejectedValue(new Error('banco indisponível'));
    const { app, reached } = buildApp([{ path: '/z', guardRoles: ['EDITOR', 'ADMIN'] }]);

    const res = await request(app).get('/z').set('Cookie', `${ACCESS_COOKIE}=tok`);

    expect(res.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
