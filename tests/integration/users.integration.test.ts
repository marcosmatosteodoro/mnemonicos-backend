import { randomUUID } from 'node:crypto';

import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, Router } from 'express';
import request from 'supertest';

import { env } from '../../src/config/env';
import type { UserRole } from '../../src/domain/types';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../src/http/errors';
import { requireAuth } from '../../src/http/middlewares/authenticate';
import { errorHandler, notFoundHandler } from '../../src/http/middlewares/error-handler';
import { rolesForPath } from '../../src/http/route-roles';
import { logger } from '../../src/lib/logger';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import {
  changeOwnPassword,
  login,
  resolveAccessSession,
  type RequestOrigin,
} from '../../src/modules/auth/auth.service';
import * as sessionRevocation from '../../src/modules/auth/session-revocation';
import { createUserSchema } from '../../src/modules/users/users.schema';
import {
  createInternalUser,
  disableUser,
  listInternalUsers,
  resetUserPassword,
} from '../../src/modules/users/users.service';
import { usersRoutes } from '../../src/modules/users/users.routes';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * Gestão de contas por ADMIN (`src/modules/users/`) ponta-a-ponta sobre o
 * Postgres real (harness de TASK-003-016), na pilha que TASK-003-011 vai montar
 * (`express.json` → `cookie-parser` → `requireAuth` → `usersRoutes` →
 * `errorHandler`). Cobre AC-002-016..022, AC-002-024, FR-002-022 e os itens do
 * Inclui sem AC (`userIdParamSchema` / `listUsersQuerySchema`).
 *
 * Nota sobre status HTTP: falha de schema Zod sobe como `ZodError` e o
 * `errorHandler` central a traduz em **422** (perfil §5) — os critérios da TASK
 * dizem "400" no sentido genérico de "recusado, sem criar".
 */

const PASSWORD = 'senha-de-fixture-123';
const NEW_PASSWORD = 'nova-senha-de-reset-9';
const ORIGIN: RequestOrigin = { ip: '203.0.113.7', userAgent: 'jest-suite/1.0' };
const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

/** Hash Argon2id do `PASSWORD` — derivado uma vez; o KDF é caro de propósito. */
let sharedPasswordHash: string;

interface UserSeed {
  email?: string;
  name?: string;
  role?: UserRole;
  password?: string;
  disabledAt?: Date | null;
}

async function createUser(seed: UserSeed = {}) {
  return testPrisma.user.create({
    data: {
      email: seed.email ?? `user-${randomUUID()}@example.com`,
      name: seed.name ?? 'Fulano de Tal',
      passwordHash:
        seed.password === undefined ? sharedPasswordHash : await hashPassword(seed.password),
      role: seed.role ?? 'EDITOR',
      disabledAt: seed.disabledAt ?? null,
    },
  });
}

/** Semeia uma linha de `Session` viva e devolve os valores em claro dos tokens. */
async function seedSession(userId: string, seed: { revokedAt?: Date | null } = {}) {
  const access = generateToken();
  const refreshValue = generateToken();
  const row = await testPrisma.session.create({
    data: {
      userId,
      familyId: randomUUID(),
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(refreshValue),
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      revokedAt: seed.revokedAt ?? null,
    },
  });
  return { row, access, refresh: refreshValue };
}

/** ADMIN ativo com uma sessão viva — o chamador das rotas de gestão. */
async function seedAdmin() {
  const user = await createUser({ role: 'ADMIN', name: 'Ada Admin' });
  const { access } = await seedSession(user.id);
  return { user, access };
}

function buildApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  const api = Router();
  api.use(requireAuth);
  api.use(usersRoutes);
  app.use(api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Espia todos os níveis do transport estruturado — o módulo `users/` não deve emitir segredo em nenhum. */
function captureAllLog() {
  return {
    info: jest.spyOn(logger, 'info').mockImplementation(() => undefined),
    warn: jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(logger, 'error').mockImplementation(() => undefined),
  };
}

type RouteHandler = (req: Request, res: unknown, next: NextFunction) => unknown;

interface RouteInfo {
  key: string;
  handlerCount: number;
  firstHandler: RouteHandler;
  /** O guard imediatamente antes do handler final — `requireRole` nas 4 rotas
   *  (as 3 mutações têm `verifyOrigin` à frente dele, S2). */
  guardBeforeHandler: RouteHandler;
}

/** Extrai `<MÉTODO> <caminho>` + a pilha de handlers de cada rota do router. */
function routesOf(router: unknown): RouteInfo[] {
  const stack = (router as { stack: unknown[] }).stack;
  const out: RouteInfo[] = [];
  for (const layer of stack) {
    const route = (
      layer as {
        route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
      }
    ).route;
    if (route === undefined) continue;
    for (const [method, on] of Object.entries(route.methods)) {
      if (!on) continue;
      out.push({
        key: `${method.toUpperCase()} ${route.path}`,
        handlerCount: route.stack.length,
        firstHandler: route.stack[0]?.handle as RouteHandler,
        guardBeforeHandler: route.stack[route.stack.length - 2]?.handle as RouteHandler,
      });
    }
  }
  return out;
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
  // O router/serviço usa o client de produção (`src/lib/prisma.ts`); sem fechar o
  // pool dele o processo do Jest fica com handle aberto (lição da Wave 3).
  await prisma.$disconnect();
});

describe('POST /users — AC-002-016: cria com papel EDITOR/ADMIN e senha ≥ 12', () => {
  it('senha válida e role EDITOR → 201 com {id,name,email,role} exatos e role igual ao enviado', async () => {
    const { access } = await seedAdmin();

    const res = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({
        email: 'nova.editora@example.com',
        name: 'Nova Editora',
        role: 'EDITOR',
        password: 'w'.repeat(12),
      });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('EDITOR');
    expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'name', 'role']);
    expect(res.body.email).toBe('nova.editora@example.com');

    const persisted = await testPrisma.user.findUniqueOrThrow({
      where: { email: 'nova.editora@example.com' },
    });
    expect(persisted.role).toBe('EDITOR');
  });

  it('role ADMIN também é aceito — o papel é fixado na criação', async () => {
    const { access } = await seedAdmin();

    const res = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({
        email: 'outro.admin@example.com',
        name: 'Outro Admin',
        role: 'ADMIN',
        password: 'x'.repeat(14),
      });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('ADMIN');
  });

  it('senha com 11 caracteres → recusa (422) e nenhuma conta nova é criada', async () => {
    const { access } = await seedAdmin();
    const before = await testPrisma.user.count();

    const res = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({
        email: 'curta@example.com',
        name: 'Senha Curta',
        role: 'EDITOR',
        password: 'a'.repeat(11),
      });

    expect(res.status).toBe(422);
    expect(await testPrisma.user.count()).toBe(before);
    expect(await testPrisma.user.findUnique({ where: { email: 'curta@example.com' } })).toBeNull();
  });

  it('senha com exatamente 12 caracteres é aceita (fronteira do piso)', async () => {
    const { access } = await seedAdmin();

    const res = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({
        email: 'piso@example.com',
        name: 'No Piso',
        role: 'EDITOR',
        password: 'a'.repeat(12),
      });

    expect(res.status).toBe(201);
  });
});

describe('POST /users — FR-002-022: papel STUDENT é recusado na criação', () => {
  it('role STUDENT → 422 e nenhuma conta criada', async () => {
    const { access } = await seedAdmin();
    const before = await testPrisma.user.count();

    const res = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({
        email: 'estudante@example.com',
        name: 'Aluno',
        role: 'STUDENT',
        password: 'a'.repeat(12),
      });

    expect(res.status).toBe(422);
    expect(await testPrisma.user.count()).toBe(before);
  });

  it('createUserSchema recusa STUDENT e aceita EDITOR/ADMIN', () => {
    expect(
      createUserSchema.safeParse({
        email: 'a@b.com',
        name: 'x',
        role: 'STUDENT',
        password: 'a'.repeat(12),
      }).success,
    ).toBe(false);
    expect(
      createUserSchema.safeParse({
        email: 'a@b.com',
        name: 'x',
        role: 'EDITOR',
        password: 'a'.repeat(12),
      }).success,
    ).toBe(true);
    expect(
      createUserSchema.safeParse({
        email: 'a@b.com',
        name: 'x',
        role: 'ADMIN',
        password: 'a'.repeat(12),
      }).success,
    ).toBe(true);
  });
});

