import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import {
  createRawContent,
  createTopic,
  createUser,
  seedRuleBreakdown,
} from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `content-versions.routes.ts` (COMP-029-006 / TASK-029-002) ponta-a-ponta
 * sobre a `app` real (`createApp()`) e o Postgres real — molde
 * `contrasts.routes.integration.test.ts:255`. A guarda composta e o
 * fail-secure já estão provados no NÍVEL DE SERVICE em
 * `content-versions.service.integration.test.ts` (chamando
 * `closeContentVersion` direto); este arquivo prova a MESMA garantia na
 * CAMADA HTTP (`POST /api/v1/contents/:id/versions`), nunca provada só por
 * chamar o service direto.
 *
 * A topologia adversarial das 2 rotas (papéis declarados, STUDENT recusado)
 * vive em `route-authz-matrix.integration.test.ts` — não duplicada aqui.
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

describe('NFR-028-001/002 (fail-secure, camada HTTP): erro não previsto na emissão do evento devolve 500 genérico', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POST /contents/:id/versions com recordProductionStageEvent rejeitando → 500 genérico, sem detalhe da exceção, e nenhuma ContentVersion criada', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    const countBefore = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContent.id },
    });

    const res = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/versions`)
      .set(...withCookie(access))
      .send({ legislativeClosureDate: '2026-09-01' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Erro interno.' },
    });

    // Transação revertida por inteiro (NFR-028-001/002) — nenhuma
    // ContentVersion criada apesar do INSERT do passo 7 já ter rodado antes
    // da rejeição do passo 8 (recordProductionStageEvent).
    const countAfter = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContent.id },
    });
    expect(countAfter).toBe(countBefore);
  });
});
