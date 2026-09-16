import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `flashcards.routes.ts` (COMP-027-012 / TASK-027-004) ponta-a-ponta sobre a
 * `app` real (`createApp()`, sem popular `ROUTE_ROLES` à mão) e o Postgres
 * real — mesmo molde de `contrasts.routes.integration.test.ts`. A regra de
 * negócio (guarda composta, fail-secure) já está provada em
 * `flashcards.service.integration.test.ts`; aqui a faceta é o transporte
 * HTTP: STUDENT/sem-sessão (AC-026-015, NFR-026-001), validação Zod de campo
 * vazio (AC-026-016, NFR-026-002).
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

describe('CRUD completo via HTTP (faceta de transporte de AC-026-008/010)', () => {
  it('POST cria (201), GET lista (200, o item criado), PATCH edita (200), DELETE remove (204)', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const created = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/flashcards`)
      .set(...withCookie(access))
      .send({ question: 'Pergunta.', answer: 'Resposta.' });
    expect(created.status).toBe(201);
    expect(created.body.authorId).toBe(editor.id);

    const listed = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/flashcards`)
      .set(...withCookie(access));
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(created.body.id);

    const patched = await request(app)
      .patch(`/api/v1/contents/${rawContent.id}/flashcards/${created.body.id}`)
      .set(...withCookie(access))
      .send({ question: 'Pergunta revisada.', answer: 'Resposta revisada.' });
    expect(patched.status).toBe(200);
    expect(patched.body.question).toBe('Pergunta revisada.');

    const deleted = await request(app)
      .delete(`/api/v1/contents/${rawContent.id}/flashcards/${created.body.id}`)
      .set(...withCookie(access));
    expect(deleted.status).toBe(204);

    const listedAfterDelete = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/flashcards`)
      .set(...withCookie(access));
    expect(listedAfterDelete.body).toEqual([]);
  });
});

describe('AC-026-015 (parte — rotas de Flashcard negam STUDENT) e NFR-026-001', () => {
  it('sessão STUDENT → 403 nas 4 rotas', async () => {
    const student = await createUser('STUDENT');
    const access = await seedSession(student.id);
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const flashcard = await testPrisma.productionFlashcard.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        question: 'Pergunta.',
        answer: 'Resposta.',
      },
    });

    const post = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/flashcards`)
      .set(...withCookie(access))
      .send({ question: 'x', answer: 'y' });
    expect(post.status).toBe(403);

    const get = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/flashcards`)
      .set(...withCookie(access));
    expect(get.status).toBe(403);

    const patch = await request(app)
      .patch(`/api/v1/contents/${rawContent.id}/flashcards/${flashcard.id}`)
      .set(...withCookie(access))
      .send({ question: 'x', answer: 'y' });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/v1/contents/${rawContent.id}/flashcards/${flashcard.id}`)
      .set(...withCookie(access));
    expect(del.status).toBe(403);
  });

  it('sem sessão → 401 nas 4 rotas', async () => {
    const rawContentId = randomUUID();
    const flashcardId = randomUUID();

    const post = await request(app)
      .post(`/api/v1/contents/${rawContentId}/flashcards`)
      .send({ question: 'x', answer: 'y' });
    expect(post.status).toBe(401);

    const get = await request(app).get(`/api/v1/contents/${rawContentId}/flashcards`);
    expect(get.status).toBe(401);

    const patch = await request(app)
      .patch(`/api/v1/contents/${rawContentId}/flashcards/${flashcardId}`)
      .send({ question: 'x', answer: 'y' });
    expect(patch.status).toBe(401);

    const del = await request(app).delete(
      `/api/v1/contents/${rawContentId}/flashcards/${flashcardId}`,
    );
    expect(del.status).toBe(401);
  });
});