describe('POST /users — AC-002-017: e-mail duplicado → 409, conta existente inalterada', () => {
  it('segundo POST com o mesmo e-mail (outra caixa) → 409 e a linha original fica idêntica', async () => {
    const { access } = await seedAdmin();
    const existing = await createUser({
      email: 'ocupado@example.com',
      name: 'Dono Original',
      role: 'EDITOR',
    });
    const snapshot = await testPrisma.user.findUniqueOrThrow({ where: { id: existing.id } });

    const res = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({
        email: 'OCUPADO@example.com',
        name: 'Impostor',
        role: 'ADMIN',
        password: 'z'.repeat(20),
      });

    expect(res.status).toBe(409);

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toEqual(snapshot);
    expect(await testPrisma.user.count({ where: { email: 'ocupado@example.com' } })).toBe(1);
  });

  it('createInternalUser: violação de unique vira ConflictError sem tocar a conta existente (nenhum update)', async () => {
    const existing = await createUser({ email: 'jah.existe@example.com', role: 'EDITOR' });
    const before = await testPrisma.user.findUniqueOrThrow({ where: { id: existing.id } });

    const error = await createInternalUser({
      email: 'jah.existe@example.com',
      name: 'Novo Nome',
      role: 'ADMIN',
      password: 'p'.repeat(16),
    }).catch((e: unknown) => e);

    expect((error as Error).name).toBe('ConflictError');
    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toEqual(before);
  });
});

describe('AC-002-018: nenhuma capacidade de auto-registro', () => {
  it('as 4 rotas montadas são exatamente as de gestão — nenhuma rota de registro público', () => {
    const keys = routesOf(usersRoutes)
      .map((r) => r.key)
      .sort();
    expect(keys).toEqual(
      [
        'GET /users',
        'PATCH /users/:id/disable',
        'POST /users',
        'POST /users/:id/reset-password',
      ].sort(),
    );
  });

  it('cada par método+caminho de gestão está em ROUTE_ROLES com exatamente {ADMIN}', () => {
    for (const [method, path] of [
      ['GET', '/users'],
      ['POST', '/users'],
      ['PATCH', '/users/:id/disable'],
      ['POST', '/users/:id/reset-password'],
    ] as const) {
      expect(rolesForPath(method, path)).toEqual(new Set<UserRole>(['ADMIN']));
    }
  });

  it('todo handler de rota é precedido por um guard requireRole que nega sem req.auth', () => {
    for (const route of routesOf(usersRoutes)) {
      // GET /users: [requireRole, handler]; as 3 mutações: [verifyOrigin, requireRole, handler] (S2).
      const expectedDepth = route.key === 'GET /users' ? 2 : 3;
      expect(route.handlerCount).toBe(expectedDepth);

      const next = jest.fn() as unknown as NextFunction;
      route.guardBeforeHandler({} as Request, {}, next);
      expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    }
  });

  it('POST /users sem sessão → 401; com sessão de EDITOR → 403; com ADMIN → 201', async () => {
    const editor = await createUser({ role: 'EDITOR' });
    const editorSession = await seedSession(editor.id);
    const admin = await seedAdmin();
    const body = {
      email: 'via-admin@example.com',
      name: 'Via Admin',
      role: 'EDITOR' as const,
      password: 'a'.repeat(12),
    };

    const anon = await request(buildApp()).post('/users').send(body);
    expect(anon.status).toBe(401);

    const asEditor = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${editorSession.access}`)
      .send(body);
    expect(asEditor.status).toBe(403);

    const asAdmin = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${admin.access}`)
      .send(body);
    expect(asAdmin.status).toBe(201);
  });
});

