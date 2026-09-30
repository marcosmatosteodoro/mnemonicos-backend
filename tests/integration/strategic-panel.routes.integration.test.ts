import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { ACCESS_COOKIE } from '../../src/http/cookies';
import { prisma } from '../../src/lib/prisma';
import { generateToken, hashToken } from '../../src/lib/tokens';
import {
  approveContentVersion,
  closeContentVersion,
} from '../../src/modules/content-versions/content-versions.service';
import {
  createRawContent,
  saveRuleBreakdown,
  type ContentActor,
} from '../../src/modules/contents/contents.service';
import { exportPublication } from '../../src/modules/publication/publication.service';
import { seedApprovableRawContent } from '../support/approvable-raw-content-fixtures';
import {
  BREAKDOWN_FIELDS,
  createTopic,
  createUser,
  RAW_CONTENT_TEXT_FIELDS,
} from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `GET /strategic-panel` (COMP-035-016, TASK-035-006) ponta-a-ponta sobre a
 * `app` real e o Postgres real — molde `content-versions.routes.integration.test.ts`.
 * A topologia adversarial de papel (401/403 genéricos) vive em
 * `route-authz-matrix.integration.test.ts`; este arquivo prova o par
 * específico desta rota (AC-034-012) e, sobretudo, a FORMA exata do payload
 * (AC-034-013/NFR-034-003/004) — `Object.keys` EXATAS contra a allowlist
 * declarada, checagem recursiva (não só o nível raiz).
 */

const ACCESS_TTL_MS = env.AUTH_ACCESS_TTL_MINUTES * 60_000;
const REFRESH_TTL_MS = env.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

const app = createApp();

const APPROVE_INPUT = { legalCheckConfirmed: true, pedagogicalCheckConfirmed: true } as const;

function actorOf(user: { id: string; role: 'EDITOR' | 'ADMIN' }): ContentActor {
  return { id: user.id, role: user.role };
}

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

describe('AC-034-012 (FR-034-015/016) — GET /strategic-panel restrito a EDITOR/ADMIN', () => {
  it('sem sessão → 401', async () => {
    const res = await request(app).get('/api/v1/strategic-panel');
    expect(res.status).toBe(401);
  });

  it('STUDENT autenticado → 403, sem nenhum dado do Painel no corpo', async () => {
    const student = await createUser('STUDENT');
    const access = await seedSession(student.id);

    const res = await request(app)
      .get('/api/v1/strategic-panel')
      .set(...withCookie(access));

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('contents');
    expect(res.body).not.toHaveProperty('factory');
    expect(res.body).not.toHaveProperty('modules');
    expect(res.body).not.toHaveProperty('rework');
    expect(res.body).not.toHaveProperty('backlog');
  });

  it('EDITOR autenticado → 200', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);

    const res = await request(app)
      .get('/api/v1/strategic-panel')
      .set(...withCookie(access));

    expect(res.status).toBe(200);
  });

  it('ADMIN autenticado → 200', async () => {
    const admin = await createUser('ADMIN');
    const access = await seedSession(admin.id);

    const res = await request(app)
      .get('/api/v1/strategic-panel')
      .set(...withCookie(access));

    expect(res.status).toBe(200);
  });
});

