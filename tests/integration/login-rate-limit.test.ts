import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';

import { logger } from '../../src/lib/logger';
import {
  createLoginRateLimiters,
  LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX,
  LOGIN_RATE_LIMIT_PER_ORIGIN_MAX,
  loginRateLimiters,
} from '../../src/modules/auth/login-rate-limit';

/**
 * Freio de login por chave composta (TASK-003-008 — COMP-003-009). O módulo não
 * toca banco: um `app` mínimo monta os handlers antes de uma rota-alvo que
 * responde 200, e `supertest` exercita a janela. Os limiters de produção têm
 * `skip: () => isTest`, então os casos que precisam ver o freio disparar
 * instanciam o par com `createLoginRateLimiters({ skip: () => false, ... })` —
 * o `skip` de produção-em-teste do resto da suíte fica intacto (há um caso que
 * o comprova).
 *
 * Cobre AC-002-003 (limiar por conta e por origem; sem lockout; auditoria;
 * contas legítimas seguem autenticando) e NFR-002-006 (mais estrito que o
 * limite global de `src/app.ts`).
 */

/**
 * Teto do limite global da API, declarado em `src/app.ts` (`limiter`, limit 300
 * / 15 min). Não é exportado de lá; a referência é literal e comentada — se o
 * global mudar, este número precisa acompanhar.
 */
const GLOBAL_API_RATE_LIMIT_MAX = 300;

interface AuditPayload {
  audit?: {
    type?: string;
    subject?: string;
    ip?: string;
    userAgent?: string;
    outcome?: string;
  };
}

let emailSeq = 0;
function uniqueEmail(): string {
  emailSeq += 1;
  return `legit-${emailSeq}@example.com`;
}

/** `app` mínimo: `trust proxy` numérico como em `src/app.ts`, JSON parseado antes do freio. */
function buildLoginApp(limiters: RequestHandler[]): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/auth/login', ...limiters, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

function spyAuthLog() {
  return jest.spyOn(logger, 'info').mockImplementation(() => undefined);
}

function throttledEvents(calls: unknown[][]): AuditPayload[] {
  return calls
    .map((call) => call[0] as AuditPayload)
    .filter((payload) => payload.audit?.type === 'login.throttled');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('freio de login — AC-002-003: limiar por conta', () => {
  it('estoura o teto da conta → 429 + Retry-After + corpo de erro do projeto, e audita login.throttled', async () => {
    const info = spyAuthLog();
    const app = buildLoginApp(
      createLoginRateLimiters({ skip: () => false, perAccountMax: 3, perOriginMax: 100 }),
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const allowed = await request(app)
        .post('/auth/login')
        .send({ email: 'alvo@example.com', password: 'x' });
      expect(allowed.status).toBe(200);
    }

    const blocked = await request(app)
      .post('/auth/login')
      .send({ email: 'alvo@example.com', password: 'x' });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body).toEqual({
      error: { code: 'TOO_MANY_REQUESTS', message: expect.any(String) },
    });

    const events = throttledEvents(info.mock.calls);
    expect(events).toHaveLength(1);
    expect(events[0]?.audit?.subject).toBe('alvo@example.com');
    expect(events[0]?.audit?.outcome).toBe('failure');
  });

  it('freada a conta A, uma conta B legítima da mesma origem ainda autentica', async () => {
    const app = buildLoginApp(
      createLoginRateLimiters({ skip: () => false, perAccountMax: 2, perOriginMax: 100 }),
    );

    await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'x' });
    await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'x' });
    const aBlocked = await request(app)
      .post('/auth/login')
      .send({ email: 'a@example.com', password: 'x' });
    expect(aBlocked.status).toBe(429);

    const bStillWorks = await request(app)
      .post('/auth/login')
      .send({ email: 'b@example.com', password: 'x' });
    expect(bStillWorks.status).toBe(200);
  });

  it('nenhum lockout duro: passada a janela, a conta freada volta a autenticar', async () => {
    const app = buildLoginApp(
      createLoginRateLimiters({
        skip: () => false,
        perAccountMax: 2,
        perOriginMax: 100,
        windowMs: 250,
      }),
    );
    const tryLogin = () =>
      request(app).post('/auth/login').send({ email: 'temp@example.com', password: 'x' });

    expect((await tryLogin()).status).toBe(200);
    expect((await tryLogin()).status).toBe(200);
    expect((await tryLogin()).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect((await tryLogin()).status).toBe(200);
  });
});

