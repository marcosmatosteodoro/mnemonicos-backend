import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import cookieParser from 'cookie-parser';
import express, { type Express, Router } from 'express';
import request from 'supertest';

import { env } from '../../src/config/env';
import type { UserRole } from '../../src/domain/types';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { requireAuth } from '../../src/http/middlewares/authenticate';
import { errorHandler, notFoundHandler } from '../../src/http/middlewares/error-handler';
import { PrismaClient } from '../../src/generated/prisma/client';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import { disciplinesRoutes } from '../../src/modules/disciplines/disciplines.routes';
import { listDisciplines } from '../../src/modules/disciplines/disciplines.service';
import { closeTestDb, resetDb, testPrisma } from './db';
import { TEST_DATABASE_URL } from './db-url';

/**
 * `GET /disciplines` ponta-a-ponta (TASK-006-002, parte 2 — COMP-006-007) sobre
 * o Postgres real (harness de TASK-003-016). Cobre a **identidade parcial** (a
 * consolidação de `Paginated<T>` não muda a forma antiga do summary), a faceta
 * "fonte do campo tema" de AC-005-004 (`topics` não-vazio, ordenado por `name`)
 * e os round-trips fixados da lição [Performance] (relação de lista — medir
 * `query` × `join` e fixar; sonda de investigação descartável, não este teste).
 */

const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

async function createUser(role: UserRole = 'EDITOR') {
  return testPrisma.user.create({
    data: {
      email: `user-${randomUUID()}@example.com`,
      name: 'Edna Editora',
      passwordHash: 'irrelevante-para-este-teste',
      role,
    },
  });
}

/** Semeia uma `Session` viva e devolve o valor em claro do access token. */
async function seedSession(userId: string): Promise<string> {
  const access = generateToken();
  await testPrisma.session.create({
    data: {
      userId,
      familyId: randomUUID(),
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(generateToken()),
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return access;
}

async function seedDisciplineWithTopics(topicNames: string[]) {
  const discipline = await testPrisma.discipline.create({
    data: { name: `Disciplina ${randomUUID()}`, slug: `disciplina-${randomUUID()}` },
  });
  for (const name of topicNames) {
    await testPrisma.topic.create({
      data: { disciplineId: discipline.id, name, slug: `${name}-${randomUUID()}` },
    });
  }
  return discipline;
}

function buildApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  const api = Router();
  api.use(requireAuth);
  api.use(disciplinesRoutes);
  app.use(api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
  // A rota usa o client de produção (`src/lib/prisma.ts`), que durante a
  // integração aponta para o banco descartável.
  await prisma.$disconnect();
});

describe('GET /disciplines — identidade parcial + AC-005-004 (fonte do campo tema)', () => {
  it('mantém as chaves antigas do summary inalteradas e acrescenta topics ordenado por name', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const discipline = await seedDisciplineWithTopics(['Zebra', 'Abelha']);

    const res = await request(buildApp())
      .get('/disciplines')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const item = res.body.data[0];
    expect(item.id).toBe(discipline.id);
    expect(item.name).toBe(discipline.name);
    expect(item.slug).toBe(discipline.slug);
    expect(item.topicsCount).toBe(2);
    expect(Object.keys(item).sort()).toEqual(['id', 'name', 'slug', 'topics', 'topicsCount']);

    expect(item.topics).toEqual([
      expect.objectContaining({ name: 'Abelha' }),
      expect.objectContaining({ name: 'Zebra' }),
    ]);
    for (const topic of item.topics) {
      expect(Object.keys(topic).sort()).toEqual(['id', 'name', 'slug']);
    }
  });

  it('sem sessão → 401; papel fora de EDITOR/ADMIN segue negado (deny-by-default)', async () => {
    const res = await request(buildApp()).get('/disciplines');
    expect(res.status).toBe(401);
  });

  it('papel autenticado fora de EDITOR/ADMIN → 403 (STUDENT tem sessão válida, mas não o papel exigido)', async () => {
    const student = await createUser('STUDENT');
    const access = await seedSession(student.id);

    const res = await request(buildApp())
      .get('/disciplines')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(403);
  });

  it('página com múltiplas disciplinas: cada uma carrega seus próprios topics', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const a = await seedDisciplineWithTopics(['Um', 'Dois']);
    const b = await seedDisciplineWithTopics(['Tres']);

    const res = await request(buildApp())
      .get('/disciplines')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`);

    expect(res.status).toBe(200);
    const data = res.body.data as { id: string; topics: { name: string }[] }[];
    const byId = new Map(data.map((d) => [d.id, d]));
    expect(byId.get(a.id)?.topics.map((t) => t.name)).toEqual(['Dois', 'Um']);
    expect(byId.get(b.id)?.topics.map((t) => t.name)).toEqual(['Tres']);
  });
});

describe('listDisciplines — round-trips fixados (lição [Performance], relação de lista)', () => {
  /**
   * Client de teste próprio, instrumentado com `log: [{ emit: 'event', level:
   * 'query' }]` — o singleton de produção (`src/lib/prisma.ts`) só declara
   * `error`/`warn`. Mesmo padrão de
   * `auth.service.integration.test.ts` ("perfil §10: contagem de idas ao banco
   * fixada em 1"). Devolve a lista bruta de queries: os dois usos abaixo
   * derivam dela — `.length` para round-trips, `.find(LATERAL)` para a forma
   * do join.
   */
  async function withQueryProbe(run: (probe: PrismaClient) => Promise<unknown>): Promise<string[]> {
    const probe = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 1 }),
      log: [{ emit: 'event', level: 'query' }],
    });
    const queries: string[] = [];
    probe.$on('query', (event) => queries.push(event.query));

    try {
      await run(probe);
    } finally {
      await probe.$disconnect();
    }

    return queries;
  }

  it('1 disciplina com 2 temas semeados — exatamente 2 round-trips (findMany via join + count)', async () => {
    await seedDisciplineWithTopics(['Alfa', 'Beta']);

    const queries = await withQueryProbe((probe) =>
      listDisciplines({ page: 1, perPage: 20 }, probe),
    );

    expect(queries).toHaveLength(2);
  });

  it('2 disciplinas com 2 temas cada — a contagem não cresce com N (continua 2, não N+1)', async () => {
    await seedDisciplineWithTopics(['Alfa', 'Beta']);
    await seedDisciplineWithTopics(['Gama', 'Delta']);

    const queries = await withQueryProbe((probe) =>
      listDisciplines({ page: 1, perPage: 20 }, probe),
    );

    expect(queries).toHaveLength(2);
  });

  it('a query de topics não usa `include` implícito — o join aparece como SELECT único com LATERAL', async () => {
    await seedDisciplineWithTopics(['Alfa', 'Beta']);

    const queries = await withQueryProbe((probe) =>
      listDisciplines({ page: 1, perPage: 20 }, probe),
    );

    const findManyQuery = queries.find((q) => /LATERAL/i.test(q));
    expect(findManyQuery).toBeDefined();
    expect(findManyQuery).toContain('"public"."disciplines"');
  });
});
