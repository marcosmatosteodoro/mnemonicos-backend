import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import {
  createRawContent,
  createTopic,
  createUser,
  seedRuleBreakdown,
} from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `publication.routes.ts` (TASK-025-009) ponta-a-ponta sobre a `app` **real**
 * (`createApp()`, sem popular `ROUTE_ROLES` à mão) e o Postgres real (harness de
 * TASK-003-016). A orquestração em si (`exportPublication`) já está provada em
 * `publication.service.integration.test.ts` (TASK-025-008) — aqui a faceta é o
 * transporte HTTP: AC-024-007 (nome do arquivo baixado indica rascunho + Variante) e
 * AC-024-009/NFR-024-003 (deny-by-default: STUDENT e sessão ausente recusados). A
 * topologia geral (401 sem sessão, `verifyOrigin` como 1º handler, chave exata em
 * `ROUTE_ROLES`) vive em `route-authz-matrix.integration.test.ts` — não duplicada
 * aqui.
 */

const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

/** A app como o cliente a alcança — mesma composição real de `src/app.ts`. */
const app = createApp();

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

function withCookie(access: string): [string, string] {
  return ['Cookie', `${ACCESS_COOKIE}=${access}`];
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
  // A rota usa o client de produção (`src/lib/prisma.ts`), que durante a integração
  // aponta para o banco descartável.
  await prisma.$disconnect();
});

describe('AC-024-007 — filename do PDF baixado indica rascunho + Variante', () => {
  it('Variante RESUMO: Content-Disposition casa attachment; filename="<id>-resumo-rascunho.pdf"', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const access = await seedSession(editor.id);

    const res = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/publication`)
      .set(...withCookie(access))
      .send({ variant: 'RESUMO' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${rawContent.id}-resumo-rascunho.pdf"`,
    );
  });

  it('Variante TIRA (mesmo Conteúdo bruto): Content-Disposition casa attachment; filename="<id>-tira-rascunho.pdf"', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const access = await seedSession(editor.id);

    const res = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/publication`)
      .set(...withCookie(access))
      .send({ variant: 'TIRA' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${rawContent.id}-tira-rascunho.pdf"`,
    );
  });
});

describe('AC-024-009 / NFR-024-003 — STUDENT ou sem sessão recusados', () => {
  it('POST /contents/:id/publication sem cookie de sessão → 401', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    const res = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/publication`)
      .send({ variant: 'RESUMO' });

    expect(res.status).toBe(401);
  });

  it('POST /contents/:id/publication com sessão de papel STUDENT → 403', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const student = await createUser('STUDENT');
    const access = await seedSession(student.id);

    const res = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/publication`)
      .set(...withCookie(access))
      .send({ variant: 'RESUMO' });

    expect(res.status).toBe(403);
  });
});
