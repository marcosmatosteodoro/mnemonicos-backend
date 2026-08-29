import type { Request, Response } from 'express';

import type { UserRole } from '../../src/domain/types';
import { ForbiddenError, UnauthorizedError } from '../../src/http/errors';
import { requireRole } from '../../src/http/middlewares/authorize';
import {
  declareRouteRoles,
  resetRouteRoles,
  rolesForPath,
  ROUTE_ROLES,
} from '../../src/http/route-roles';
import { logger } from '../../src/lib/logger';

/**
 * `requireRole` exercitado como unidade, com `req`/`res`/`next` falsos (perfil
 * §7 — a alternativa a `supertest` quando o foco é a decisão do middleware).
 * Cobre AC-002-011 (403 + auditoria por papel insuficiente; ADMIN passa), a
 * declaração canônica em `ROUTE_ROLES` e o registro em si (`route-roles.ts`).
 */

interface FakeReqOpts {
  role?: UserRole;
  userId?: string;
  routePath?: string;
  noRoute?: boolean;
  path?: string;
  /** `null` simula `req.ip` ausente (fora do ciclo normal do Express). */
  ip?: string | null;
}

function fakeReq(opts: FakeReqOpts = {}): Request {
  const req: Record<string, unknown> = {
    path: opts.path ?? '/widgets',
    get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'jest-suite/1.0' : undefined),
  };
  if (opts.ip !== null) req.ip = opts.ip ?? '198.51.100.5';
  if (!opts.noRoute) req.route = { path: opts.routePath ?? '/widgets' };
  if (opts.role) {
    req.auth = { role: opts.role, userId: opts.userId ?? 'u-1', sessionId: 's-1' };
  }
  return req as unknown as Request;
}

function fakeRes(): Response {
  return {} as unknown as Response;
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
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('requireRole — AC-002-011: papel insuficiente vs. papel suficiente', () => {
  it('EDITOR contra requireRole(ADMIN): next recebe ForbiddenError e audita authz.denied 1×', () => {
    const info = spyAuthLog();
    const next = jest.fn();

    requireRole('ADMIN')(fakeReq({ role: 'EDITOR', userId: 'u-editor' }), fakeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));

    const denied = authzDeniedEvents(info);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      subject: 'u-editor',
      outcome: 'failure',
      ip: '198.51.100.5',
    });
  });

  it('ADMIN contra requireRole(ADMIN): next() sem argumento e nenhuma auditoria', () => {
    const info = spyAuthLog();
    const next = jest.fn();

    requireRole('ADMIN')(fakeReq({ role: 'ADMIN' }), fakeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toEqual([]);
    expect(authzDeniedEvents(info)).toHaveLength(0);
  });

  it('EDITOR alcança requireRole(EDITOR, ADMIN) — vale o conjunto, não só o primeiro papel', () => {
    const next = jest.fn();

    requireRole('EDITOR', 'ADMIN')(fakeReq({ role: 'EDITOR' }), fakeRes(), next);

    expect(next.mock.calls[0]).toEqual([]);
  });

  it('o payload de authz.denied não carrega material sensível (asserção estrutural)', () => {
    const info = spyAuthLog();

    requireRole('ADMIN')(fakeReq({ role: 'STUDENT', userId: 'u-stu' }), fakeRes(), jest.fn());

    const [event] = authzDeniedEvents(info);
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ['at', 'ip', 'outcome', 'subject', 'type', 'userAgent'].sort(),
    );
  });

  it('o evento leva ip como string vazia — nunca undefined — quando req.ip não resolveu', () => {
    const info = spyAuthLog();

    requireRole('ADMIN')(
      fakeReq({ role: 'EDITOR', userId: 'u-ed', ip: null }),
      fakeRes(),
      jest.fn(),
    );

    const [event] = authzDeniedEvents(info);
    expect(event?.ip).toBe('');
  });

  it('omite a chave userAgent do evento quando o cabeçalho não veio', () => {
    const info = spyAuthLog();
    const reqNoUa = fakeReq({ role: 'EDITOR', userId: 'u-ed' });
    (reqNoUa as unknown as { get: () => undefined }).get = () => undefined;

    requireRole('ADMIN')(reqNoUa, fakeRes(), jest.fn());

    const [event] = authzDeniedEvents(info);
    expect(event && 'userAgent' in event).toBe(false);
  });
});