describe('GET /users — AC-002-019: lista com id,email,name,role,status e nunca passwordHash/sessions', () => {
  it('cada item tem exatamente {id,email,name,role,status}; status reflete disabledAt', async () => {
    const { access } = await seedAdmin();
    const activeEditor = await createUser({ email: 'ativa@example.com', role: 'EDITOR' });
    await createUser({ email: 'inativa@example.com', role: 'EDITOR', disabledAt: new Date() });
    await seedSession(activeEditor.id);

    const res = await request(buildApp()).get('/users').set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3); // admin + 2 editores

    for (const item of res.body.data as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual(['email', 'id', 'name', 'role', 'status']);
      expect(item).not.toHaveProperty('passwordHash');
      expect(item).not.toHaveProperty('sessions');
      expect(item).not.toHaveProperty('disabledAt');
    }

    const byEmail = Object.fromEntries(
      (res.body.data as { email: string; status: string }[]).map((u) => [u.email, u.status]),
    );
    expect(byEmail['ativa@example.com']).toBe('active');
    expect(byEmail['inativa@example.com']).toBe('disabled');
  });

  it('o JSON serializado da resposta não contém nenhum passwordHash da base', async () => {
    const { access } = await seedAdmin();
    const editor = await createUser({ role: 'EDITOR' });

    const res = await request(buildApp()).get('/users').set('Cookie', `${ACCESS_COOKIE}=${access}`);

    const hashes = await testPrisma.user.findMany({ select: { passwordHash: true } });
    const serialized = JSON.stringify(res.body);
    for (const { passwordHash } of hashes) {
      expect(serialized).not.toContain(passwordHash);
    }
    expect(editor.id).toBeTruthy();
  });
});

describe('PATCH /users/:id/disable — AC-002-020: marca temporal + revoga sessões do alvo + bloqueia login', () => {
  it('desativa o alvo, revoga só as sessões dele, e o alvo não autentica mais', async () => {
    const { access: adminAccess } = await seedAdmin();
    const target = await createUser({ email: 'alvo@example.com', role: 'EDITOR' });
    const bystander = await createUser({ email: 'terceiro@example.com', role: 'EDITOR' });
    const targetSessionA = await seedSession(target.id);
    const targetSessionB = await seedSession(target.id);
    const bystanderSession = await seedSession(bystander.id);

    const res = await request(buildApp())
      .patch(`/users/${target.id}/disable`)
      .set('Cookie', `${ACCESS_COOKIE}=${adminAccess}`);

    expect(res.status).toBe(200);

    const disabled = await testPrisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(disabled.disabledAt).not.toBeNull();

    const targetRows = await testPrisma.session.findMany({ where: { userId: target.id } });
    expect(targetRows).toHaveLength(2);
    expect(targetRows.every((r) => r.revokedAt !== null)).toBe(true);

    const bystanderRow = await testPrisma.session.findUniqueOrThrow({
      where: { id: bystanderSession.row.id },
    });
    expect(bystanderRow.revokedAt).toBeNull();

    expect(await resolveAccessSession(targetSessionA.access, new Date())).toBeNull();
    expect(await resolveAccessSession(targetSessionB.access, new Date())).toBeNull();

    await expect(
      login({ email: 'alvo@example.com', password: PASSWORD, ...ORIGIN }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('PATCH /users/:id/disable — AC-002-021: recusa desativar o último ADMIN ativo', () => {
  it('exatamente 1 ADMIN ativo + N EDITORs → disableUser(admin) rejeita e disabledAt segue null', async () => {
    const soleAdmin = await createUser({ email: 'sozinho@example.com', role: 'ADMIN' });
    await createUser({ role: 'EDITOR' });
    await createUser({ role: 'EDITOR' });

    await expect(disableUser(soleAdmin.id)).rejects.toMatchObject({ name: 'ConflictError' });

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: soleAdmin.id } });
    expect(after.disabledAt).toBeNull();
  });

  it('via rota: último ADMIN ativo → 409', async () => {
    const soleAdmin = await createUser({ email: 'unico@example.com', role: 'ADMIN' });
    const { access } = await seedSession(soleAdmin.id);

    const res = await request(buildApp())
      .patch(`/users/${soleAdmin.id}/disable`)
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(409);
    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: soleAdmin.id } });
    expect(after.disabledAt).toBeNull();
  });

  it('2 ADMINs ativos → desativar um resolve e a conta fica com disabledAt preenchido', async () => {
    const admin1 = await createUser({ email: 'adm1@example.com', role: 'ADMIN' });
    await createUser({ email: 'adm2@example.com', role: 'ADMIN' });

    await expect(disableUser(admin1.id)).resolves.toBeUndefined();

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: admin1.id } });
    expect(after.disabledAt).not.toBeNull();
  });

  it('2 ADMINs, um já desativado → desativar o remanescente ativo → 409 (conta por DADO, não contagem bruta)', async () => {
    await createUser({ email: 'ja-inativo@example.com', role: 'ADMIN', disabledAt: new Date() });
    const lastActive = await createUser({ email: 'ultimo-ativo@example.com', role: 'ADMIN' });

    await expect(disableUser(lastActive.id)).rejects.toMatchObject({ name: 'ConflictError' });
  });
});

