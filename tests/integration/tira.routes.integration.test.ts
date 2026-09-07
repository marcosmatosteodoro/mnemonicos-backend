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
 * `tira.routes.ts` (TASK-012-008) ponta-a-ponta sobre a `app` **real**
 * (`createApp()`, sem popular `ROUTE_ROLES` à mão) e o Postgres real (harness
 * de TASK-003-016). A rota **só expõe** a regra de negócio já provada em
 * `tira.service.integration.test.ts` (TASK-012-005/006/007) — aqui a faceta é
 * o transporte HTTP: AC-011-022 (parte, faceta de transporte do 404 de
 * alcance), AC-011-023 (parte, faceta HTTP do 409 de "Quebra da regra ainda
 * não salva"), o confused deputy do `:frameId` (achado do security-engineer,
 * gate 8 da Wave 1 — pendência herdada, decisão 4.140) e a EMENDA Wave
 * 5/DEC-012-011 (CSRF): `GET /contents/:id/strip` é leitura pura, a geração
 * migrou para `POST /contents/:id/strip`.
 *
 * A topologia adversarial das 6 rotas (papéis declarados, STUDENT recusado,
 * chaves independentes) vive em `route-authz-matrix.integration.test.ts`
 * (bloco `TASK-012-008`) — não duplicada aqui.
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
  // A rota usa o client de produção (`src/lib/prisma.ts`), que durante a
  // integração aponta para o banco descartável.
  await prisma.$disconnect();
});

describe('AC-011-022 (parte — faceta de transporte do ator): alcance por autoria', () => {
  it('GET /contents/:id/strip sobre rawContentId de outro EDITOR → 404 "Conteúdo bruto não encontrado." (igualdade literal, não só status)', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const accessB = await seedSession(editorB.id);

    const res = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/strip`)
      .set(...withCookie(accessB));

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Conteúdo bruto não encontrado.');
  });

  it('POST /contents/:id/strip (geração) sobre rawContentId de outro EDITOR → 404 "Conteúdo bruto não encontrado." (mesma faceta, agora na mutação)', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const accessB = await seedSession(editorB.id);

    const res = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/strip`)
      .set(...withCookie(accessB));

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Conteúdo bruto não encontrado.');
  });
});

describe('AC-011-023 (parte — faceta HTTP do 409): Quebra da regra ainda não salva', () => {
  it('GET /contents/:id/strip sobre rawContentId alcançável mas sem Quebra salva → 409, error.code === CONFLICT (mapeamento automático de ConflictError pelo errorHandler)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const access = await seedSession(editor.id);

    const res = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/strip`)
      .set(...withCookie(access));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('POST /contents/:id/strip sobre rawContentId alcançável mas sem Quebra salva → 409, error.code === CONFLICT (a guarda de 409 é comum à leitura e à geração)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const access = await seedSession(editor.id);

    const res = await request(app)
      .post(`/api/v1/contents/${rawContent.id}/strip`)
      .set(...withCookie(access));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('CSRF/DEC-012-011 (achado do security-engineer, gate 8) — GET /contents/:id/strip é leitura pura, nunca gera', () => {
  it('GET sobre uma Tira AINDA NÃO aberta (Quebra da regra salva, Strip inexistente) → 404; nenhuma MnemonicStrip/MnemonicFrame/evento de produção é criado, nem mesmo chamando duas vezes seguidas', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const access = await seedSession(editor.id);

    const first = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/strip`)
      .set(...withCookie(access));
    expect(first.status).toBe(404);

    const second = await request(app)
      .get(`/api/v1/contents/${rawContent.id}/strip`)
      .set(...withCookie(access));
    expect(second.status).toBe(404);

    const stripCount = await testPrisma.mnemonicStrip.count();
    expect(stripCount).toBe(0);
    const frameCount = await testPrisma.mnemonicFrame.count();
    expect(frameCount).toBe(0);
    const eventCount = await testPrisma.productionStageEvent.count({
      where: { rawContentId: rawContent.id, stageType: 'TIRA_MNEMONICA' },
    });
    expect(eventCount).toBe(0);
  });
});

describe('Confused deputy no :frameId, faceta HTTP (achado do security-engineer, gate 8 da Wave 1 — pendência herdada, decisão 4.140)', () => {
  it('rejeita :frameId fora da cadeia do :id da URL, mesmo autor', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentA = await createRawContent(editor.id, topicId);
    const rawContentB = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentA.id);
    await seedRuleBreakdown(rawContentB.id);
    const access = await seedSession(editor.id);

    const stripA = await request(app)
      .post(`/api/v1/contents/${rawContentA.id}/strip`)
      .set(...withCookie(access));
    expect(stripA.status).toBe(200);
    const frameIdFromA: string = stripA.body.frames[0].id;

    // Tira B precisa existir (mesma cadeia rawContentB → stripId próprio) para
    // `findStripId` resolver ANTES da guarda de pertencimento — sem isso a
    // recusa viria de "Tira ainda não aberta" (409), não do confused deputy.
    const stripB = await request(app)
      .post(`/api/v1/contents/${rawContentB.id}/strip`)
      .set(...withCookie(access));
    expect(stripB.status).toBe(200);

    const patchRes = await request(app)
      .patch(`/api/v1/contents/${rawContentB.id}/strip/frames/${frameIdFromA}`)
      .set(...withCookie(access))
      .send({ text: 'Tentativa de confused deputy.' });
    expect(patchRes.status).toBe(404);
    expect(patchRes.body.error.message).toBe('Quadro não encontrado.');

    const deleteRes = await request(app)
      .delete(`/api/v1/contents/${rawContentB.id}/strip/frames/${frameIdFromA}`)
      .set(...withCookie(access));
    expect(deleteRes.status).toBe(404);
    expect(deleteRes.body.error.message).toBe('Quadro não encontrado.');

    // Prova negativa: o Quadro de A continua intacto — nenhuma escrita
    // atravessou a guarda de pertencimento.
    const untouched = await testPrisma.mnemonicFrame.findUnique({ where: { id: frameIdFromA } });
    expect(untouched).not.toBeNull();
    expect(untouched?.text).not.toBe('Tentativa de confused deputy.');
  });
});
