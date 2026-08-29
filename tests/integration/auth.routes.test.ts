import cookieParser from 'cookie-parser';
import express, { type Express, Router } from 'express';
import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../src/http/cookies';
import { requireAuth } from '../../src/http/middlewares/authenticate';
import { errorHandler, notFoundHandler } from '../../src/http/middlewares/error-handler';
import { ROUTE_ROLES } from '../../src/http/route-roles';
import { apiRoutes } from '../../src/http/routes';
import type { UserRole } from '../../src/domain/types';
import { UnauthorizedError } from '../../src/http/errors';
import type { AuthContext, IssuedSession } from '../../src/modules/auth/auth.service';
import {
  accessCookieOptions,
  authRoutes,
  refreshCookieOptions,
} from '../../src/modules/auth/auth.routes';
import {
  changeOwnPassword,
  getSessionUser,
  login,
  logout,
  refresh,
  resolveAccessSession,
} from '../../src/modules/auth/auth.service';
import { cookie, setCookies } from './set-cookie';

/**
 * `auth.routes.ts` como unidade HTTP, sobre a mesma pilha de middlewares que
 * TASK-003-011 vai montar (`express.json` → `cookie-parser` → `requireAuth` →
 * router → `errorHandler`), com a **fronteira de processo** (`auth.service`)
 * mockada — o foco é a rota: flags de cookie da DEC-003-004, declaração
 * método-aware em `ROUTE_ROLES`, verificação de `Origin`/`Host` nas rotas POST,
 * corpo `SessionUser` sem token, `null` de `getSessionUser` → 401.
 *
 * O fluxo ponta-a-ponta com Postgres real (login persiste `Session`, rotação,
 * revogação, fixture ativa/desativada de `getSessionUser`) está em
 * `auth.routes.integration.test.ts`.
 */

jest.mock('../../src/modules/auth/auth.service', () => ({
  login: jest.fn(),
  refresh: jest.fn(),
  logout: jest.fn(),
  changeOwnPassword: jest.fn(),
  getSessionUser: jest.fn(),
  resolveAccessSession: jest.fn(),
}));

const mockLogin = jest.mocked(login);
const mockRefresh = jest.mocked(refresh);
const mockLogout = jest.mocked(logout);
const mockChangePassword = jest.mocked(changeOwnPassword);
const mockGetSessionUser = jest.mocked(getSessionUser);
const mockResolve = jest.mocked(resolveAccessSession);

const ALLOWED_ORIGIN = 'http://localhost:3000'; // fixado em tests/setup-env.ts
const EVIL_ORIGIN = 'https://evil.example';

const EDITOR_CTX: AuthContext = { userId: 'user-editor', role: 'EDITOR', sessionId: 'sess-editor' };
const STUDENT_CTX: AuthContext = {
  userId: 'user-student',
  role: 'STUDENT',
  sessionId: 'sess-student',
};

const SESSION_USER = {
  id: 'user-editor',
  name: 'Edna Editora',
  email: 'edna@example.com',
  role: 'EDITOR' as UserRole,
};

function issued(access: string, refreshValue: string): IssuedSession {
  return {
    user: SESSION_USER,
    access: { value: access, expiresAt: new Date(Date.now() + 900_000) },
    refresh: { value: refreshValue, expiresAt: new Date(Date.now() + 604_800_000) },
  };
}

function buildApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  const api = Router();
  api.use(requireAuth);
  api.use(authRoutes);
  app.use(api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function roleSet(...roles: UserRole[]): Set<UserRole> {
  return new Set(roles);
}

beforeEach(() => {
  mockLogin.mockReset();
  mockRefresh.mockReset();
  mockLogout.mockReset();
  mockChangePassword.mockReset();
  mockGetSessionUser.mockReset();
  mockResolve.mockReset();
  mockResolve.mockResolvedValue(null);
});

describe('accessCookieOptions / refreshCookieOptions — DEC-003-004', () => {
  it('mnemo_access: raiz do site, httpOnly, sameSite lax, maxAge do TTL de acesso, secure = env.COOKIE_SECURE', () => {
    expect(accessCookieOptions()).toEqual({
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      maxAge: env.AUTH_ACCESS_TTL_MINUTES * 60_000,
    });
  });

  it('mnemo_refresh: escopado a /api/v1/auth, maxAge do TTL longo, demais flags iguais', () => {
    expect(refreshCookieOptions()).toEqual({
      path: '/api/v1/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      maxAge: env.AUTH_REFRESH_TTL_DAYS * 86_400_000,
    });
  });

  it('o canal seguro acompanha env.COOKIE_SECURE (NFR-002-008), não é constante', () => {
    expect(accessCookieOptions().secure).toBe(env.COOKIE_SECURE);
    expect(refreshCookieOptions().secure).toBe(env.COOKIE_SECURE);
  });
});

describe('ROUTE_ROLES — rotas protegidas de auth declaram papel na montagem (AC-002-014)', () => {
  it('as três chaves método-aware existem com exatamente {EDITOR, ADMIN}', () => {
    expect(ROUTE_ROLES.get('POST /auth/logout')).toEqual(roleSet('EDITOR', 'ADMIN'));
    expect(ROUTE_ROLES.get('POST /auth/change-password')).toEqual(roleSet('EDITOR', 'ADMIN'));
    expect(ROUTE_ROLES.get('GET /auth/me')).toEqual(roleSet('EDITOR', 'ADMIN'));
  });

  it('as rotas públicas não entram em ROUTE_ROLES (ficam só na allowlist pública)', () => {
    expect(ROUTE_ROLES.has('POST /auth/login')).toBe(false);
    expect(ROUTE_ROLES.has('POST /auth/refresh')).toBe(false);
  });

  it('a chave carrega o método: outro verbo no mesmo caminho não é declarado', () => {
    expect(ROUTE_ROLES.has('GET /auth/logout')).toBe(false);
    expect(ROUTE_ROLES.has('DELETE /auth/me')).toBe(false);
    expect(ROUTE_ROLES.has('POST /auth/me')).toBe(false);
  });
});

describe('verifyOrigin — Origin/Host nas rotas POST (critério de pronto)', () => {
  it('POST /auth/login com Origin fora de CORS_ORIGINS → 403 e login não é chamado', async () => {
    const res = await request(buildApp())
      .post('/auth/login')
      .set('Origin', EVIL_ORIGIN)
      .send({ email: 'edna@example.com', password: 'senha-correta-123' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('POST /auth/login com Origin da allowlist → segue para o handler', async () => {
    mockLogin.mockResolvedValue(issued('acc-1', 'ref-1'));

    const res = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: 'edna@example.com', password: 'senha-correta-123' });

    expect(res.status).toBe(200);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('sem Origin nem Referer (cliente não-navegador) → segue', async () => {
    mockLogin.mockResolvedValue(issued('acc-1', 'ref-1'));

    const res = await request(buildApp())
      .post('/auth/login')
      .send({ email: 'edna@example.com', password: 'senha-correta-123' });

    expect(res.status).toBe(200);
  });

  it('Referer de host não permitido, sem Origin → 403', async () => {
    const res = await request(buildApp())
      .post('/auth/login')
      .set('Referer', `${EVIL_ORIGIN}/login`)
      .send({ email: 'edna@example.com', password: 'senha-correta-123' });

    expect(res.status).toBe(403);
    expect(mockLogin).not.toHaveBeenCalled();
  });
});

describe('POST /auth/login — cookies de sessão e corpo (AC-002-001)', () => {
  it('sucesso → dois Set-Cookie com os atributos estruturais da DEC-003-004', async () => {
    mockLogin.mockResolvedValue(issued('acc-tok', 'ref-tok'));

    const res = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: 'edna@example.com', password: 'senha-correta-123' });

    expect(res.status).toBe(200);

    const access = cookie(res, ACCESS_COOKIE);
    expect(access.value).toBe('acc-tok');
    expect(access.attrs).toMatchObject({ path: '/', httponly: true, samesite: 'Lax' });
    expect(access.attrs['max-age']).toBe(String(env.AUTH_ACCESS_TTL_MINUTES * 60));
    expect(access.attrs).not.toHaveProperty('secure'); // env.COOKIE_SECURE = false em teste

    const refreshCookie = cookie(res, REFRESH_COOKIE);
    expect(refreshCookie.value).toBe('ref-tok');
    expect(refreshCookie.attrs).toMatchObject({
      path: '/api/v1/auth',
      httponly: true,
      samesite: 'Lax',
    });
    expect(refreshCookie.attrs['max-age']).toBe(String(env.AUTH_REFRESH_TTL_DAYS * 86_400));
  });

  it('o corpo é o SessionUser exato — nenhum valor de token', async () => {
    mockLogin.mockResolvedValue(issued('acc-tok', 'ref-tok'));

    const res = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: 'edna@example.com', password: 'senha-correta-123' });

    expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'name', 'role']);
    expect(res.body).toEqual(SESSION_USER);
    for (const forbidden of ['accessToken', 'refreshToken', 'access', 'refresh', 'token']) {
      expect(res.body).not.toHaveProperty(forbidden);
    }
  });

  it('passa ao service as credenciais normalizadas + a origem da conexão (ip, user-agent)', async () => {
    mockLogin.mockResolvedValue(issued('acc-tok', 'ref-tok'));

    await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .set('User-Agent', 'jest-suite/1.0')
      .send({ email: 'edna@example.com', password: 'senha-correta-123' });

    expect(mockLogin).toHaveBeenCalledWith({
      email: 'edna@example.com',
      password: 'senha-correta-123',
      ip: expect.any(String),
      userAgent: 'jest-suite/1.0',
    });
  });

  it('credencial inválida (service lança UnauthorizedError) → 401 genérico, sem Set-Cookie', async () => {
    mockLogin.mockRejectedValue(new UnauthorizedError());

    const res = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: 'edna@example.com', password: 'errada' });

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('POST /auth/refresh — reemite os dois cookies; cookie-parser ativo (critérios 4 e 6)', () => {
  it('lê mnemo_refresh do cookie e reemite os dois cookies com os novos valores', async () => {
    mockRefresh.mockResolvedValue(issued('acc-2', 'ref-2'));

    const res = await request(buildApp())
      .post('/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=ref-1`)
      .send();

    expect(res.status).toBe(200);
    expect(cookie(res, ACCESS_COOKIE).value).toBe('acc-2');
    expect(cookie(res, REFRESH_COOKIE).value).toBe('ref-2');
    // O handler só enxerga 'ref-1' se o cookie-parser parseou req.cookies.
    expect(mockRefresh).toHaveBeenCalledWith('ref-1', expect.any(Object), expect.any(Date));
  });

  it('sem cookie de refresh → service recebe undefined e a recusa vira 401', async () => {
    mockRefresh.mockRejectedValue(new UnauthorizedError());

    const res = await request(buildApp()).post('/auth/refresh').send();

    expect(res.status).toBe(401);
    expect(mockRefresh).toHaveBeenCalledWith(undefined, expect.any(Object), expect.any(Date));
  });
});

describe('POST /auth/logout — limpa os dois cookies, mesmos nomes do login (critérios 3 e 4)', () => {
  beforeEach(() => mockResolve.mockResolvedValue(EDITOR_CTX));

  it('sucesso → 204, dois Set-Cookie de expiração (mesmos nomes ACCESS/REFRESH) e revoga no servidor', async () => {
    mockLogout.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/auth/logout')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${ACCESS_COOKIE}=acc; ${REFRESH_COOKIE}=ref`)
      .send();

    expect(res.status).toBe(204);

    const cleared = setCookies(res);
    expect(cleared.map((entry) => entry.name).sort()).toEqual(
      [ACCESS_COOKIE, REFRESH_COOKIE].sort(),
    );
    for (const entry of cleared) {
      expect(entry.value).toBe('');
      expect(Date.parse(String(entry.attrs.expires))).toBeLessThan(Date.now());
    }
    expect(mockLogout).toHaveBeenCalledWith('ref', expect.any(Object));
  });

  it('sem sessão → 401 (requireAuth), logout não é chamado', async () => {
    mockResolve.mockResolvedValue(null);

    const res = await request(buildApp()).post('/auth/logout').set('Origin', ALLOWED_ORIGIN).send();

    expect(res.status).toBe(401);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it('sessão de papel fora de {EDITOR, ADMIN} → 403 (piso de autorização)', async () => {
    mockResolve.mockResolvedValue(STUDENT_CTX);

    const res = await request(buildApp())
      .post('/auth/logout')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${ACCESS_COOKIE}=acc`)
      .send();

    expect(res.status).toBe(403);
    expect(mockLogout).not.toHaveBeenCalled();
  });
});

describe('GET /auth/me — SessionUser sem token; guarda de sessão (critérios 2 e 7)', () => {
  it('sessão de EDITOR válida → 200 com as chaves exatas {id,name,email,role}', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    mockGetSessionUser.mockResolvedValue(SESSION_USER);

    const res = await request(buildApp()).get('/auth/me').set('Cookie', `${ACCESS_COOKIE}=acc`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'name', 'role']);
    for (const forbidden of ['passwordHash', 'accessToken', 'refreshToken']) {
      expect(res.body).not.toHaveProperty(forbidden);
    }
    expect(mockGetSessionUser).toHaveBeenCalledWith(EDITOR_CTX.userId);
  });

  it('getSessionUser → null (conta desativada no meio da sessão) → 401', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);
    mockGetSessionUser.mockResolvedValue(null);

    const res = await request(buildApp()).get('/auth/me').set('Cookie', `${ACCESS_COOKIE}=acc`);

    expect(res.status).toBe(401);
  });

  it('sem sessão → 401 (requireAuth), getSessionUser não é chamado', async () => {
    mockResolve.mockResolvedValue(null);

    const res = await request(buildApp()).get('/auth/me');

    expect(res.status).toBe(401);
    expect(mockGetSessionUser).not.toHaveBeenCalled();
  });

  it('DELETE /auth/me (método não declarado) com sessão de EDITOR válida → 403', async () => {
    mockResolve.mockResolvedValue(EDITOR_CTX);

    const res = await request(buildApp()).delete('/auth/me').set('Cookie', `${ACCESS_COOKIE}=acc`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /auth/change-password — identidade da sessão, validação de política', () => {
  beforeEach(() => mockResolve.mockResolvedValue(EDITOR_CTX));

  it('corpo válido → 204 e o service recebe userId e sessionId da sessão, nunca do corpo', async () => {
    mockChangePassword.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/auth/change-password')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${ACCESS_COOKIE}=acc`)
      .send({
        currentPassword: 'senha-atual-123',
        newPassword: 'nova-senha-bem-longa-1',
        userId: 'ATACANTE',
      });

    expect(res.status).toBe(204);
    expect(mockChangePassword).toHaveBeenCalledWith(
      EDITOR_CTX.userId,
      { currentPassword: 'senha-atual-123', newPassword: 'nova-senha-bem-longa-1' },
      EDITOR_CTX.sessionId,
    );
  });

  it('nova senha com menos de 12 caracteres → 422, service não é chamado', async () => {
    const res = await request(buildApp())
      .post('/auth/change-password')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${ACCESS_COOKIE}=acc`)
      .send({ currentPassword: 'senha-atual-123', newPassword: 'curta' });

    expect(res.status).toBe(422);
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('senha atual errada (service lança UnauthorizedError) → 401', async () => {
    mockChangePassword.mockRejectedValue(new UnauthorizedError());

    const res = await request(buildApp())
      .post('/auth/change-password')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${ACCESS_COOKIE}=acc`)
      .send({ currentPassword: 'errada', newPassword: 'nova-senha-bem-longa-1' });

    expect(res.status).toBe(401);
  });
});

describe('src/app.ts — cookie-parser montado antes de apiRoutes (critério 6)', () => {
  it('a camada cookieParser precede a montagem de apiRoutes na pilha da app', () => {
    const app = createApp();
    const stack = (app.router as unknown as { stack: Array<{ name: string; handle: unknown }> })
      .stack;

    const cookieIdx = stack.findIndex((layer) => layer.name === 'cookieParser');
    const apiIdx = stack.findIndex((layer) => layer.handle === apiRoutes);

    expect(cookieIdx).toBeGreaterThanOrEqual(0);
    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(cookieIdx).toBeLessThan(apiIdx);
  });
});