describe('POST /users/:id/reset-password — AC-002-022: nova senha conforme política + revoga sessões da conta', () => {
  it('após reset: nova senha autentica, a antiga não, sessões da conta revogadas e de outra conta intactas', async () => {
    const { access: adminAccess } = await seedAdmin();
    const target = await createUser({ email: 'reset@example.com', role: 'EDITOR' });
    const other = await createUser({ email: 'outra@example.com', role: 'EDITOR' });
    const targetSessionA = await seedSession(target.id);
    const targetSessionB = await seedSession(target.id);
    const otherSession = await seedSession(other.id);

    const res = await request(buildApp())
      .post(`/users/${target.id}/reset-password`)
      .set('Cookie', `${ACCESS_COOKIE}=${adminAccess}`)
      .send({ password: NEW_PASSWORD });

    expect(res.status).toBe(204);

    // As sessões preexistentes da conta são revogadas; a de outra conta, intacta.
    // Aferido antes de `login` — um login bem-sucedido cria uma sessão nova, viva.
    for (const id of [targetSessionA.row.id, targetSessionB.row.id]) {
      expect(
        (await testPrisma.session.findUniqueOrThrow({ where: { id } })).revokedAt,
      ).not.toBeNull();
    }
    expect(await resolveAccessSession(targetSessionA.access, new Date())).toBeNull();
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: otherSession.row.id } }))
        .revokedAt,
    ).toBeNull();

    await expect(
      login({ email: 'reset@example.com', password: NEW_PASSWORD, ...ORIGIN }),
    ).resolves.toMatchObject({ user: { id: target.id } });
    await expect(
      login({ email: 'reset@example.com', password: PASSWORD, ...ORIGIN }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('senha < 12 no reset → 422 e a senha da conta não muda', async () => {
    const { access: adminAccess } = await seedAdmin();
    const target = await createUser({ email: 'reset-curto@example.com', role: 'EDITOR' });
    const before = await testPrisma.user.findUniqueOrThrow({ where: { id: target.id } });

    const res = await request(buildApp())
      .post(`/users/${target.id}/reset-password`)
      .set('Cookie', `${ACCESS_COOKIE}=${adminAccess}`)
      .send({ password: 'a'.repeat(11) });

    expect(res.status).toBe(422);
    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    await expect(
      login({ email: 'reset-curto@example.com', password: PASSWORD, ...ORIGIN }),
    ).resolves.toMatchObject({ user: { id: target.id } });
  });

  it('resetUserPassword deriva o hash (não grava a senha em claro) e a nova senha verifica', async () => {
    const target = await createUser({ email: 'derivado@example.com', role: 'EDITOR' });

    await resetUserPassword(target.id, NEW_PASSWORD);

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.passwordHash).not.toBe(NEW_PASSWORD);
    expect(after.passwordHash).not.toBe(sharedPasswordHash);
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
  });
});

