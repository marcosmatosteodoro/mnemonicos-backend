import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import type { UserRole } from '../../src/domain/types';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import type {
  CreateRawContentInput,
  SaveRuleBreakdownInput,
} from '../../src/modules/contents/contents.schema';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `contents.routes.ts` (TASK-006-011) ponta-a-ponta sobre a `app` **real**
 * (`createApp()`, sem popular `ROUTE_ROLES` à mão — lição [Arquitetura]) e o
 * Postgres real (harness de TASK-003-016). A rota **só expõe** a regra de
 * negócio já provada em `contents.service.integration.test.ts` (T006/T008/T009)
 * — aqui a faceta é o transporte HTTP: status code, envelope, sessão/papel.
 *
 * Cobre AC-005-026 (barreira deny-by-default nas 7 rotas), AC-005-016 (faceta
 * HTTP de `sourceCitation`), AC-005-031/AC-005-037 (conteúdo removido
 * inalcançável pela superfície HTTP) e o alcance EDITOR × ADMIN pelo
 * transporte (NFR-005-001).
 */

const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

/** A app como o cliente a alcança — mesma composição real de `src/app.ts`. */
const app = createApp();

async function createUser(role: UserRole) {
  return testPrisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${randomUUID()}@example.com`,
      name: 'Usuária de fixture',
      passwordHash: 'irrelevante-para-este-teste',
      role,
    },
  });
}

/** Sessão viva do usuário `userId`; devolve o valor em claro do cookie de acesso. */
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

async function createTopicWithNames(): Promise<{
  topicId: string;
  disciplineName: string;
  topicName: string;
}> {
  const disciplineName = `Disciplina ${randomUUID()}`;
  const topicName = `Tema ${randomUUID()}`;
  const discipline = await testPrisma.discipline.create({
    data: { name: disciplineName, slug: `disciplina-${randomUUID()}` },
  });
  const topic = await testPrisma.topic.create({
    data: { disciplineId: discipline.id, name: topicName, slug: `tema-${randomUUID()}` },
  });
  return { topicId: topic.id, disciplineName, topicName };
}

interface RawContentSeed {
  authorId: string;
  topicId: string;
  rawText?: string;
  sourceCitation?: string;
  deletedAt?: Date | null;
}

async function seedRawContent(seed: RawContentSeed) {
  return testPrisma.rawContent.create({
    data: {
      authorId: seed.authorId,
      topicId: seed.topicId,
      rawText: seed.rawText ?? 'Art. 113 do CTN define a obrigação tributária.',
      radarClass: 'ALTA',
      sourceCitation: seed.sourceCitation ?? 'Art. 113, CTN',
      deletedAt: seed.deletedAt ?? null,
    },
  });
}

function validCreateBody(topicId: string): CreateRawContentInput {
  return {
    topicId,
    rawText: 'Art. 121 do CTN define o sujeito passivo.',
    radarClass: 'ALTA',
    sourceType: 'CTN',
    sourceCitation: 'Art. 121, CTN',
  };
}

function validBreakdownBody(): SaveRuleBreakdownInput {
  return {
    concept: 'Vínculo jurídico entre Fisco e contribuinte.',
    action: 'Cobrar o tributo devido.',
    object: 'A obrigação tributária.',
    essence: 'Nasce da ocorrência do fato gerador.',
    condition: undefined,
    exception: undefined,
  };
}

function withCookie(access: string): [string, string] {
  return ['Cookie', `${ACCESS_COOKIE}=${access}`];
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

describe('CRUD ponta-a-ponta (POST → GET → PATCH → DELETE) + AC-005-016 (sourceCitation na listagem)', () => {
  it('cria, lista com sourceCitation, edita e remove — cada etapa reflete a anterior', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const { topicId } = await createTopicWithNames();

    const created = await request(app)
      .post('/api/v1/contents')
      .set(...withCookie(access))
      .send(validCreateBody(topicId));

    expect(created.status).toBe(201);
    expect(created.body.authorId).toBe(editor.id);
    expect(created.body.rawText).toBe('Art. 121 do CTN define o sujeito passivo.');

    const listed = await request(app)
      .get('/api/v1/contents')
      .set(...withCookie(access));
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].sourceCitation).toBe('Art. 121, CTN');
    expect(listed.body.data[0].id).toBe(created.body.id);

    const patched = await request(app)
      .patch(`/api/v1/contents/${created.body.id}`)
      .set(...withCookie(access))
      .send({ rawText: 'Texto revisado.' });
    expect(patched.status).toBe(200);
    expect(patched.body.rawText).toBe('Texto revisado.');
    expect(patched.body.authorId).toBe(editor.id);

    const deleted = await request(app)
      .delete(`/api/v1/contents/${created.body.id}`)
      .set(...withCookie(access));
    expect(deleted.status).toBe(204);

    const afterDelete = await request(app)
      .get(`/api/v1/contents/${created.body.id}`)
      .set(...withCookie(access));
    expect(afterDelete.status).toBe(404);
  });

  it('POST /contents com corpo inválido (radarClass ausente) → 422', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const { topicId } = await createTopicWithNames();

    const res = await request(app)
      .post('/api/v1/contents')
      .set(...withCookie(access))
      .send({ topicId, rawText: 'Sem classe do radar.' });

    expect(res.status).toBe(422);
  });
});

describe('Remoção reversível — inalcançável por id direto e pela Quebra (AC-005-031, AC-005-037)', () => {
  it('conteúdo removido: GET /contents/:id → 404, GET .../breakdown → 404, some da listagem; a linha da Quebra permanece no banco (órfã)', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const { topicId } = await createTopicWithNames();
    const seeded = await seedRawContent({ authorId: editor.id, topicId });

    const savedBreakdown = await request(app)
      .put(`/api/v1/contents/${seeded.id}/breakdown`)
      .set(...withCookie(access))
      .send(validBreakdownBody());
    expect(savedBreakdown.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/v1/contents/${seeded.id}`)
      .set(...withCookie(access));
    expect(deleted.status).toBe(204);

    const detail = await request(app)
      .get(`/api/v1/contents/${seeded.id}`)
      .set(...withCookie(access));
    expect(detail.status).toBe(404);

    const breakdown = await request(app)
      .get(`/api/v1/contents/${seeded.id}/breakdown`)
      .set(...withCookie(access));
    expect(breakdown.status).toBe(404);

    const list = await request(app)
      .get('/api/v1/contents')
      .set(...withCookie(access));
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    // Oráculo manifesto (DEC-006-001): a linha em `rule_breakdowns` segue no
    // banco — inalcançável pela superfície HTTP, mas não apagada fisicamente.
    const orphanRow = await testPrisma.ruleBreakdown.findUnique({
      where: { rawContentId: seeded.id },
    });
    expect(orphanRow).not.toBeNull();
  });

  it('PUT .../breakdown sobre conteúdo removido → 404 (recusa de Quebra sobre pai removido)', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const { topicId } = await createTopicWithNames();
    const seeded = await seedRawContent({
      authorId: editor.id,
      topicId,
      deletedAt: new Date(),
    });

    const res = await request(app)
      .put(`/api/v1/contents/${seeded.id}/breakdown`)
      .set(...withCookie(access))
      .send(validBreakdownBody());

    expect(res.status).toBe(404);
  });

  it('GET/PUT .../breakdown sobre conteúdo inexistente → 404', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const missingId = randomUUID();

    const get = await request(app)
      .get(`/api/v1/contents/${missingId}/breakdown`)
      .set(...withCookie(access));
    expect(get.status).toBe(404);

    const put = await request(app)
      .put(`/api/v1/contents/${missingId}/breakdown`)
      .set(...withCookie(access))
      .send(validBreakdownBody());
    expect(put.status).toBe(404);
  });
});

