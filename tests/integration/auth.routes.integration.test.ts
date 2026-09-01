import { randomUUID } from 'node:crypto';

import cookieParser from 'cookie-parser';
import express, { type Express, Router } from 'express';
import request from 'supertest';

import { env } from '../../src/config/env';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../src/http/cookies';
import { requireAuth } from '../../src/http/middlewares/authenticate';
import { errorHandler, notFoundHandler } from '../../src/http/middlewares/error-handler';
import { logger } from '../../src/lib/logger';
import { hashPassword } from '../../src/lib/password';
import { prisma } from '../../src/lib/prisma';
import { hashToken } from '../../src/lib/tokens';
import { authRoutes } from '../../src/modules/auth/auth.routes';
import { getSessionUser } from '../../src/modules/auth/auth.service';
import { closeTestDb, resetDb, testPrisma } from './db';
import { cookie, setCookies } from './set-cookie';

/**
 * `auth.routes.ts` ponta-a-ponta sobre o Postgres real (harness de TASK-003-016),
 * na pilha de middlewares que TASK-003-011 vai montar (`express.json` →
 * `cookie-parser` → `requireAuth` → router → `errorHandler`). Cobre AC-002-001
 * (login estabelece sessão: cookie + `Session` persistida com o hash do token, não
 * o valor em claro + auditoria de sucesso), AC-002-007 (logout revoga no servidor
 * e a reapresentação é rejeitada), AC-002-029 (troca da própria senha revoga as
 * demais sessões), a declaração método-aware de papel (`GET /auth/me` passa,
 * `DELETE /auth/me` → 403) e `getSessionUser` com fixture ativa/desativada.
 */

const PASSWORD = 'senha-de-fixture-123';
const NEW_PASSWORD = 'nova-senha-bem-longa-1';
const ALLOWED_ORIGIN = 'http://localhost:3000'; // tests/setup-env.ts
const EVIL_ORIGIN = 'https://evil.example';

/** Hash Argon2id do `PASSWORD` — derivado uma vez; o KDF é caro de propósito. */
let sharedPasswordHash: string;

interface UserSeed {
  email?: string;
  name?: string;
  role?: 'STUDENT' | 'EDITOR' | 'ADMIN';
  disabledAt?: Date | null;
}