/** Conjunto exato de chaves da resposta HTTP (`toStrategicPanelResponse`) — prova de FORMA. */
const STRATEGIC_PANEL_RESPONSE_KEYS = [
  'contents',
  'factory',
  'modules',
  'rework',
  'backlog',
].sort();
const TIME_PER_PAGE_MEDIDO_KEYS = ['status', 'average', 'median', 'n', 'activeTotal'].sort();
const TIME_PER_PAGE_SEM_MEDIDA_KEYS = ['status', 'n', 'activeTotal'].sort();
const MODULE_KEYS = ['disciplineName', 'topicName', 'timePerPage', 'completion'].sort();
const COMPLETION_KEYS = ['active', 'concluded'].sort();
const REWORK_KEYS = ['byStage', 'contentsWithCorrection'].sort();
const BACKLOG_ITEM_KEYS = [
  'contentId',
  'disciplineName',
  'topicName',
  'mostAdvancedStage',
  'priority',
  'ageMs',
  'approvedButAltered',
].sort();
/** Allowlist por Conteúdo em `contents[]`. */
const CONTENT_ITEM_KEYS = [
  'contentId',
  'disciplineName',
  'topicName',
  'totalTime',
  'timePerPage',
  'perStage',
  'reworkCountByStage',
  'concluded',
  'approvedButAltered',
  'mostAdvancedStage',
  'priority',
  'ageMs',
].sort();
const PER_STAGE_KEYS = [
  'CONTEUDO_BRUTO',
  'QUEBRA_DA_REGRA',
  'TIRA_MNEMONICA',
  'ASSOCIACAO_VISUAL',
  'PUBLICACAO_PDF',
  'MATERIAL_REFORCO',
  'VERSAO_EDITORIAL',
  'APROVACAO_VERSAO',
].sort();
const TOTAL_TIME_MEDIDO_KEYS = ['ms', 'pageCount'].sort();
const TOTAL_TIME_UNMEASURED_KEYS = ['reason'].sort();
const STAGE_PERIOD_MEDIDO_KEYS = ['status', 'ms', 'msPerPage'].sort();
const STAGE_PERIOD_OTHER_KEYS = ['status'].sort();

function expectTimePerPageShape(value: unknown): void {
  expect(value).not.toBeNull();
  const timePerPage = value as { status: string };
  const expectedKeys =
    timePerPage.status === 'medido' ? TIME_PER_PAGE_MEDIDO_KEYS : TIME_PER_PAGE_SEM_MEDIDA_KEYS;
  expect(Object.keys(timePerPage).sort()).toEqual(expectedKeys);
}

/** `totalTime` não tem campo `status` — o ramo medido se reconhece por ter `ms`. */
function totalTimeBranch(value: unknown): string {
  const totalTime = value as { reason?: string };
  return totalTime.reason === undefined ? 'medido' : totalTime.reason;
}

function expectTotalTimeShape(value: unknown): void {
  expect(value).not.toBeNull();
  const expectedKeys =
    totalTimeBranch(value) === 'medido' ? TOTAL_TIME_MEDIDO_KEYS : TOTAL_TIME_UNMEASURED_KEYS;
  expect(Object.keys(value as object).sort()).toEqual(expectedKeys);
}

function expectStagePeriodShape(value: unknown): void {
  expect(value).not.toBeNull();
  const period = value as { status: string };
  const expectedKeys =
    period.status === 'medido' ? STAGE_PERIOD_MEDIDO_KEYS : STAGE_PERIOD_OTHER_KEYS;
  expect(Object.keys(period).sort()).toEqual(expectedKeys);
}

function expectContentItemShape(value: unknown): void {
  const content = value as { totalTime: unknown; perStage: Record<string, unknown> };
  expect(Object.keys(content as object).sort()).toEqual(CONTENT_ITEM_KEYS);
  expect(Object.keys(content.perStage).sort()).toEqual(PER_STAGE_KEYS);
  expectTotalTimeShape(content.totalTime);
  for (const stageKey of PER_STAGE_KEYS) {
    expectStagePeriodShape(content.perStage[stageKey]);
  }
}

/**
 * Chaves PROIBIDAS em QUALQUER nível do payload (checagem recursiva — um
 * objeto aninhado com `authorId` também reprova, lição "select exposto que lê
 * campo interno prova as chaves do payload"): identidade de autor/aprovador
 * (NFR-034-004, `approvedById` incluso) e texto normativo/de Conteúdo bruto
 * (NFR-034-003).
 */