describe('AC-002-024 / NFR-002-004: nenhum segredo em log ou resposta na criação/reset', () => {
  it('nenhum registro de log (info/warn/error) durante criar, resetar e conflito de e-mail contém a senha', async () => {
    const spies = captureAllLog();
    const { access: adminAccess } = await seedAdmin();
    const target = await createUser({ email: 'segredo@example.com', role: 'EDITOR' });

    await request(buildApp()).post('/users').set('Cookie', `${ACCESS_COOKIE}=${adminAccess}`).send({
      email: 'com-senha@example.com',
      name: 'Com Senha',
      role: 'EDITOR',
      password: NEW_PASSWORD,
    });

    // Reapresenta o mesmo e-mail: o caminho de ConflictError também não pode logar a senha.
    await request(buildApp()).post('/users').set('Cookie', `${ACCESS_COOKIE}=${adminAccess}`).send({
      email: 'com-senha@example.com',
      name: 'Duplicado',
      role: 'EDITOR',
      password: NEW_PASSWORD,
    });

    await request(buildApp())
      .post(`/users/${target.id}/reset-password`)
      .set('Cookie', `${ACCESS_COOKIE}=${adminAccess}`)
      .send({ password: NEW_PASSWORD });

    const logged = JSON.stringify([
      ...spies.info.mock.calls,
      ...spies.warn.mock.calls,
      ...spies.error.mock.calls,
    ]);
    expect(logged).not.toContain(NEW_PASSWORD);
    expect(logged).not.toContain(PASSWORD);
  });

  it('a resposta de POST /users não tem passwordHash/accessToken/refreshToken (conjunto exato de chaves)', async () => {
    const { access } = await seedAdmin();

    const res = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({
        email: 'chaves@example.com',
        name: 'Só Chaves',
        role: 'EDITOR',
        password: 'a'.repeat(12),
      });

    expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'name', 'role']);
    for (const forbidden of ['passwordHash', 'accessToken', 'refreshToken', 'password']) {
      expect(res.body).not.toHaveProperty(forbidden);
    }
  });

  it('a resposta de GET /users não expõe passwordHash/accessToken/refreshToken em nenhum item', async () => {
    const { access } = await seedAdmin();
    await createUser({ role: 'EDITOR' });

    const res = await request(buildApp()).get('/users').set('Cookie', `${ACCESS_COOKIE}=${access}`);

    for (const item of res.body.data as Record<string, unknown>[]) {
      for (const forbidden of ['passwordHash', 'accessToken', 'refreshToken']) {
        expect(item).not.toHaveProperty(forbidden);
      }
    }
  });

  it('POST /users persiste a senha só como saída do KDF — nunca em claro', async () => {
    const { access } = await seedAdmin();

    await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({ email: 'kdf@example.com', name: 'KDF', role: 'EDITOR', password: NEW_PASSWORD });

    const persisted = await testPrisma.user.findUniqueOrThrow({
      where: { email: 'kdf@example.com' },
    });
    expect(persisted.passwordHash).not.toBe(NEW_PASSWORD);
    expect(await verifyPassword(NEW_PASSWORD, persisted.passwordHash)).toBe(true);
  });
});

