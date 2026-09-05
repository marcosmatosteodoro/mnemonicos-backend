import { randomUUID } from 'node:crypto';

import cookieParser from 'cookie-parser';
import express, { type Express, Router } from 'express';
import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import type { UserRole } from '../../src/domain/types';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { requireAuth } from '../../src/http/middlewares/authenticate';
import { requireRole } from '../../src/http/middlewares/authorize';
import { errorHandler, notFoundHandler } from '../../src/http/middlewares/error-handler';
import { isPublicPath, PUBLIC_PATH_ALLOWLIST } from '../../src/http/public-paths';
import {
  declareRouteRoles,
  type HttpMethod,
  resetRouteRoles,
  rolesForPath,
  ROUTE_ROLES,
} from '../../src/http/route-roles';
import {
  apiRoutes,
  assertDenyByDefault,
  collectRoutes,
  type MountedRoute,
} from '../../src/http/routes';
import { hashPassword } from '../../src/lib/password';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import { verifyOrigin } from '../../src/modules/auth/auth.routes';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * Suíte de conformidade da barreira de autorização (COMP-003-019) — a **fonte de
 * medição externa** da métrica §1.3 (SPEC-002): enumera as rotas montadas na
 * `app` real (`createApp()` → `apiRoutes` sob `/api/v1`; Express 5 removeu
 * `app._router`, a pilha é `router.stack`) e prova, para cada rota não-pública,
 * 401 sem sessão e 403 com papel insuficiente ou não declarado. Roda sobre o
 * Postgres real (harness de TASK-003-016) porque o 403/200 de papel exige uma
 * sessão de verdade resolvida por `resolveAccessSession`.
 *
 * Cobre AC-002-010 (401 por rota não-pública), AC-002-011/AC-002-018 (403 do
 * EDITOR nas rotas ADMIN + ausência de auto-registro), AC-002-014 (rota sem
 * declaração nasce negada), NFR-002-001 (deny-by-default), a EMENDA DEC-003-005
 * (chave exata `<MÉTODO> <caminho>` para toda rota montada — fecha o resíduo do
 * `:param` da irmã estática) e a EMENDA DEC-003-004 (`verifyOrigin` em toda
 * mutação autenticada por cookie).
 *
 * **Ordem de execução (Jest roda os `describe` na ordem do arquivo):** os blocos
 * que exercitam a `app` real e o registro `ROUTE_ROLES` vivo vêm todos antes do
 * bloco final de topologias adversariais, que chama `resetRouteRoles()` (limpa e
 * dessela) para montar árvores locais — depois dele o `app`/registro de produção
 * não são mais consultados neste arquivo.
 */

const PASSWORD = 'senha-de-fixture-123';
const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

/** A `app` como o cliente a alcança: `createApp()` monta `apiRoutes` sob `/api/v1`. */
const app = createApp();

/** Rotas concretas da árvore montada — derivadas de `apiRoutes.stack`, nunca hard-coded. */
const ROUTES: MountedRoute[] = collectRoutes(apiRoutes);
const NON_PUBLIC = ROUTES.filter((route) => !isPublicPath(route.method, route.path));
const MUTATION_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Cópia do registro tirada na carga do módulo (já selado e populado por
 * `routes.ts`). Imune à reordenação de testes e ao `resetRouteRoles()` do bloco
 * adversarial — as asserções de "chave exata" comparam contra este retrato.
 */
const REGISTRY = new Map<string, ReadonlySet<UserRole>>(
  [...ROUTE_ROLES].map(([key, roles]) => [key, new Set(roles)]),
);

function key(route: MountedRoute): string {
  return `${route.method} ${route.path}`;
}

/** É {ADMIN} exato — o conjunto das rotas de gestão. */
function isAdminOnly(k: string): boolean {
  const roles = REGISTRY.get(k);
  return roles !== undefined && roles.size === 1 && roles.has('ADMIN');
}

/** `/users/:id/disable` → `/users/<uuid>/disable` (a recusa 401/403 acontece antes de o schema do param ser lido). */
function concrete(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? randomUUID() : segment))
    .join('/');
}