const FORBIDDEN_IDENTITY_KEYS = ['actorId', 'authorId', 'lastEditedById', 'approvedById'];
const FORBIDDEN_TEXT_KEYS = [
  'rawText',
  'concept',
  'action',
  'object',
  'condition',
  'exception',
  'essence',
  'sourceCitation',
  'pegadinhaText',
  'contentSnapshot',
];

function collectKeysRecursively(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeysRecursively(item, acc);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      acc.add(key);
      collectKeysRecursively(nested, acc);
    }
  }
}

describe('AC-034-013 (NFR-034-003/004) — forma exata do payload de GET /strategic-panel', () => {
  it('EDITOR: Object.keys EXATAS em todo nível (raiz, módulo, rework, backlog) e 0 chaves proibidas em qualquer profundidade', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const access = await seedSession(editor.id);
    const topicId = await createTopic();

    // 1 Conteúdo aprovado e não alterado (entra em `modules`, não em `backlog`).
    const approved = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      approved.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf({ id: editor.id, role: 'EDITOR' }),
      testPrisma,
    );
    await approveContentVersion(
      approved.id,
      closed.number,
      APPROVE_INPUT,
      actorOf({ id: admin.id, role: 'ADMIN' }),
      testPrisma,
    );

    // 1 Conteúdo sem Versão fechada (entra em `backlog`, não concluído).
    await seedApprovableRawContent(editor.id, topicId);

    const res = await request(app)
      .get('/api/v1/strategic-panel')
      .set(...withCookie(access));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(STRATEGIC_PANEL_RESPONSE_KEYS);

    expectTimePerPageShape(res.body.factory.timePerPage);
    expect(Object.keys(res.body.factory).sort()).toEqual(['timePerPage']);

    expect(res.body.modules.length).toBeGreaterThan(0);
    for (const moduleEntry of res.body.modules) {
      expect(Object.keys(moduleEntry).sort()).toEqual(MODULE_KEYS);
      expect(Object.keys(moduleEntry.completion).sort()).toEqual(COMPLETION_KEYS);
      expectTimePerPageShape(moduleEntry.timePerPage);
    }

    expect(Object.keys(res.body.rework).sort()).toEqual(REWORK_KEYS);

    expect(res.body.backlog.length).toBeGreaterThan(0);
    for (const item of res.body.backlog) {
      expect(Object.keys(item).sort()).toEqual(BACKLOG_ITEM_KEYS);
    }

    expect(res.body.contents.length).toBeGreaterThan(0);
    for (const contentItem of res.body.contents) {
      expectContentItemShape(contentItem);
    }

    const allKeys = new Set<string>();
    collectKeysRecursively(res.body, allKeys);
    for (const forbidden of [...FORBIDDEN_IDENTITY_KEYS, ...FORBIDDEN_TEXT_KEYS]) {
      expect(allKeys.has(forbidden)).toBe(false);
    }
  });
});

/**
 * Conteúdo com tempo por página MEDIDO: criação instrumentada
 * (`contents.service.createRawContent` — emite CONTEUDO_BRUTO ABERTURA/CONCLUSAO
 * e QUEBRA_DA_REGRA ABERTURA), Quebra salva (`saveRuleBreakdown` — CONCLUSAO),
 * fechamento de Versão (`closeContentVersion`) e Exportação Tira REAL com
 * `pageCount` (`exportPublication`) — nunca seed direto do Prisma
 * (RISK-034-004).
 */
async function seedMeasuredContent(editor: { id: string }, topicId: string): Promise<void> {
  const actor = actorOf({ id: editor.id, role: 'EDITOR' });
  const created = await createRawContent(
    { topicId, ...RAW_CONTENT_TEXT_FIELDS },
    editor.id,
    testPrisma,
  );
  await saveRuleBreakdown(created.id, BREAKDOWN_FIELDS, actor, testPrisma);
  await closeContentVersion(
    created.id,
    { legislativeClosureDate: '2026-09-01' },
    actor,
    testPrisma,
  );
  await exportPublication(created.id, { variant: 'TIRA' }, actor, testPrisma);
}