describe('Upsert 1:1 da Quebra da regra (AC-005-019, AC-005-020, AC-005-024)', () => {
  it('1º PUT cria, 2º PUT atualiza a MESMA linha — GET reflete sempre o mais recente', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const { topicId } = await createTopicWithNames();
    const seeded = await seedRawContent({ authorId: editor.id, topicId });

    const beforeAny = await request(app)
      .get(`/api/v1/contents/${seeded.id}/breakdown`)
      .set(...withCookie(access));
    expect(beforeAny.status).toBe(404);

    const firstPut = await request(app)
      .put(`/api/v1/contents/${seeded.id}/breakdown`)
      .set(...withCookie(access))
      .send(validBreakdownBody());
    expect(firstPut.status).toBe(200);
    expect(firstPut.body.concept).toBe(validBreakdownBody().concept);

    const secondPut = await request(app)
      .put(`/api/v1/contents/${seeded.id}/breakdown`)
      .set(...withCookie(access))
      .send({ ...validBreakdownBody(), concept: 'Conceito revisado.' });
    expect(secondPut.status).toBe(200);
    expect(secondPut.body.concept).toBe('Conceito revisado.');

    const rows = await testPrisma.ruleBreakdown.findMany({ where: { rawContentId: seeded.id } });
    expect(rows).toHaveLength(1);

    const finalGet = await request(app)
      .get(`/api/v1/contents/${seeded.id}/breakdown`)
      .set(...withCookie(access));
    expect(finalGet.status).toBe(200);
    expect(finalGet.body.concept).toBe('Conceito revisado.');
  });
});