describe('freio de login — AC-002-003: limiar por origem (trust proxy 1)', () => {
  it('conta IPs de X-Forwarded-For distintos em baldes separados e não deixa uma origem barrar a outra', async () => {
    const app = buildLoginApp(
      createLoginRateLimiters({ skip: () => false, perAccountMax: 100, perOriginMax: 2 }),
    );

    const fromOriginA = () =>
      request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ email: uniqueEmail(), password: 'x' });

    expect((await fromOriginA()).status).toBe(200);
    expect((await fromOriginA()).status).toBe(200);
    expect((await fromOriginA()).status).toBe(429);

    const fromOriginB = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', '203.0.113.20')
      .send({ email: uniqueEmail(), password: 'x' });

    expect(fromOriginB.status).toBe(200);
  });

  it('o freio de origem não persiste "conta bloqueada": a mesma conta autentica por outra origem', async () => {
    const app = buildLoginApp(
      createLoginRateLimiters({ skip: () => false, perAccountMax: 100, perOriginMax: 1 }),
    );

    await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', '198.51.100.30')
      .send({ email: 'compartilhada@example.com', password: 'x' });
    const originExhausted = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', '198.51.100.30')
      .send({ email: 'compartilhada@example.com', password: 'x' });
    expect(originExhausted.status).toBe(429);

    const sameAccountOtherOrigin = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', '203.0.113.40')
      .send({ email: 'compartilhada@example.com', password: 'x' });
    expect(sameAccountOtherOrigin.status).toBe(200);
  });
});

describe('freio de login — corpo sem e-mail', () => {
  it('cai no balde anônimo do freio de conta e ainda é freado (subject = anonymous)', async () => {
    const info = spyAuthLog();
    const app = buildLoginApp(
      createLoginRateLimiters({ skip: () => false, perAccountMax: 1, perOriginMax: 100 }),
    );

    expect((await request(app).post('/auth/login').send({ password: 'x' })).status).toBe(200);
    const blocked = await request(app).post('/auth/login').send({ password: 'x' });

    expect(blocked.status).toBe(429);
    expect(throttledEvents(info.mock.calls)[0]?.audit?.subject).toBe('anonymous');
  });
});

describe('freio de login — NFR-002-006: mais estrito que o limite global', () => {
  it('os tetos por conta e por origem são menores que o teto global da API', () => {
    expect(LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX).toBeLessThan(GLOBAL_API_RATE_LIMIT_MAX);
    expect(LOGIN_RATE_LIMIT_PER_ORIGIN_MAX).toBeLessThan(GLOBAL_API_RATE_LIMIT_MAX);
  });

  it('numa sequência de tentativas, o freio de conta corta na (max + 1)ª — muito antes do global', async () => {
    const app = buildLoginApp(createLoginRateLimiters({ skip: () => false }));

    let firstBlockedAt = 0;
    for (
      let attempt = 1;
      attempt <= LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX + 2 && firstBlockedAt === 0;
      attempt += 1
    ) {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'bruteforce@example.com', password: 'x' });
      if (res.status === 429) firstBlockedAt = attempt;
    }

    expect(firstBlockedAt).toBe(LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX + 1);
    expect(firstBlockedAt).toBeLessThan(GLOBAL_API_RATE_LIMIT_MAX);
  });
});

describe('freio de login — skip de produção-em-teste', () => {
  it('os limiters exportados respeitam skip:isTest e não freiam a suíte sob NODE_ENV=test', async () => {
    const app = buildLoginApp(loginRateLimiters);

    for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT_PER_ACCOUNT_MAX + 3; attempt += 1) {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'suite@example.com', password: 'x' });
      expect(res.status).toBe(200);
    }
  });
});

describe('freio de login — evento de auditoria (NFR-002-005)', () => {
  it('login.throttled leva subject normalizado, ip e userAgent — e nenhum segredo do corpo', async () => {
    const info = spyAuthLog();
    const app = buildLoginApp(
      createLoginRateLimiters({ skip: () => false, perAccountMax: 1, perOriginMax: 100 }),
    );

    const send = () =>
      request(app)
        .post('/auth/login')
        .set('User-Agent', 'jest-agent/9')
        .send({ email: '  Alvo@Example.COM  ', password: 'super-secreta-123' });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);

    const events = throttledEvents(info.mock.calls);
    expect(events).not.toHaveLength(0);
    const first = events[0];
    expect(first?.audit?.subject).toBe('alvo@example.com');
    expect(typeof first?.audit?.ip).toBe('string');
    expect((first?.audit?.ip ?? '').length).toBeGreaterThan(0);
    expect(first?.audit?.userAgent).toBe('jest-agent/9');
    expect(JSON.stringify(info.mock.calls)).not.toContain('super-secreta-123');
  });
});