describe('itens do Inclui sem AC: userIdParamSchema e listUsersQuerySchema exercitados', () => {
  it('PATCH /users/nao-uuid/disable → 422 (id não é UUID)', async () => {
    const { access } = await seedAdmin();

    const res = await request(buildApp())
      .patch('/users/nao-uuid/disable')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(422);
  });

  it('GET /users?page=2&perPage=1 respeita a paginação do padrão de disciplines (1 item, total real)', async () => {
    const { access } = await seedAdmin();
    await createUser({ role: 'EDITOR' });
    await createUser({ role: 'EDITOR' });

    const res = await request(buildApp())
      .get('/users?page=2&perPage=1')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.perPage).toBe(1);
    expect(res.body.total).toBe(3);
    expect(res.body.data).toHaveLength(1);
  });

  it('GET /users?perPage=0 → 422 (fora do mínimo do schema de paginação)', async () => {
    const { access } = await seedAdmin();

    const res = await request(buildApp())
      .get('/users?perPage=0')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Retry Wave 5 — correções reprovadas no 1º passe (efaef57). Cada describe
// abaixo casa um item `[retry ...]` dos Critérios de pronto e roda o mutante
// nomeado antes de valer como prova.
// ---------------------------------------------------------------------------

describe('[retry F1] não-vazamento provado NO PONTO DA CONSULTA (não só na resposta)', () => {
  it('listInternalUsers: a linha devolvida por prisma.user.findMany tem exatamente as 5 chaves do select (conta COM sessão)', async () => {
    const editor = await createUser({ email: 'ponto-consulta@example.com', role: 'EDITOR' });
    // Conta com sessão: o mutante `select` → `include: { sessions: true }` traria o
    // array `sessions` na linha; o mutante `select` → entidade crua traria `passwordHash`.
    await seedSession(editor.id);

    const findManySpy = jest.spyOn(prisma.user, 'findMany');

    await listInternalUsers({ page: 1, perPage: 20 });

    const rows = (await findManySpy.mock.results[0]!.value) as Array<Record<string, unknown>>;
    const seededRow = rows.find((row) => row.id === editor.id);
    expect(seededRow).toBeDefined();
    expect(Object.keys(seededRow ?? {}).sort()).toEqual([
      'disabledAt',
      'email',
      'id',
      'name',
      'role',
    ]);
  });

  it('createInternalUser: a linha devolvida por prisma.user.create tem exatamente {id,name,email,role} — nunca passwordHash', async () => {
    const createSpy = jest.spyOn(prisma.user, 'create');

    await createInternalUser({
      email: 'criada-no-ponto@example.com',
      name: 'Criada No Ponto',
      role: 'EDITOR',
      password: 'p'.repeat(16),
    });

    const created = (await createSpy.mock.results[0]!.value) as Record<string, unknown>;
    expect(Object.keys(created).sort()).toEqual(['email', 'id', 'name', 'role']);
    expect(created).not.toHaveProperty('passwordHash');
  });
});

describe('[retry F2] filtro `search` de listInternalUsers (nome OU e-mail — capacidade declarada, EMENDA Wave 5)', () => {
  /** Nomes e e-mails que não se cruzam: um termo só casa por um campo. */
  async function seedDivergentPair() {
    const byName = await createUser({
      name: 'Alice Alpha',
      email: 'aaa@example.com',
      role: 'EDITOR',
    });
    const byEmail = await createUser({
      name: 'Bob Beta',
      email: 'zzz@example.com',
      role: 'EDITOR',
    });
    return { byName, byEmail };
  }

  it('search casa só por NOME → traz só essa conta (insensível a caixa)', async () => {
    const { byName } = await seedDivergentPair();

    const page = await listInternalUsers({ page: 1, perPage: 20, search: 'alpha' });

    expect(page.data.map((u) => u.id)).toEqual([byName.id]);
  });

  it('search casa só por E-MAIL → traz só essa conta (insensível a caixa)', async () => {
    const { byEmail } = await seedDivergentPair();

    const page = await listInternalUsers({ page: 1, perPage: 20, search: 'ZZZ' });

    expect(page.data.map((u) => u.id)).toEqual([byEmail.id]);
  });

  it('search sem correspondência → lista vazia', async () => {
    await seedDivergentPair();

    const page = await listInternalUsers({ page: 1, perPage: 20, search: 'termo-que-nao-existe' });

    expect(page.data).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe('[retry F3] ramos de disableUser / resetUserPassword sem caso no 1º passe', () => {
  it('disableUser(id inexistente) → NotFoundError (P2025 não vaza como 500)', async () => {
    await expect(disableUser(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('disableUser sobre conta já desativada → no-op que NÃO re-carimba o disabledAt original', async () => {
    const originalDisabledAt = new Date('2020-01-01T00:00:00.000Z');
    const already = await createUser({
      email: 'f3-ja-desativada@example.com',
      role: 'EDITOR',
      disabledAt: originalDisabledAt,
    });

    await expect(disableUser(already.id)).resolves.toBeUndefined();

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: already.id } });
    expect(after.disabledAt?.getTime()).toBe(originalDisabledAt.getTime());
  });

  it('resetUserPassword(id inexistente) → NotFoundError', async () => {
    await expect(resetUserPassword(randomUUID(), NEW_PASSWORD)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('[retry S1] guarda do último ADMIN fecha NA ESCRITA (não check-then-act)', () => {
  it('N disableUser concorrentes contra ADMINs ativos → resta SEMPRE ≥ 1 ADMIN ativo e ≥ 1 rejeição ConflictError', async () => {
    const admins = await Promise.all([
      createUser({ email: 's1-a@example.com', role: 'ADMIN' }),
      createUser({ email: 's1-b@example.com', role: 'ADMIN' }),
      createUser({ email: 's1-c@example.com', role: 'ADMIN' }),
    ]);

    const settled = await Promise.allSettled(admins.map((admin) => disableUser(admin.id)));

    const activeAdmins = await testPrisma.user.count({
      where: { role: 'ADMIN', disabledAt: null },
    });
    // A invariante que o 1º passe (count fora da transação) violava: 3 chamadas
    // liam "3 ativos", todas passavam da guarda, todas gravavam → 0 ADMIN ativo.
    expect(activeAdmins).toBeGreaterThanOrEqual(1);

    const rejections = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejections.some((r) => r.reason instanceof ConflictError)).toBe(true);

    const fulfilled = settled.filter((result) => result.status === 'fulfilled').length;
    expect(activeAdmins).toBe(admins.length - fulfilled);
  });
});

describe('[retry S2] verifyOrigin nas 3 mutações de users/', () => {
  const EVIL_ORIGIN = 'https://evil.example';
  const ALLOWED_ORIGIN = 'http://localhost:3000'; // única entrada de CORS_ORIGINS (tests/setup-env.ts)

  it('POST /users: Origin fora de CORS_ORIGINS → 403 sem criar conta; Origin da allowlist → 201', async () => {
    const { access } = await seedAdmin();
    const body = {
      email: 's2-create@example.com',
      name: 'S2 Create',
      role: 'EDITOR' as const,
      password: 'a'.repeat(12),
    };
    const before = await testPrisma.user.count();

    const blocked = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .set('Origin', EVIL_ORIGIN)
      .send(body);

    expect(blocked.status).toBe(403);
    expect(await testPrisma.user.count()).toBe(before);

    const ok = await request(buildApp())
      .post('/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .set('Origin', ALLOWED_ORIGIN)
      .send(body);

    expect(ok.status).toBe(201);
  });

  it('PATCH /users/:id/disable: Origin proibido → 403 e alvo segue ativo; Origin permitido → 200', async () => {
    const { access } = await seedAdmin();
    const target = await createUser({ email: 's2-disable@example.com', role: 'EDITOR' });

    const blocked = await request(buildApp())
      .patch(`/users/${target.id}/disable`)
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .set('Origin', EVIL_ORIGIN);

    expect(blocked.status).toBe(403);
    expect(
      (await testPrisma.user.findUniqueOrThrow({ where: { id: target.id } })).disabledAt,
    ).toBeNull();

    const ok = await request(buildApp())
      .patch(`/users/${target.id}/disable`)
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .set('Origin', ALLOWED_ORIGIN);

    expect(ok.status).toBe(200);
  });

  it('POST /users/:id/reset-password: Origin proibido → 403 e passwordHash intacto; Origin permitido → 204', async () => {
    const { access } = await seedAdmin();
    const target = await createUser({ email: 's2-reset@example.com', role: 'EDITOR' });
    const before = await testPrisma.user.findUniqueOrThrow({ where: { id: target.id } });

    const blocked = await request(buildApp())
      .post(`/users/${target.id}/reset-password`)
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .set('Origin', EVIL_ORIGIN)
      .send({ password: NEW_PASSWORD });

    expect(blocked.status).toBe(403);
    expect(
      (await testPrisma.user.findUniqueOrThrow({ where: { id: target.id } })).passwordHash,
    ).toBe(before.passwordHash);

    const ok = await request(buildApp())
      .post(`/users/${target.id}/reset-password`)
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .set('Origin', ALLOWED_ORIGIN)
      .send({ password: NEW_PASSWORD });

    expect(ok.status).toBe(204);
  });
});

describe('[retry F5] disableUser / resetUserPassword / changeOwnPassword delegam a revokeAllSessionsOp', () => {
  it('disableUser chama revokeAllSessionsOp 1× com o userId do alvo', async () => {
    const admin1 = await createUser({ email: 'f5-adm1@example.com', role: 'ADMIN' });
    await createUser({ email: 'f5-adm2@example.com', role: 'ADMIN' }); // guarda do último ADMIN passa

    const spy = jest.spyOn(sessionRevocation, 'revokeAllSessionsOp');

    await disableUser(admin1.id);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(admin1.id);
  });

  it('resetUserPassword chama revokeAllSessionsOp 1× com o userId da conta', async () => {
    const target = await createUser({ email: 'f5-reset@example.com', role: 'EDITOR' });

    const spy = jest.spyOn(sessionRevocation, 'revokeAllSessionsOp');

    await resetUserPassword(target.id, NEW_PASSWORD);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(target.id);
  });

  it('changeOwnPassword (Wave 3) delega a revokeAllSessionsOp 1× com o próprio userId, preservando a sessão corrente', async () => {
    const user = await createUser({ email: 'f5-change@example.com', role: 'EDITOR' });
    const { row } = await seedSession(user.id);

    const spy = jest.spyOn(sessionRevocation, 'revokeAllSessionsOp');

    await changeOwnPassword(
      user.id,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      row.id,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(user.id);
    expect(spy.mock.calls[0]![2]).toEqual({ exceptSessionId: row.id });
  });
});