describe('requireRole — sem req.auth (não passou por requireAuth)', () => {
  it('next recebe UnauthorizedError', () => {
    const next = jest.fn();

    requireRole('ADMIN')(fakeReq(), fakeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
  });
});

describe('requireRole — declaração canônica em ROUTE_ROLES', () => {
  it('grava o conjunto de papéis sob req.route.path ao ser exercida', () => {
    requireRole('ADMIN')(fakeReq({ role: 'ADMIN', routePath: '/widgets' }), fakeRes(), jest.fn());

    expect(ROUTE_ROLES.has('/widgets')).toBe(true);
    expect([...(ROUTE_ROLES.get('/widgets') ?? [])]).toEqual(['ADMIN']);
  });

  it('cai para req.path quando não há req.route (aplicação via router.use)', () => {
    requireRole('EDITOR', 'ADMIN')(
      fakeReq({ role: 'EDITOR', noRoute: true, path: '/painel' }),
      fakeRes(),
      jest.fn(),
    );

    expect([...(ROUTE_ROLES.get('/painel') ?? [])].sort()).toEqual(['ADMIN', 'EDITOR']);
  });

  it('registra mesmo quando a requisição é negada por papel — a rota existe, o acesso não', () => {
    spyAuthLog();

    requireRole('ADMIN')(fakeReq({ role: 'EDITOR', routePath: '/gestao' }), fakeRes(), jest.fn());

    expect([...(ROUTE_ROLES.get('/gestao') ?? [])]).toEqual(['ADMIN']);
  });
});

describe('requireRole — sem papéis', () => {
  it('lança na construção: rota não pode nascer sem papel declarado', () => {
    expect(() => requireRole()).toThrow();
  });
});

describe('route-roles — rolesForPath: casamento exato e por padrão', () => {
  it('igualdade exata resolve', () => {
    declareRouteRoles('/users', ['ADMIN']);

    expect(rolesForPath('/users')).toEqual(new Set<UserRole>(['ADMIN']));
  });

  it('padrão com :param casa o caminho concreto', () => {
    declareRouteRoles('/users/:id/disable', ['ADMIN']);

    expect(rolesForPath('/users/42/disable')).toEqual(new Set<UserRole>(['ADMIN']));
  });

  it('caminho não declarado → undefined (a falha fechada é do chamador)', () => {
    declareRouteRoles('/users/:id', ['ADMIN']);

    expect(rolesForPath('/outra-coisa')).toBeUndefined();
    expect(rolesForPath('/users/42/extra')).toBeUndefined();
  });
});

describe('route-roles — declareRouteRoles: idempotente, conflito lança', () => {
  it('redeclarar com os mesmos papéis (em qualquer ordem) é no-op', () => {
    declareRouteRoles('/x', ['EDITOR', 'ADMIN']);

    expect(() => declareRouteRoles('/x', ['ADMIN', 'EDITOR'])).not.toThrow();
    expect(rolesForPath('/x')).toEqual(new Set<UserRole>(['EDITOR', 'ADMIN']));
  });

  it('redeclarar o mesmo caminho com papéis diferentes lança (erro de montagem)', () => {
    declareRouteRoles('/x', ['ADMIN']);

    expect(() => declareRouteRoles('/x', ['EDITOR'])).toThrow(/conflitante/);
  });
});

describe('route-roles — resetRouteRoles', () => {
  it('esvazia o registro', () => {
    declareRouteRoles('/x', ['ADMIN']);

    resetRouteRoles();

    expect(rolesForPath('/x')).toBeUndefined();
    expect(ROUTE_ROLES.size).toBe(0);
  });
});
