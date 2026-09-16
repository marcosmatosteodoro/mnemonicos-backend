import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `contrasts.routes.ts` (COMP-027-003 / TASK-027-003) ponta-a-ponta sobre a
 * `app` real (`createApp()`, sem popular `ROUTE_ROLES` à mão) e o Postgres
 * real — mesmo molde de `tira.routes.integration.test.ts`. A regra de
 * negócio (guarda composta, fail-secure) já está provada em
 * `contrasts.service.integration.test.ts`; aqui a faceta é o transporte HTTP:
 * STUDENT/sem-sessão (AC-026-015, NFR-026-001), validação Zod de campo vazio
 * (AC-026-016, NFR-026-002).
 *
 * A topologia adversarial das 4 rotas (papéis declarados, STUDENT recusado,
 * chaves independentes, contagem de pares) vive em
 * `route-authz-matrix.integration.test.ts` — não duplicada aqui.
 */

const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

const app = createApp();

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

function withCookie(access: string): [string, string] {
  return ['Cookie', `${ACCESS_COOKIE}=${access}`];
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
  await prisma.$disconnect();
});

describe('CRUD completo via HTTP (faceta de transporte de AC-026-001/004)', () => {
  it('POST cria (201), GET lista (200, o item criado), PATCH edita (200), DELETE remove (204)', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const created = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/contrasts`)
      .set(...withCookie(access))
      .send({ confusableText: 'Decadência.', distinctionText: 'Prescrição.' });
    expect(created.status).toBe(201);
    expect(created.body.authorId).toBe(editor.id);

    const listed = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/contrasts`)
      .set(...withCookie(access));
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(created.body.id);

    const patched = await request(app)
      .patch(`/api/v1/contents/${rawContent.id}/contrasts/${created.body.id}`)
      .set(...withCookie(access))
      .send({ confusableText: 'Decadência revisada.', distinctionText: 'Prescrição revisada.' });
    expect(patched.status).toBe(200);
    expect(patched.body.confusableText).toBe('Decadência revisada.');

    const deleted = await request(app)
      .delete(`/api/v1/contents/${rawContent.id}/contrasts/${created.body.id}`)
      .set(...withCookie(access));
    expect(deleted.status).toBe(204);

    const listedAfterDelete = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/contrasts`)
      .set(...withCookie(access));
    expect(listedAfterDelete.body).toEqual([]);
  });
});

describe('AC-026-015 (parte — rotas de Contraste negam STUDENT) e NFR-026-001', () => {
  it('sessão STUDENT → 403 nas 4 rotas', async () => {
    const student = await createUser('STUDENT');
    const access = await seedSession(student.id);
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const contrast = await testPrisma.contrast.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        confusableText: 'Confundível.',
        distinctionText: 'Distinção.',
      },
    });

    const post = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/contrasts`)
      .set(...withCookie(access))
      .send({ confusableText: 'x', distinctionText: 'y' });
    expect(post.status).toBe(403);

    const get = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/contrasts`)
      .set(...withCookie(access));
    expect(get.status).toBe(403);

    const patch = await request(app)
      .patch(`/api/v1/contents/${rawContent.id}/contrasts/${contrast.id}`)
      .set(...withCookie(access))
      .send({ confusableText: 'x', distinctionText: 'y' });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/v1/contents/${rawContent.id}/contrasts/${contrast.id}`)
      .set(...withCookie(access));
    expect(del.status).toBe(403);
  });

  it('sem sessão → 401 nas 4 rotas', async () => {
    const rawContentId = randomUUID();
    const contrastId = randomUUID();

    const post = await request(app)
      .post(`/api/v1/contents/${rawContentId}/contrasts`)
      .send({ confusableText: 'x', distinctionText: 'y' });
    expect(post.status).toBe(401);

    const get = await request(app).get(`/api/v1/contents/${rawContentId}/contrasts`);
    expect(get.status).toBe(401);

    const patch = await request(app)
      .patch(`/api/v1/contents/${rawContentId}/contrasts/${contrastId}`)
      .send({ confusableText: 'x', distinctionText: 'y' });
    expect(patch.status).toBe(401);

    const del = await request(app).delete(
      `/api/v1/contents/${rawContentId}/contrasts/${contrastId}`,
    );
    expect(del.status).toBe(401);
  });
});

describe('AC-026-016 (parte — campo vazio de Contraste recusado) e NFR-026-002', () => {
  it('POST com confusableText/distinctionText vazio (3 casos) → 422, nenhuma linha criada', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const cases = [
      { confusableText: '', distinctionText: 'Distinção válida.' },
      { confusableText: 'Confundível válido.', distinctionText: '' },
      { confusableText: '', distinctionText: '' },
    ];

    for (const body of cases) {
      const countBefore = await testPrisma.contrast.count({
        where: { rawContentId: rawContent.id },
      });

      const res = await request(app)
        .post(`/api/v1/contents/${rawContent.id}/contrasts`)
        .set(...withCookie(access))
        .send(body);
      expect(res.status).toBe(422);

      const countAfter = await testPrisma.contrast.count({
        where: { rawContentId: rawContent.id },
      });
      expect(countAfter).toBe(countBefore);
    }
  });

  it('PATCH com confusableText/distinctionText vazio (3 casos) → 422, o registro permanece intocado', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const contrast = await testPrisma.contrast.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        confusableText: 'Confundível original.',
        distinctionText: 'Distinção original.',
      },
    });

    const cases = [
      { confusableText: '', distinctionText: 'Distinção válida.' },
      { confusableText: 'Confundível válido.', distinctionText: '' },
      { confusableText: '', distinctionText: '' },
    ];

    for (const body of cases) {
      const res = await request(app)
        .patch(`/api/v1/contents/${rawContent.id}/contrasts/${contrast.id}`)
        .set(...withCookie(access))
        .send(body);
      expect(res.status).toBe(422);
    }

    const untouched = await testPrisma.contrast.findUniqueOrThrow({ where: { id: contrast.id } });
    expect(untouched.confusableText).toBe('Confundível original.');
    expect(untouched.distinctionText).toBe('Distinção original.');
  });
});