function send(target: Express, method: HttpMethod, url: string) {
  switch (method) {
    case 'GET':
      return request(target).get(url);
    case 'POST':
      return request(target).post(url);
    case 'PUT':
      return request(target).put(url);
    case 'PATCH':
      return request(target).patch(url);
    case 'DELETE':
      return request(target).delete(url);
  }
}

let sharedPasswordHash: string;

/** Usuário + sessão viva do papel pedido; devolve o valor em claro do cookie de acesso. */
async function seedSession(role: UserRole): Promise<{ userId: string; access: string }> {
  const user = await testPrisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${randomUUID()}@example.com`,
      name: 'Fulano de Fixture',
      passwordHash: sharedPasswordHash,
      role,
    },
  });
  const access = generateToken();
  const refreshValue = generateToken();
  await testPrisma.session.create({
    data: {
      userId: user.id,
      familyId: randomUUID(),
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(refreshValue),
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { userId: user.id, access };
}

beforeAll(async () => {
  sharedPasswordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
  // `requireAuth`/serviços usam o client singleton de produção (`src/lib/prisma.ts`);
  // sem fechar o pool dele o Jest fica com handle aberto (lição da Wave 3).
  await prisma.$disconnect();
});

describe('fonte de medição da métrica §1.3 — censo das rotas montadas', () => {
  it('a árvore montada é exatamente estes 19 pares método+caminho (tripwire: rota nova sem atualizar a suíte falha aqui)', () => {
    expect(ROUTES.map(key).sort()).toEqual(
      [
        'GET /health',
        'GET /health/db',
        'POST /auth/login',
        'POST /auth/refresh',
        'POST /auth/logout',
        'POST /auth/change-password',
        'GET /auth/me',
        'GET /users',
        'POST /users',
        'PATCH /users/:id/disable',
        'POST /users/:id/reset-password',
        'GET /disciplines',
        'GET /contents',
        'POST /contents',
        'GET /contents/:id',
        'PATCH /contents/:id',
        'DELETE /contents/:id',
        'GET /contents/:id/breakdown',
        'PUT /contents/:id/breakdown',
      ].sort(),
    );
  });

  it('há ao menos uma rota não-pública para medir', () => {
    expect(NON_PUBLIC.length).toBeGreaterThan(0);
  });
});

describe('AC-002-010 / NFR-002-001 — toda rota não-pública nega sem sessão (401)', () => {
  it('cada par {método, caminho} ∉ PUBLIC_PATH_ALLOWLIST → 401 sem cookie, sem corpo específico da rota', async () => {
    expect(NON_PUBLIC.length).toBeGreaterThan(0);

    for (const route of NON_PUBLIC) {
      const res = await send(app, route.method, `/api/v1${concrete(route.path)}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
    }
  });

  it('os caminhos de leitura da allowlist pública respondem 200 sem cookie (a exceção declarada)', async () => {
    for (const path of ['/health', '/health/db']) {
      const res = await request(app).get(`/api/v1${path}`);
      expect(res.status).toBe(200);
    }
  });
});