describe('AC-026-016 (parte — campo vazio de Flashcard recusado) e NFR-026-002', () => {
  it('POST com question/answer vazio (3 casos) → 422, motivo informado, nenhuma linha criada', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const cases = [
      {
        body: { question: '', answer: 'Resposta válida.' },
        expectedPaths: ['question'],
      },
      {
        body: { question: 'Pergunta válida.', answer: '' },
        expectedPaths: ['answer'],
      },
      {
        body: { question: '', answer: '' },
        expectedPaths: ['question', 'answer'],
      },
    ];

    for (const { body, expectedPaths } of cases) {
      const countBefore = await testPrisma.productionFlashcard.count({
        where: { rawContentId: rawContent.id },
      });

      const res = await request(app)
        .post(`/api/v1/contents/${rawContent.id}/flashcards`)
        .set(...withCookie(access))
        .send(body);
      expect(res.status).toBe(422);
      const reportedPaths = (res.body.error.details as Array<{ path: string }>).map(
        (detail) => detail.path,
      );
      expect(reportedPaths).toEqual(expect.arrayContaining(expectedPaths));

      const countAfter = await testPrisma.productionFlashcard.count({
        where: { rawContentId: rawContent.id },
      });
      expect(countAfter).toBe(countBefore);
    }
  });

  it('PATCH com question/answer vazio (3 casos) → 422, motivo informado, o registro permanece intocado', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const flashcard = await testPrisma.productionFlashcard.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        question: 'Pergunta original.',
        answer: 'Resposta original.',
      },
    });

    const cases = [
      {
        body: { question: '', answer: 'Resposta válida.' },
        expectedPaths: ['question'],
      },
      {
        body: { question: 'Pergunta válida.', answer: '' },
        expectedPaths: ['answer'],
      },
      {
        body: { question: '', answer: '' },
        expectedPaths: ['question', 'answer'],
      },
    ];

    for (const { body, expectedPaths } of cases) {
      const res = await request(app)
        .patch(`/api/v1/contents/${rawContent.id}/flashcards/${flashcard.id}`)
        .set(...withCookie(access))
        .send(body);
      expect(res.status).toBe(422);
      const reportedPaths = (res.body.error.details as Array<{ path: string }>).map(
        (detail) => detail.path,
      );
      expect(reportedPaths).toEqual(expect.arrayContaining(expectedPaths));
    }

    const untouched = await testPrisma.productionFlashcard.findUniqueOrThrow({
      where: { id: flashcard.id },
    });
    expect(untouched.question).toBe('Pergunta original.');
    expect(untouched.answer).toBe('Resposta original.');
  });
});

describe('AC-026-023 (parte — Flashcard): erro não previsto na emissão do evento devolve 500 genérico', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POST com recordProductionStageEvent rejeitando → 500 genérico, sem detalhe da exceção', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    const res = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/flashcards`)
      .set(...withCookie(access))
      .send({ question: 'Pergunta.', answer: 'Resposta.' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Erro interno.' },
    });
  });

  it('PATCH com recordProductionStageEvent rejeitando → 500 genérico, sem detalhe da exceção', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const flashcard = await testPrisma.productionFlashcard.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        question: 'Pergunta original.',
        answer: 'Resposta original.',
      },
    });

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    const res = await request(app)
      .patch(`/api/v1/contents/${rawContent.id}/flashcards/${flashcard.id}`)
      .set(...withCookie(access))
      .send({
        question: 'Nunca deveria persistir.',
        answer: 'Nunca deveria persistir.',
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Erro interno.' },
    });
  });

  it('DELETE com recordProductionStageEvent rejeitando → 500 genérico, sem detalhe da exceção', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const flashcard = await testPrisma.productionFlashcard.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        question: 'Pergunta original.',
        answer: 'Resposta original.',
      },
    });

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    const res = await request(app)
      .delete(`/api/v1/contents/${rawContent.id}/flashcards/${flashcard.id}`)
      .set(...withCookie(access));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Erro interno.' },
    });
  });
});
