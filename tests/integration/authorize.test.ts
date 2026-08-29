import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import request from 'supertest';

import type { UserRole } from '../../src/domain/types';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { ForbiddenError, UnauthorizedError } from '../../src/http/errors';
import { requireAuth } from '../../src/http/middlewares/authenticate';
import { requireRole } from '../../src/http/middlewares/authorize';
import { errorHandler } from '../../src/http/middlewares/error-handler';
import {
  declareRouteRoles,
  resetRouteRoles,
  rolesForPath,
  ROUTE_ROLES,
  sealRouteRoles,
} from '../../src/http/route-roles';
import { logger } from '../../src/lib/logger';
import type { AuthContext } from '../../src/modules/auth/auth.service';
import { resolveAccessSession } from '../../src/modules/auth/auth.service';

/**
 * `requireRole` como unidade (`req`/`res`/`next` falsos — perfil §7) e o registro
 * `route-roles.ts` que ele alimenta. Cobre AC-002-011 (403 + auditoria por papel
 * insuficiente; ADMIN passa), a declaração canônica **em tempo de montagem** e a
 * chave método-aware.
 *
 * O retry da Wave 4 corrigiu quatro faces do mesmo defeito: declaração dentro do
 * handler de request, chave sem método, casamento por padrão cruzando métodos, e
 * registro sem selo. Os `[retry]` abaixo fixam cada face com o mutante que a
 * ressuscita.
 */

jest.mock('../../src/modules/auth/auth.service', () => ({
  resolveAccessSession: jest.fn(),
}));

const mockResolve = jest.mocked(resolveAccessSession);

interface FakeReqOpts {
  role?: UserRole;
  userId?: string;
  ip?: string | null;
  noAuth?: boolean;
}

function fakeReq(opts: FakeReqOpts = {}): Request {
  const req: Record<string, unknown> = {
    path: '/widgets',
    method: 'GET',
    get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'jest-suite/1.0' : undefined),
  };
  if (opts.ip !== null) req.ip = opts.ip ?? '198.51.100.5';
  if (!opts.noAuth && opts.role) {
    req.auth = {
      role: opts.role,
      userId: opts.userId ?? 'u-1',
      sessionId: 's-1',
    } satisfies AuthContext;
  }
  return req as unknown as Request;
}

function spyAuthLog(): jest.SpyInstance {
  return jest.spyOn(logger, 'info').mockImplementation(() => undefined);
}

function authzDeniedEvents(info: jest.SpyInstance): Array<Record<string, unknown>> {
  return info.mock.calls
    .map((call) => (call[0] as { audit?: Record<string, unknown> }).audit)
    .filter((audit): audit is Record<string, unknown> => audit?.type === 'authz.denied');
}

beforeEach(() => {
  resetRouteRoles();
  mockResolve.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('requireRole — AC-002-011: papel insuficiente vs. papel suficiente', () => {
  it('EDITOR contra requireRole(GET,/x,ADMIN): next recebe ForbiddenError e audita authz.denied 1×', () => {
    const info = spyAuthLog();
    const next = jest.fn() as unknown as NextFunction;

    requireRole('GET', '/x', 'ADMIN')(
      fakeReq({ role: 'EDITOR', userId: 'u-editor' }),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(ForbiddenError);

    const denied = authzDeniedEvents(info);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      subject: 'u-editor',
      outcome: 'failure',
      ip: '198.51.100.5',
    });
  });

  it('ADMIN contra requireRole(GET,/x,ADMIN): next() sem argumento e nenhuma auditoria', () => {
    const info = spyAuthLog();
    const next = jest.fn() as unknown as NextFunction;

    requireRole('GET', '/x', 'ADMIN')(fakeReq({ role: 'ADMIN' }), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0]).toEqual([]);
    expect(authzDeniedEvents(info)).toHaveLength(0);
  });

  it('EDITOR alcança requireRole(GET,/x,EDITOR,ADMIN) — vale o conjunto, não só o primeiro papel', () => {
    const next = jest.fn() as unknown as NextFunction;

    requireRole('GET', '/x', 'EDITOR', 'ADMIN')(fakeReq({ role: 'EDITOR' }), {} as Response, next);

    expect((next as jest.Mock).mock.calls[0]).toEqual([]);
  });

  it('o payload de authz.denied não carrega material sensível (asserção estrutural sobre as chaves)', () => {
    const info = spyAuthLog();

    requireRole('GET', '/x', 'ADMIN')(
      fakeReq({ role: 'STUDENT', userId: 'u-stu' }),
      {} as Response,
      jest.fn(),
    );

    const [event] = authzDeniedEvents(info);
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ['at', 'ip', 'outcome', 'subject', 'type', 'userAgent'].sort(),
    );
    for (const forbidden of ['token', 'accessToken', 'refreshToken', 'cookie', 'password']) {
      expect(event).not.toHaveProperty(forbidden);
    }
  });

  it('o evento leva ip como string vazia — nunca undefined — quando req.ip não resolveu', () => {
    const info = spyAuthLog();

    requireRole('GET', '/x', 'ADMIN')(
      fakeReq({ role: 'EDITOR', ip: null }),
      {} as Response,
      jest.fn(),
    );

    expect(authzDeniedEvents(info)[0]?.ip).toBe('');
  });
});