describe('AC-002-011 / AC-002-012 — rotas restritas a ADMIN negam o EDITOR (403)', () => {
  it('cada rota cujo conjunto declarado é {ADMIN} → 403 com sessão de EDITOR', async () => {
    const adminOnly = NON_PUBLIC.filter((route) => isAdminOnly(key(route)));
    expect(adminOnly.length).toBeGreaterThan(0);

    const { access } = await seedSession('EDITOR');

    for (const route of adminOnly) {
      const res = await send(app, route.method, `/api/v1${concrete(route.path)}`).set(
        'Cookie',
        `${ACCESS_COOKIE}=${access}`,
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });
});

describe('AC-002-018 — nenhuma capacidade de auto-registro na superfície montada', () => {
  it('nenhuma rota montada é caminho de auto-registro (register/signup)', () => {
    const suspicious = ROUTES.filter((route) => /register|sign-?up|sign_up/i.test(route.path)).map(
      key,
    );
    expect(suspicious).toEqual([]);
  });

  it('POST /users (única rota que cria conta) exige {ADMIN}; as demais POST não-{ADMIN} não criam conta (sessão ou domínio de conteúdo — TASK-006-011)', () => {
    expect(REGISTRY.get('POST /users')).toEqual(new Set<UserRole>(['ADMIN']));

    const postRoutes = NON_PUBLIC.filter((route) => route.method === 'POST');
    expect(postRoutes.length).toBeGreaterThan(0);

    const nonAdminPost = postRoutes
      .filter((route) => !isAdminOnly(key(route)))
      .map((route) => route.path)
      .sort();
    expect(nonAdminPost).toEqual(['/auth/change-password', '/auth/logout', '/contents']);
  });

  it('POST /api/v1/users sem sessão → 401; com sessão de EDITOR → 403', async () => {
    const anon = await request(app).post('/api/v1/users').send({});
    expect(anon.status).toBe(401);

    const { access } = await seedSession('EDITOR');
    const asEditor = await request(app)
      .post('/api/v1/users')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .send({});
    expect(asEditor.status).toBe(403);
  });
});

describe('EMENDA DEC-003-005 — chave EXATA "<MÉTODO> <caminho>" para toda rota montada não-pública', () => {
  it('cada rota não-pública tem a chave exata em ROUTE_ROLES (igualdade, não rolesForPath com fallback de padrão)', () => {
    const missing = NON_PUBLIC.filter((route) => !ROUTE_ROLES.has(key(route))).map(key);
    expect(missing).toEqual([]);
  });

  it('o passo de boot assertDenyByDefault aceita a árvore real montada', () => {
    expect(() => assertDenyByDefault(apiRoutes)).not.toThrow();
  });
});

describe('[retry S4] PUBLIC_PATH_ALLOWLIST — pares "<MÉTODO> <caminho>" método-aware (EMENDA DEC-003-005 Wave 6)', () => {
  it('[...PUBLIC_PATH_ALLOWLIST].sort() é exatamente os 4 pares previstos, e crescer exige mudança deliberada', () => {
    expect([...PUBLIC_PATH_ALLOWLIST].sort()).toEqual([
      'GET /health',
      'GET /health/db',
      'POST /auth/login',
      'POST /auth/refresh',
    ]);
  });

  it('isPublicPath casa o par exato: o método errado no caminho certo NÃO é público', () => {
    expect(isPublicPath('GET', '/health')).toBe(true);
    expect(isPublicPath('GET', '/health/db')).toBe(true);
    expect(isPublicPath('POST', '/auth/login')).toBe(true);
    expect(isPublicPath('POST', '/auth/refresh')).toBe(true);

    // método fora do par declarado → cai na barreira
    expect(isPublicPath('DELETE', '/health')).toBe(false);
    expect(isPublicPath('POST', '/health')).toBe(false);
    expect(isPublicPath('GET', '/auth/login')).toBe(false);
    expect(isPublicPath('GET', '/auth/refresh')).toBe(false);
  });

  it('DELETE /api/v1/health (método fora do par público) não escapa pela allowlist → 401, não 404', async () => {
    const res = await request(app).delete('/api/v1/health');
    expect(res.status).toBe(401);
  });

  it('as rotas públicas de auth ficam só na allowlist — nunca em ROUTE_ROLES', () => {
    expect(ROUTE_ROLES.has('POST /auth/login')).toBe(false);
    expect(ROUTE_ROLES.has('POST /auth/refresh')).toBe(false);
  });
});

describe('A-002-019 — /disciplines passa a exigir sessão', () => {
  it('GET /api/v1/disciplines sem cookie → 401; com sessão de EDITOR → não-401 (200)', async () => {
    const anon = await request(app).get('/api/v1/disciplines');
    expect(anon.status).toBe(401);

    const { access } = await seedSession('EDITOR');
    const asEditor = await request(app)
      .get('/api/v1/disciplines')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(asEditor.status).not.toBe(401);
    expect(asEditor.status).toBe(200);
  });

  it('GET /disciplines está declarada como {EDITOR, ADMIN}', () => {
    expect(REGISTRY.get('GET /disciplines')).toEqual(new Set<UserRole>(['EDITOR', 'ADMIN']));
  });
});

describe('EMENDA DEC-003-004 — verifyOrigin em toda rota de mutação não-pública', () => {
  it('cada POST/PATCH/PUT/DELETE não-público tem verifyOrigin (por referência de função) na cadeia', () => {
    const mutations = NON_PUBLIC.filter((route) => MUTATION_METHODS.has(route.method));
    expect(mutations.length).toBeGreaterThan(0);

    const semVerifyOrigin = mutations
      .filter((route) => !route.handlers.includes(verifyOrigin))
      .map(key);
    expect(semVerifyOrigin).toEqual([]);
  });
});

describe('montagem — caminho feliz (oráculo distinto do request): sessão legítima alcança a rota do seu papel', () => {
  it('GET /api/v1/auth/me com sessão de EDITOR → 200, sem ninguém popular ROUTE_ROLES à mão', async () => {
    const { userId, access } = await seedSession('EDITOR');

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(userId);
  });

  it('GET /api/v1/users com sessão de ADMIN → 200', async () => {
    const { access } = await seedSession('ADMIN');

    const res = await request(app).get('/api/v1/users').set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(200);
  });

  it('a declaração aconteceu na montagem e o registro está SELADO após o boot', () => {
    expect(ROUTE_ROLES.size).toBeGreaterThanOrEqual(NON_PUBLIC.length);
    expect(() => declareRouteRoles('GET', '/rota-em-runtime', ['ADMIN'])).toThrow(/selad/i);
  });

  it('[Arquitetura] GET /contents com sessão de EDITOR → 200, e com sessão de ADMIN → 200 (mutante que move a declaração de papéis para dentro do handler faz este caso virar 403)', async () => {
    const { access: editorAccess } = await seedSession('EDITOR');
    const asEditor = await request(app)
      .get('/api/v1/contents')
      .set('Cookie', `${ACCESS_COOKIE}=${editorAccess}`);
    expect(asEditor.status).toBe(200);

    const { access: adminAccess } = await seedSession('ADMIN');
    const asAdmin = await request(app)
      .get('/api/v1/contents')
      .set('Cookie', `${ACCESS_COOKIE}=${adminAccess}`);
    expect(asAdmin.status).toBe(200);
  });
});

describe('TASK-006-011 — as 7 rotas de /contents sob a barreira (topologia adversarial, itens i/ii/v da lição [Segurança])', () => {
  const CONTENT_ROUTE_KEYS = [
    'GET /contents',
    'POST /contents',
    'GET /contents/:id',
    'PATCH /contents/:id',
    'DELETE /contents/:id',
    'GET /contents/:id/breakdown',
    'PUT /contents/:id/breakdown',
  ];

  it('cada uma das 7 rotas está declarada como {EDITOR, ADMIN}; GET/POST em /contents e GET/PUT em /contents/:id/breakdown têm chaves PRÓPRIAS (ii: 2º método no mesmo caminho)', () => {
    for (const routeKey of CONTENT_ROUTE_KEYS) {
      expect(REGISTRY.get(routeKey)).toEqual(new Set<UserRole>(['EDITOR', 'ADMIN']));
    }

    // Chaves independentes: nenhum par herda a declaração do outro pelo caminho.
    expect(ROUTE_ROLES.has('GET /contents')).toBe(true);
    expect(ROUTE_ROLES.has('POST /contents')).toBe(true);
    expect(ROUTE_ROLES.has('GET /contents/:id/breakdown')).toBe(true);
    expect(ROUTE_ROLES.has('PUT /contents/:id/breakdown')).toBe(true);
  });

  it('STUDENT recusado (403) nas 7 rotas — (i) a rota irmã estática GET /contents não "vaza" a permissividade para GET /contents/:id, nem vice-versa; (v) todas as 7 recusam STUDENT', async () => {
    const contentRoutes = NON_PUBLIC.filter((route) => route.path.startsWith('/contents'));
    expect(contentRoutes.map(key).sort()).toEqual([...CONTENT_ROUTE_KEYS].sort());

    const { access } = await seedSession('STUDENT');

    for (const route of contentRoutes) {
      const res = await send(app, route.method, `/api/v1${concrete(route.path)}`).set(
        'Cookie',
        `${ACCESS_COOKIE}=${access}`,
      );
      expect(res.status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Topologias adversariais — isolam o registro (`resetRouteRoles()` limpa E
// dessela). Rodam por último: nada depois consulta a `app` real nem o registro
// de produção.
// ---------------------------------------------------------------------------

describe('AC-002-014 — rota sem declaração de papel nasce negada (falha fechada)', () => {
  it('rota fictícia montada após requireAuth SEM requireRole + sessão de EDITOR → 403 (não 401)', async () => {
    resetRouteRoles();
    const { access } = await seedSession('EDITOR');

    const local = express();
    local.use(cookieParser());
    const api = Router();
    api.use(requireAuth);
    api.get('/fantasma', (_req, res) => res.json({ marker: 'nao-devia-chegar' }));
    local.use(api);
    local.use(notFoundHandler);
    local.use(errorHandler);

    const res = await request(local).get('/fantasma').set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    // A recusa vem da ausência de declaração: `rolesForPath` não resolve nada.
    expect(rolesForPath('GET', '/fantasma')).toBeUndefined();
  });

  it('irmã estática GET /_probe/export ao lado de GET /_probe/:id permissivo: rolesForPath VAZA, mas falta a chave exata e o boot recusa', () => {
    resetRouteRoles();
    const api = Router();
    api.use(requireAuth);
    // Estática ANTES do `:param` — é a irmã que o Express casa primeiro e que
    // ninguém declarou.
    api.get('/_probe/export', (_req, res) => res.json({ ok: true }));
    api.get('/_probe/:id', requireRole('GET', '/_probe/:id', 'EDITOR', 'ADMIN'), (_req, res) =>
      res.json({ ok: true }),
    );

    // `rolesForPath` casa a irmã estática contra o `:param` do vizinho — o vazamento.
    expect(rolesForPath('GET', '/_probe/export')).toEqual(new Set<UserRole>(['EDITOR', 'ADMIN']));
    // A conformidade exige a chave EXATA, que não existe para a irmã não declarada.
    expect(ROUTE_ROLES.has('GET /_probe/export')).toBe(false);
    // E o passo de boot recusa subir a árvore — o fechamento pleno do resíduo.
    expect(() => assertDenyByDefault(api)).toThrow(/GET \/_probe\/export/);
  });

  it('sem o passo de boot, um EDITOR alcançaria a irmã não declarada — o 200 que a chave exata transforma em recusa', async () => {
    resetRouteRoles();
    const { access } = await seedSession('EDITOR');

    const local = express();
    local.use(cookieParser());
    const api = Router();
    api.use(requireAuth);
    // Estática ANTES do `:param`: o Express serve esta, e `requireAuth` a deixa
    // passar porque `rolesForPath` cai no `:param` do vizinho.
    api.get('/_probe/export', (_req, res) => res.json({ leaked: true }));
    api.get('/_probe/:id', requireRole('GET', '/_probe/:id', 'EDITOR', 'ADMIN'), (_req, res) =>
      res.json({ ok: true }),
    );
    local.use(api);
    local.use(errorHandler);

    const res = await request(local)
      .get('/_probe/export')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    // 200 aqui é o vazamento que `assertDenyByDefault` (chave exata) impede na
    // montagem real: trocar a asserção de chave exata por `rolesForPath(...) !==
    // undefined` reabriria exatamente este caminho.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leaked: true });
  });
});

describe('[Testes] TASK-006-011 — assertDenyByDefault: teste de FUNÇÃO sobre as 7 rotas de /contents (iii + a lição "asserção de invariante exige DOIS testes: função + wiring")', () => {
  const noop = (_req: unknown, res: { json: (b: unknown) => void }): void => res.json({ ok: true });

  it('(a) reprova uma árvore com uma das 7 rotas de /contents sem declaração; aceita a árvore com as 7 declaradas', () => {
    resetRouteRoles();
    const incomplete = Router();
    incomplete.use(requireAuth);
    incomplete.get('/contents', requireRole('GET', '/contents', 'EDITOR', 'ADMIN'), noop);
    incomplete.post('/contents', requireRole('POST', '/contents', 'EDITOR', 'ADMIN'), noop);
    incomplete.get('/contents/:id', requireRole('GET', '/contents/:id', 'EDITOR', 'ADMIN'), noop);
    incomplete.patch(
      '/contents/:id',
      requireRole('PATCH', '/contents/:id', 'EDITOR', 'ADMIN'),
      noop,
    );
    incomplete.delete(
      '/contents/:id',
      requireRole('DELETE', '/contents/:id', 'EDITOR', 'ADMIN'),
      noop,
    );
    incomplete.get(
      '/contents/:id/breakdown',
      requireRole('GET', '/contents/:id/breakdown', 'EDITOR', 'ADMIN'),
      noop,
    );
    // 7ª rota SEM requireRole — não declara "PUT /contents/:id/breakdown".
    incomplete.put('/contents/:id/breakdown', noop);

    expect(() => assertDenyByDefault(incomplete)).toThrow(/PUT \/contents\/:id\/breakdown/);

    resetRouteRoles();
    const complete = Router();
    complete.use(requireAuth);
    complete.get('/contents', requireRole('GET', '/contents', 'EDITOR', 'ADMIN'), noop);
    complete.post('/contents', requireRole('POST', '/contents', 'EDITOR', 'ADMIN'), noop);
    complete.get('/contents/:id', requireRole('GET', '/contents/:id', 'EDITOR', 'ADMIN'), noop);
    complete.patch('/contents/:id', requireRole('PATCH', '/contents/:id', 'EDITOR', 'ADMIN'), noop);
    complete.delete(
      '/contents/:id',
      requireRole('DELETE', '/contents/:id', 'EDITOR', 'ADMIN'),
      noop,
    );
    complete.get(
      '/contents/:id/breakdown',
      requireRole('GET', '/contents/:id/breakdown', 'EDITOR', 'ADMIN'),
      noop,
    );
    complete.put(
      '/contents/:id/breakdown',
      requireRole('PUT', '/contents/:id/breakdown', 'EDITOR', 'ADMIN'),
      noop,
    );

    expect(() => assertDenyByDefault(complete)).not.toThrow();
  });
});

describe('[retry CR1] TASK-006-011 — assertDenyByDefault tem teste de WIRING específico de /contents (armamento no boot, não só de função)', () => {
  afterEach(() => {
    jest.dontMock('../../src/modules/contents/contents.routes');
  });

  it('(b) reimportar a árvore de montagem (routes.ts) com uma rota /contents sem requireRole → a carga do módulo LANÇA', async () => {
    // Fecho falsificável (mutante d da TASK): comentar a linha
    // `assertDenyByDefault(apiRoutes);` de routes.ts deixa ESTE teste vermelho.
    await expect(
      jest.isolateModulesAsync(async () => {
        jest.doMock('../../src/modules/contents/contents.routes', () => {
          const rogue = Router();
          // não-pública, montada sem requireRole → sem chave "PUT /contents/:id/breakdown" em ROUTE_ROLES
          rogue.put('/contents/:id/breakdown', (_req, res) => res.json({ leaked: true }));
          return { contentsRoutes: rogue };
        });

        // `.js` explícito: `import()` num módulo CJS segue a resolução ESM do
        // nodenext (o `moduleNameMapper` do Jest reescreve para o `.ts`).
        await import('../../src/http/routes.js');
      }),
    ).rejects.toThrow(/PUT \/contents\/:id\/breakdown/);
  });
});

describe('[retry S4] assertDenyByDefault — ordem de montagem × PUBLIC_PATH_ALLOWLIST método-aware (EMENDA DEC-003-005 Wave 6)', () => {
  it('rota GET /auth/login (par ∉ allowlist) montada ANTES de requireAuth → o boot LANÇA', () => {
    resetRouteRoles();
    const api = Router();
    api.get('/auth/login', (_req, res) => res.json({ leaked: true }));
    api.use(requireAuth);
    api.get('/auth/me', requireRole('GET', '/auth/me', 'EDITOR', 'ADMIN'), (_req, res) =>
      res.json({ ok: true }),
    );

    expect(() => assertDenyByDefault(api)).toThrow(/GET \/auth\/login/);
  });

  it('rota declarada em ROUTE_ROLES porém não-pública, montada ANTES de requireAuth → o boot LANÇA (checagem de ordem, não de declaração)', () => {
    resetRouteRoles();
    declareRouteRoles('GET', '/relatorios', ['EDITOR', 'ADMIN']);
    const api = Router();
    // Tem chave exata em ROUTE_ROLES — passa a checagem de declaração —, mas
    // escapa da barreira por estar montada antes dela sem ser par público.
    api.get('/relatorios', (_req, res) => res.json({ leaked: true }));
    api.use(requireAuth);

    expect(() => assertDenyByDefault(api)).toThrow(
      /antes de requireAuth fora de PUBLIC_PATH_ALLOWLIST/,
    );
    expect(() => assertDenyByDefault(api)).toThrow(/GET \/relatorios/);
  });

  it('par público correto (POST /auth/refresh) montado DEPOIS de requireAuth → o boot LANÇA', () => {
    resetRouteRoles();
    const api = Router();
    api.use(requireAuth);
    api.post('/auth/refresh', (_req, res) => res.json({ ok: true }));

    expect(() => assertDenyByDefault(api)).toThrow(/depois de requireAuth/);
    expect(() => assertDenyByDefault(api)).toThrow(/POST \/auth\/refresh/);
  });

  it('par público correto (POST /auth/login) montado ANTES de requireAuth, resto declarado → o boot ACEITA', () => {
    resetRouteRoles();
    const api = Router();
    api.post('/auth/login', (_req, res) => res.json({ ok: true }));
    api.use(requireAuth);
    api.get('/auth/me', requireRole('GET', '/auth/me', 'EDITOR', 'ADMIN'), (_req, res) =>
      res.json({ ok: true }),
    );

    expect(() => assertDenyByDefault(api)).not.toThrow();
  });
});

describe('[retry CR1] assertDenyByDefault tem teste de WIRING — armamento no boot, não só de função', () => {
  afterEach(() => {
    jest.dontMock('../../src/modules/disciplines/disciplines.routes');
  });

  it('reimportar a árvore de montagem (routes.ts) com uma rota não-pública sem declaração exata → a carga do módulo LANÇA', async () => {
    // Fecho falsificável (espelha o wiring de sealRouteRoles): comentar a linha
    // `assertDenyByDefault(apiRoutes);` de routes.ts deixa ESTE teste vermelho —
    // hoje a linha some sem quebrar nada, a suíte fica verde.
    await expect(
      jest.isolateModulesAsync(async () => {
        jest.doMock('../../src/modules/disciplines/disciplines.routes', () => {
          const rogue = Router();
          // não-pública, montada sem requireRole → sem chave "GET /rogue" em ROUTE_ROLES
          rogue.get('/rogue', (_req, res) => res.json({ leaked: true }));
          return { disciplinesRoutes: rogue };
        });

        // `.js` explícito: `import()` num módulo CJS segue a resolução ESM do
        // nodenext (o `moduleNameMapper` do Jest reescreve para o `.ts`).
        await import('../../src/http/routes.js');
      }),
    ).rejects.toThrow(/GET \/rogue/);
  });
});