describe('Alcance EDITOR × ADMIN pela superfície HTTP (AC-005-026, NFR-005-001) — IDOR de leitura e escrita', () => {
  it('EDITOR A não alcança item de EDITOR B: GET/PATCH/DELETE/PUT-breakdown → 404; ADMIN alcança tudo', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const accessA = await seedSession(editorA.id);
    const accessAdmin = await seedSession(admin.id);
    const { topicId } = await createTopicWithNames();

    const ownedByB = await seedRawContent({ authorId: editorB.id, topicId });

    const getAsA = await request(app)
      .get(`/api/v1/contents/${ownedByB.id}`)
      .set(...withCookie(accessA));
    expect(getAsA.status).toBe(404);

    const patchAsA = await request(app)
      .patch(`/api/v1/contents/${ownedByB.id}`)
      .set(...withCookie(accessA))
      .send({ rawText: 'Tentativa de EDITOR A.' });
    expect(patchAsA.status).toBe(404);

    const putBreakdownAsA = await request(app)
      .put(`/api/v1/contents/${ownedByB.id}/breakdown`)
      .set(...withCookie(accessA))
      .send(validBreakdownBody());
    expect(putBreakdownAsA.status).toBe(404);
    // Nenhum byte alcança rule_breakdowns quando o ator não alcança o pai (IDOR de escrita).
    expect(
      await testPrisma.ruleBreakdown.findUnique({ where: { rawContentId: ownedByB.id } }),
    ).toBeNull();

    const deleteAsA = await request(app)
      .delete(`/api/v1/contents/${ownedByB.id}`)
      .set(...withCookie(accessA));
    expect(deleteAsA.status).toBe(404);
    expect(
      (await testPrisma.rawContent.findUniqueOrThrow({ where: { id: ownedByB.id } })).deletedAt,
    ).toBeNull();

    // ADMIN alcança o mesmo item sem restrição.
    const getAsAdmin = await request(app)
      .get(`/api/v1/contents/${ownedByB.id}`)
      .set(...withCookie(accessAdmin));
    expect(getAsAdmin.status).toBe(200);
  });

  it('GET /contents — EDITOR só vê os próprios; ADMIN vê de todos os autores', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const accessA = await seedSession(editorA.id);
    const accessAdmin = await seedSession(admin.id);
    const { topicId } = await createTopicWithNames();

    await seedRawContent({ authorId: editorA.id, topicId });
    await seedRawContent({ authorId: editorB.id, topicId });

    const listAsA = await request(app)
      .get('/api/v1/contents')
      .set(...withCookie(accessA));
    expect(listAsA.body.data).toHaveLength(1);
    expect(listAsA.body.data[0].id).toBeDefined();

    const listAsAdmin = await request(app)
      .get('/api/v1/contents')
      .set(...withCookie(accessAdmin));
    expect(listAsAdmin.body.data).toHaveLength(2);
  });
});