describe('requireRole — sem req.auth (não passou por requireAuth)', () => {
  it('next recebe UnauthorizedError', () => {
    const next = jest.fn() as unknown as NextFunction;

    requireRole('GET', '/x', 'ADMIN')(fakeReq({ noAuth: true }), {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
  });
});

describe('requireRole — sem papéis', () => {
  it('lança na construção: rota não pode nascer sem papel declarado', () => {
    expect(() => requireRole('GET', '/x')).toThrow();
  });
});

describe('[retry] requireRole declara em ROUTE_ROLES na AVALIAÇÃO DA CHAMADA — nunca no handler', () => {
  it('a chave existe assim que requireRole(...) é chamado, sem invocar o guard devolvido', () => {
    requireRole('GET', '/gestao', 'ADMIN');

    expect(ROUTE_ROLES.has('GET /gestao')).toBe(true);
    expect([...(ROUTE_ROLES.get('GET /gestao') ?? [])]).toEqual(['ADMIN']);
  });

  it('exercer o guard 10× não muda o tamanho do registro (nenhuma chave derivada de request)', () => {
    const guard = requireRole('GET', '/users/:id', 'ADMIN');
    const sizeAfterMount = ROUTE_ROLES.size;

    for (let i = 0; i < 10; i += 1) {
      const req = fakeReq({ role: 'ADMIN' });
      (req as unknown as { path: string }).path = `/users/${i}`;
      guard(req, {} as Response, jest.fn());
    }

    expect(ROUTE_ROLES.size).toBe(sizeAfterMount);
  });
});

describe('[retry] registro selado após boot', () => {
  it('sealRouteRoles() e então declareRouteRoles(...) → lança', () => {
    sealRouteRoles();

    expect(() => declareRouteRoles('GET', '/x', ['ADMIN'])).toThrow(/selad/i);
  });

  it('requireRole(...) após o selo também lança (a declaração é da avaliação da chamada)', () => {
    sealRouteRoles();

    expect(() => requireRole('GET', '/x', 'ADMIN')).toThrow(/selad/i);
  });

  it('resetRouteRoles() dessela — declaração volta a ser aceita', () => {
    sealRouteRoles();
    resetRouteRoles();

    expect(() => declareRouteRoles('GET', '/x', ['ADMIN'])).not.toThrow();
  });

  it('num fluxo montado + selado, ROUTE_ROLES.size é estável entre a 1ª e a 10ª requisição', async () => {
    mockResolve.mockResolvedValue({ userId: 'u-adm', role: 'ADMIN', sessionId: 's' });

    const app = express();
    app.use(cookieParser());
    const api = Router();
    api.use(requireAuth);
    api.get('/users/:id', requireRole('GET', '/users/:id', 'ADMIN'), (_req, res) =>
      res.json({ ok: true }),
    );
    app.use(api);
    app.use(errorHandler);
    sealRouteRoles();

    const sizeBefore = ROUTE_ROLES.size;
    for (let i = 1; i <= 10; i += 1) {
      const res = await request(app).get(`/users/${i}`).set('Cookie', `${ACCESS_COOKIE}=tok`);
      expect(res.status).toBe(200);
    }

    expect(ROUTE_ROLES.size).toBe(sizeBefore);
  });
});

describe('route-roles — rolesForPath: exato e por padrão, método-aware', () => {
  it('igualdade exata na chave método+caminho resolve', () => {
    declareRouteRoles('GET', '/users', ['ADMIN']);

    expect(rolesForPath('GET', '/users')).toEqual(new Set<UserRole>(['ADMIN']));
  });

  it('padrão com :param casa o caminho concreto do mesmo método', () => {
    declareRouteRoles('POST', '/users/:id/reset-password', ['ADMIN']);

    expect(rolesForPath('POST', '/users/42/reset-password')).toEqual(new Set<UserRole>(['ADMIN']));
  });

  it('caminho não declarado → undefined (a falha fechada é do chamador)', () => {
    declareRouteRoles('GET', '/users/:id', ['ADMIN']);

    expect(rolesForPath('GET', '/outra-coisa')).toBeUndefined();
    expect(rolesForPath('GET', '/users/42/extra')).toBeUndefined();
  });

  it('[retry] chave método-aware: DELETE /decks/:id não herda os papéis de GET /decks/:id', () => {
    declareRouteRoles('GET', '/decks/:id', ['EDITOR', 'ADMIN']);
    declareRouteRoles('DELETE', '/decks/:id', ['ADMIN']);

    expect(rolesForPath('GET', '/decks/42')).toEqual(new Set<UserRole>(['EDITOR', 'ADMIN']));
    expect(rolesForPath('DELETE', '/decks/42')).toEqual(new Set<UserRole>(['ADMIN']));
  });

  it('[retry] casamento por padrão não cruza métodos: só GET declarado → POST do mesmo caminho é undefined', () => {
    declareRouteRoles('GET', '/decks/:id', ['EDITOR', 'ADMIN']);

    expect(rolesForPath('POST', '/decks/42')).toBeUndefined();
    expect(rolesForPath('DELETE', '/decks/42')).toBeUndefined();
  });
});

describe('route-roles — declareRouteRoles: idempotente, conflito lança, método distinto coexiste', () => {
  it('redeclarar o mesmo par com os mesmos papéis (em qualquer ordem) é no-op', () => {
    declareRouteRoles('GET', '/x', ['EDITOR', 'ADMIN']);

    expect(() => declareRouteRoles('GET', '/x', ['ADMIN', 'EDITOR'])).not.toThrow();
    expect(rolesForPath('GET', '/x')).toEqual(new Set<UserRole>(['EDITOR', 'ADMIN']));
  });

  it('redeclarar o mesmo par com papéis diferentes lança (erro de montagem)', () => {
    declareRouteRoles('GET', '/x', ['ADMIN']);

    expect(() => declareRouteRoles('GET', '/x', ['EDITOR'])).toThrow(/conflitante/);
  });

  it('[retry] GET e DELETE do mesmo caminho com papéis distintos coexistem sem lançar', () => {
    declareRouteRoles('GET', '/decks/:id', ['EDITOR', 'ADMIN']);

    expect(() => declareRouteRoles('DELETE', '/decks/:id', ['ADMIN'])).not.toThrow();
    expect([...(ROUTE_ROLES.get('GET /decks/:id') ?? [])].sort()).toEqual(['ADMIN', 'EDITOR']);
    expect([...(ROUTE_ROLES.get('DELETE /decks/:id') ?? [])]).toEqual(['ADMIN']);
  });

  it('declarar sem nenhum papel lança', () => {
    expect(() => declareRouteRoles('GET', '/x', [])).toThrow();
  });
});

describe('route-roles — resetRouteRoles', () => {
  it('esvazia o registro', () => {
    declareRouteRoles('GET', '/x', ['ADMIN']);

    resetRouteRoles();

    expect(rolesForPath('GET', '/x')).toBeUndefined();
    expect(ROUTE_ROLES.size).toBe(0);
  });
});