async function createUser(seed: UserSeed = {}) {
  return testPrisma.user.create({
    data: {
      email: seed.email ?? `user-${randomUUID()}@example.com`,
      name: seed.name ?? 'Edna Editora',
      passwordHash: sharedPasswordHash,
      role: seed.role ?? 'EDITOR',
      disabledAt: seed.disabledAt ?? null,
    },
  });
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

function captureAuthLog() {
  return jest.spyOn(logger, 'info').mockImplementation(() => undefined);
}

function auditTypes(info: ReturnType<typeof captureAuthLog>): string[] {
  return info.mock.calls
    .map((call) => (call[0] as { audit?: { type?: string } }).audit?.type)
    .filter((type): type is string => typeof type === 'string');
}

/** Faz login e devolve os valores em claro dos cookies de sessão. */
async function loginVia(app: Express, email: string) {
  const res = await request(app)
    .post('/auth/login')
    .set('Origin', ALLOWED_ORIGIN)
    .send({ email, password: PASSWORD });

  if (res.status !== 200) throw new Error(`login de fixture falhou: ${res.status}`);
  return {
    res,
    access: cookie(res, ACCESS_COOKIE).value,
    refresh: cookie(res, REFRESH_COOKIE).value,
  };
}

beforeAll(async () => {
  sharedPasswordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await closeTestDb();
  // O router usa o client de produção (`src/lib/prisma.ts`); sem fechar o pool
  // dele o processo do Jest fica com handle aberto (lição da Wave 3).
  await prisma.$disconnect();
});

describe('POST /auth/login — AC-002-001: estabelece a sessão', () => {
  it('grava os dois cookies, persiste a Session só com o hash do token e audita login.success', async () => {
    const info = captureAuthLog();
    const user = await createUser({ role: 'EDITOR' });

    const { res, access, refresh } = await loginVia(buildApp(), user.email);

    expect(res.body).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      role: 'EDITOR',
    });
    expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'name', 'role']);

    const accessCookie = cookie(res, ACCESS_COOKIE);
    const refreshCookie = cookie(res, REFRESH_COOKIE);
    expect(accessCookie.attrs).toMatchObject({ path: '/', httponly: true, samesite: 'Lax' });
    expect(accessCookie.attrs['max-age']).toBe(String(env.AUTH_ACCESS_TTL_MINUTES * 60));
    expect(refreshCookie.attrs).toMatchObject({ path: '/api/v1/auth', httponly: true });
    expect(refreshCookie.attrs['max-age']).toBe(String(env.AUTH_REFRESH_TTL_DAYS * 86_400));

    const rows = await testPrisma.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refreshTokenHash).toBe(hashToken(refresh));
    expect(rows[0]?.refreshTokenHash).not.toBe(refresh); // o valor em claro nunca é persistido
    expect(rows[0]?.accessTokenHash).toBe(hashToken(access));

    expect(auditTypes(info)).toContain('login.success');
  });

  it('Origin fora de CORS_ORIGINS → 403 e nenhuma Session é criada', async () => {
    const user = await createUser();

    const res = await request(buildApp())
      .post('/auth/login')
      .set('Origin', EVIL_ORIGIN)
      .send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(403);
    expect(await testPrisma.session.count()).toBe(0);
  });

  it('senha errada → 401 genérico, sem Set-Cookie', async () => {
    const user = await createUser();

    const res = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: user.email, password: 'errada' });

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('POST /auth/refresh — reemite os dois cookies e a nova credencial resolve', () => {
  it('refresh válido → 2 Set-Cookie novos e o novo access autentica GET /auth/me', async () => {
    const app = buildApp();
    const user = await createUser();
    const first = await loginVia(app, user.email);

    const res = await request(app)
      .post('/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${REFRESH_COOKIE}=${first.refresh}`)
      .send();

    expect(res.status).toBe(200);
    const rotatedAccess = cookie(res, ACCESS_COOKIE).value;
    const rotatedRefresh = cookie(res, REFRESH_COOKIE).value;
    expect(rotatedRefresh).not.toBe(first.refresh);

    const me = await request(app)
      .get('/auth/me')
      .set('Cookie', `${ACCESS_COOKIE}=${rotatedAccess}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);
  });
});

describe('POST /auth/logout — AC-002-007: revoga no servidor e limpa os cookies', () => {
  it('limpa os dois cookies, revoga a família e a reapresentação do access anterior → 401', async () => {
    const app = buildApp();
    const user = await createUser();
    const { access, refresh } = await loginVia(app, user.email);

    const res = await request(app)
      .post('/auth/logout')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`)
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

    const rows = await testPrisma.session.findMany({ where: { userId: user.id } });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    const me = await request(app).get('/auth/me').set('Cookie', `${ACCESS_COOKIE}=${access}`);
    expect(me.status).toBe(401);
  });
});

describe('GET /auth/me — critério de pronto: SessionUser sem token; declaração método-aware', () => {
  it('sessão de EDITOR válida → 200 com {id,name,email,role} exatos e sem passwordHash', async () => {
    const app = buildApp();
    const user = await createUser({ role: 'EDITOR' });
    const { access } = await loginVia(app, user.email);

    const res = await request(app).get('/auth/me').set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: user.id, name: user.name, email: user.email, role: 'EDITOR' });
    expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'name', 'role']);
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('sem cookie → 401', async () => {
    const res = await request(buildApp()).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('DELETE /auth/me (verbo não declarado no mesmo caminho) com sessão de EDITOR → 403', async () => {
    const app = buildApp();
    const user = await createUser({ role: 'EDITOR' });
    const { access } = await loginVia(app, user.email);

    const res = await request(app).delete('/auth/me').set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /auth/change-password — AC-002-029', () => {
  it('senha atual correta → 204; a nova autentica, a antiga não, e as demais sessões são revogadas', async () => {
    const app = buildApp();
    const user = await createUser();
    const { access } = await loginVia(app, user.email);

    // Sessão irmã da mesma conta — deve ser revogada; a corrente, preservada.
    const sibling = await testPrisma.session.create({
      data: {
        userId: user.id,
        familyId: randomUUID(),
        accessTokenHash: hashToken(randomUUID()),
        refreshTokenHash: hashToken(randomUUID()),
        accessExpiresAt: new Date(Date.now() + 900_000),
        refreshExpiresAt: new Date(Date.now() + 604_800_000),
      },
    });

    const res = await request(app)
      .post('/auth/change-password')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(204);

    const withNew = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: user.email, password: NEW_PASSWORD });
    expect(withNew.status).toBe(200);

    const withOld = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: user.email, password: PASSWORD });
    expect(withOld.status).toBe(401);

    const siblingAfter = await testPrisma.session.findUniqueOrThrow({ where: { id: sibling.id } });
    expect(siblingAfter.revokedAt).not.toBeNull();
  });

  it('senha atual errada → 401 e a senha não muda', async () => {
    const app = buildApp();
    const user = await createUser();
    const { access } = await loginVia(app, user.email);

    const res = await request(app)
      .post('/auth/change-password')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({ currentPassword: 'errada', newPassword: NEW_PASSWORD });

    expect(res.status).toBe(401);
    const stillWorks = await request(buildApp())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: user.email, password: PASSWORD });
    expect(stillWorks.status).toBe(200);
  });
});

describe('getSessionUser — leitura fina com guarda de conta desativada (furo no plano da Wave 5)', () => {
  it('conta ativa → {id,name,email,role} exatos, sem passwordHash', async () => {
    const active = await createUser({ role: 'EDITOR' });

    const result = await getSessionUser(active.id);

    expect(result).toEqual({
      id: active.id,
      name: active.name,
      email: active.email,
      role: 'EDITOR',
    });
    expect(Object.keys(result ?? {}).sort()).toEqual(['email', 'id', 'name', 'role']);
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('conta desativada → null (a cláusula disabledAt: null é a guarda)', async () => {
    const disabled = await createUser({ disabledAt: new Date() });

    expect(await getSessionUser(disabled.id)).toBeNull();
  });

  it('numa base com uma conta ativa e uma desativada, só a ativa resolve', async () => {
    const active = await createUser();
    const disabled = await createUser({ disabledAt: new Date() });

    expect(await getSessionUser(active.id)).not.toBeNull();
    expect(await getSessionUser(disabled.id)).toBeNull();
  });

  it('id inexistente → null, nunca lança', async () => {
    expect(await getSessionUser(randomUUID())).toBeNull();
  });
});