describe('AC-005-026 + g8 — as 7 rotas sob a barreira: sem sessão → 401; STUDENT → 403; EDITOR dono e ADMIN → 2xx', () => {
  it('GET /contents — 401 sem sessão, 403 STUDENT, 200 EDITOR, 200 ADMIN', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const student = await createUser('STUDENT');
    const [access, adminAccess, studentAccess] = await Promise.all([
      seedSession(editor.id),
      seedSession(admin.id),
      seedSession(student.id),
    ]);

    expect((await request(app).get('/api/v1/contents')).status).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/v1/contents')
          .set(...withCookie(studentAccess))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/v1/contents')
          .set(...withCookie(access))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/v1/contents')
          .set(...withCookie(adminAccess))
      ).status,
    ).toBe(200);
  });

  it('POST /contents — 401 sem sessão, 403 STUDENT, 201 EDITOR, 201 ADMIN', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const student = await createUser('STUDENT');
    const [access, adminAccess, studentAccess] = await Promise.all([
      seedSession(editor.id),
      seedSession(admin.id),
      seedSession(student.id),
    ]);
    const { topicId } = await createTopicWithNames();

    expect(
      (await request(app).post('/api/v1/contents').send(validCreateBody(topicId))).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/contents')
          .set(...withCookie(studentAccess))
          .send(validCreateBody(topicId))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/v1/contents')
          .set(...withCookie(access))
          .send(validCreateBody(topicId))
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post('/api/v1/contents')
          .set(...withCookie(adminAccess))
          .send(validCreateBody(topicId))
      ).status,
    ).toBe(201);
  });

  it('GET /contents/:id — 401 sem sessão, 403 STUDENT, 200 EDITOR dono, 200 ADMIN', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const student = await createUser('STUDENT');
    const [access, adminAccess, studentAccess] = await Promise.all([
      seedSession(editor.id),
      seedSession(admin.id),
      seedSession(student.id),
    ]);
    const { topicId } = await createTopicWithNames();
    const seeded = await seedRawContent({ authorId: editor.id, topicId });
    const url = `/api/v1/contents/${seeded.id}`;

    expect((await request(app).get(url)).status).toBe(401);
    expect(
      (
        await request(app)
          .get(url)
          .set(...withCookie(studentAccess))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(url)
          .set(...withCookie(access))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get(url)
          .set(...withCookie(adminAccess))
      ).status,
    ).toBe(200);
  });

  it('PATCH /contents/:id — 401 sem sessão, 403 STUDENT, 200 EDITOR dono, 200 ADMIN', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const student = await createUser('STUDENT');
    const [access, adminAccess, studentAccess] = await Promise.all([
      seedSession(editor.id),
      seedSession(admin.id),
      seedSession(student.id),
    ]);
    const { topicId } = await createTopicWithNames();
    const seeded = await seedRawContent({ authorId: editor.id, topicId });
    const url = `/api/v1/contents/${seeded.id}`;
    const body = { rawText: 'Atualização da matriz de authz.' };

    expect((await request(app).patch(url).send(body)).status).toBe(401);
    expect(
      (
        await request(app)
          .patch(url)
          .set(...withCookie(studentAccess))
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(url)
          .set(...withCookie(access))
          .send(body)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch(url)
          .set(...withCookie(adminAccess))
          .send(body)
      ).status,
    ).toBe(200);
  });

  it('DELETE /contents/:id — 401 sem sessão, 403 STUDENT, 204 EDITOR dono e 204 ADMIN (itens distintos — remoção não é idempotente)', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const student = await createUser('STUDENT');
    const [access, adminAccess, studentAccess] = await Promise.all([
      seedSession(editor.id),
      seedSession(admin.id),
      seedSession(student.id),
    ]);
    const { topicId } = await createTopicWithNames();
    const forAnon = await seedRawContent({ authorId: editor.id, topicId });
    const forStudent = await seedRawContent({ authorId: editor.id, topicId });
    const forEditor = await seedRawContent({ authorId: editor.id, topicId });
    const forAdmin = await seedRawContent({ authorId: editor.id, topicId });

    expect((await request(app).delete(`/api/v1/contents/${forAnon.id}`)).status).toBe(401);
    expect(
      (
        await request(app)
          .delete(`/api/v1/contents/${forStudent.id}`)
          .set(...withCookie(studentAccess))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .delete(`/api/v1/contents/${forEditor.id}`)
          .set(...withCookie(access))
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .delete(`/api/v1/contents/${forAdmin.id}`)
          .set(...withCookie(adminAccess))
      ).status,
    ).toBe(204);
  });

  it('GET /contents/:id/breakdown — 401 sem sessão, 403 STUDENT, 200 EDITOR dono, 200 ADMIN', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const student = await createUser('STUDENT');
    const [access, adminAccess, studentAccess] = await Promise.all([
      seedSession(editor.id),
      seedSession(admin.id),
      seedSession(student.id),
    ]);
    const { topicId } = await createTopicWithNames();
    const seeded = await seedRawContent({ authorId: editor.id, topicId });
    await request(app)
      .put(`/api/v1/contents/${seeded.id}/breakdown`)
      .set(...withCookie(access))
      .send(validBreakdownBody());
    const url = `/api/v1/contents/${seeded.id}/breakdown`;

    expect((await request(app).get(url)).status).toBe(401);
    expect(
      (
        await request(app)
          .get(url)
          .set(...withCookie(studentAccess))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(url)
          .set(...withCookie(access))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get(url)
          .set(...withCookie(adminAccess))
      ).status,
    ).toBe(200);
  });

  it('PUT /contents/:id/breakdown — 401 sem sessão, 403 STUDENT, 200 EDITOR dono, 200 ADMIN', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const student = await createUser('STUDENT');
    const [access, adminAccess, studentAccess] = await Promise.all([
      seedSession(editor.id),
      seedSession(admin.id),
      seedSession(student.id),
    ]);
    const { topicId } = await createTopicWithNames();
    const seeded = await seedRawContent({ authorId: editor.id, topicId });
    const url = `/api/v1/contents/${seeded.id}/breakdown`;
    const body = validBreakdownBody();

    expect((await request(app).put(url).send(body)).status).toBe(401);
    expect(
      (
        await request(app)
          .put(url)
          .set(...withCookie(studentAccess))
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .put(url)
          .set(...withCookie(access))
          .send(body)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .put(url)
          .set(...withCookie(adminAccess))
          .send(body)
      ).status,
    ).toBe(200);
  });
});
