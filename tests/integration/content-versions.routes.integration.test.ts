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
 * Conjunto exato de chaves de `ContentVersionDetail`
 * (`content-versions.service.ts`) — prova de FORMA do corpo de sucesso HTTP
 * (gate 8, lição "select exposto que lê campo interno prova as chaves do
 * payload"): o `select` interno de `listContentVersions` lê `contentSnapshot`
 * (dado interno, DEC-029-003) ao lado dos campos públicos — só o mapeamento
 * campo a campo garante que ele nunca sai no payload.
 */
const CONTENT_VERSION_DETAIL_KEYS = [
  'id',
  'rawContentId',
  'number',
  'legislativeClosureDate',
  'authorId',
  'closedAt',
  'approvedById',
  'approvedAt',
  'validApprovalForExport',
].sort();

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

const EVIL_ORIGIN = 'https://evil.example';

/**
 * `POST /contents/:id/versions/:number/approve` (COMP-033-006 / TASK-033-003)
 * ponta-a-ponta: guarda composta e idempotência já provadas no NÍVEL DE
 * SERVICE em `content-versions.service.integration.test.ts`; aqui a mesma
 * garantia é provada na CAMADA HTTP (`verifyOrigin` + `requireRole` + fail-secure).
 * A topologia adversarial (papel declarado, EDITOR/sem sessão recusados) vive
 * em `route-authz-matrix.integration.test.ts` — não duplicada aqui.
 */
describe('POST /contents/:id/versions/:number/approve — camada HTTP', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function seedClosedVersion(): Promise<{
    rawContentId: string;
    number: number;
    editorAccess: string;
    adminAccess: string;
    adminId: string;
  }> {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const editorAccess = await seedSession(editor.id);
    const adminAccess = await seedSession(admin.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { sourceType: 'LEI', sourceCitation: 'Lei 5.172/1966' },
    });

    const closeRes = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/versions`)
      .set(...withCookie(editorAccess))
      .send({ legislativeClosureDate: '2026-09-01' });

    return {
      rawContentId: rawContent.id,
      number: closeRes.body.number,
      editorAccess,
      adminAccess,
      adminId: admin.id,
    };
  }

  it('fluxo feliz ponta a ponta: 200, corpo com approvedById/approvedAt preenchidos', async () => {
    const { rawContentId, number, adminAccess, adminId } = await seedClosedVersion();

    const res = await request(app)
      .post(`/api/v1/contents/${rawContentId}/versions/${number}/approve`)
      .set(...withCookie(adminAccess))
      .send({ legalCheckConfirmed: true, pedagogicalCheckConfirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.approvedById).toBe(adminId);
    expect(res.body.approvedAt).not.toBeNull();
  });

  it('verifyOrigin recusa origem forjada (Origin fora da allowlist) → 403, mesmo padrão já provado para as rotas irmãs', async () => {
    const { rawContentId, number, adminAccess } = await seedClosedVersion();

    const res = await request(app)
      .post(`/api/v1/contents/${rawContentId}/versions/${number}/approve`)
      .set(...withCookie(adminAccess))
      .set('Origin', EVIL_ORIGIN)
      .send({ legalCheckConfirmed: true, pedagogicalCheckConfirmed: true });

    expect(res.status).toBe(403);
  });

  it('NFR-032-001/002 fail-secure na camada HTTP: recordProductionStageEvent rejeitando → 500 genérico, approvedById permanece null (rollback completo)', async () => {
    const { rawContentId, number, adminAccess } = await seedClosedVersion();

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    const res = await request(app)
      .post(`/api/v1/contents/${rawContentId}/versions/${number}/approve`)
      .set(...withCookie(adminAccess))
      .send({ legalCheckConfirmed: true, pedagogicalCheckConfirmed: true });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Erro interno.' },
    });

    const row = await testPrisma.contentVersion.findFirstOrThrow({
      where: { rawContentId, number },
    });
    expect(row.approvedById).toBeNull();
  });
});

describe('GET /contents/:id/versions — camada HTTP: forma exata do payload (gate 8)', () => {
  it('cada entrada do histórico (vigente e superada) devolve exatamente as 9 chaves de ContentVersionDetail', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const editorAccess = await seedSession(editor.id);
    const adminAccess = await seedSession(admin.id);
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { sourceType: 'LEI', sourceCitation: 'Lei 5.172/1966' },
    });

    const firstClose = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/versions`)
      .set(...withCookie(editorAccess))
      .send({ legislativeClosureDate: '2026-08-01' });

    const approveRes = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/versions/${firstClose.body.number}/approve`)
      .set(...withCookie(adminAccess))
      .send({ legalCheckConfirmed: true, pedagogicalCheckConfirmed: true });

    expect(approveRes.status).toBe(200);

    await request(app)
      .post(`/api/v1/contents/${rawContent.id}/versions`)
      .set(...withCookie(editorAccess))
      .send({ legislativeClosureDate: '2026-09-01' });

    const listed = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/versions`)
      .set(...withCookie(editorAccess));

    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(2);
    for (const entry of listed.body) {
      expect(Object.keys(entry).sort()).toEqual(CONTENT_VERSION_DETAIL_KEYS);
    }
  });
});