/**
 * Conteúdo SEM tempo por página medido: mesma criação instrumentada (evento
 * CONTEUDO_BRUTO existe — `startEvent !== null`), sem Quebra/fechamento/
 * Exportação — nenhuma Exportação de referência para medir contra.
 */
async function seedUnmeasuredContent(editor: { id: string }, topicId: string): Promise<void> {
  await createRawContent({ topicId, ...RAW_CONTENT_TEXT_FIELDS }, editor.id, testPrisma);
}

describe('GET /strategic-panel — 1 caso por ramo de toda união da resposta (FR-034-004/005/006/025)', () => {
  it('1 Conteúdo MEDIDO + 1 SEM medida, em Módulos distintos → cada ramo aparece em TimePerPageAggregate/totalTime/perStage, chaves exatas por ramo', async () => {
    const editor = await createUser('EDITOR');
    const access = await seedSession(editor.id);
    const measuredTopicId = await createTopic();
    const unmeasuredTopicId = await createTopic();

    await seedMeasuredContent(editor, measuredTopicId);
    await seedUnmeasuredContent(editor, unmeasuredTopicId);

    const res = await request(app)
      .get('/api/v1/strategic-panel')
      .set(...withCookie(access));

    expect(res.status).toBe(200);
    expect(res.body.contents).toHaveLength(2);

    // `totalTime`/`perStage` — os 2 ramos apareceram, chaves exatas em cada
    // um (via `expectContentItemShape`).
    const totalTimeBranches: string[] = [];
    type ContentWithPerStageStatus = {
      perStage: { QUEBRA_DA_REGRA: { status: string }; TIRA_MNEMONICA: { status: string } };
    };
    let measuredContent: ContentWithPerStageStatus | undefined;
    let unmeasuredContent: ContentWithPerStageStatus | undefined;
    for (const contentItem of res.body.contents) {
      const branch = totalTimeBranch(contentItem.totalTime);
      totalTimeBranches.push(branch);
      if (branch === 'medido') {
        measuredContent = contentItem;
      } else {
        unmeasuredContent = contentItem;
      }
      expectContentItemShape(contentItem);
    }
    expect(totalTimeBranches).toContain('medido');
    expect(totalTimeBranches).toContain('sem-medida');

    // O Conteúdo MEDIDO tem ao menos 1 etapa "medido" (Quebra da regra,
    // aberta na criação e concluída em `saveRuleBreakdown`), com `msPerPage`
    // presente (chaves exatas já provadas acima).
    expect(measuredContent).toBeDefined();
    expect(measuredContent?.perStage.QUEBRA_DA_REGRA.status).toBe('medido');

    // 1 caso por ramo NÃO medido de `perStage`, com os literais reais: o
    // Conteúdo MEDIDO nunca abre Tira mnemônica/Associação visual/Material de
    // reforço/Aprovação (`'nao-percorrida'`); o SEM medida só recebe a
    // ABERTURA de Quebra da regra (`createRawContent`), sem `saveRuleBreakdown`
    // fechando-a (`'em-aberto'`).
    expect(measuredContent?.perStage.TIRA_MNEMONICA.status).toBe('nao-percorrida');
    expect(unmeasuredContent).toBeDefined();
    expect(unmeasuredContent?.perStage.QUEBRA_DA_REGRA.status).toBe('em-aberto');

    // `TimePerPageAggregate` (nível Módulo) — os 2 ramos apareceram: o Módulo
    // do Conteúdo medido agrega 'medido', o do sem medida agrega 'sem-medida'
    // (nenhum dos 2 Conteúdos divide Módulo com o outro).
    const moduleStatuses: string[] = [];
    for (const moduleEntry of res.body.modules) {
      moduleStatuses.push(moduleEntry.timePerPage.status);
      expectTimePerPageShape(moduleEntry.timePerPage);
    }
    expect(moduleStatuses).toContain('medido');
    expect(moduleStatuses).toContain('sem-medida');
  });
});
