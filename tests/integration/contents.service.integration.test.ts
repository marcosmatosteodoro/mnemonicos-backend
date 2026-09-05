import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import type { UserRole } from '../../src/domain/types';
import { PrismaClient } from '../../src/generated/prisma/client';
import { AppError, NotFoundError } from '../../src/http/errors';
import type {
  CreateRawContentInput,
  SaveRuleBreakdownInput,
} from '../../src/modules/contents/contents.schema';
import {
  type ContentActor,
  createRawContent,
  getRawContent,
  getRuleBreakdown,
  listRawContents,
  saveRuleBreakdown,
  softDeleteRawContent,
  updateRawContent,
} from '../../src/modules/contents/contents.service';
import { closeTestDb, resetDb, testPrisma } from './db';
import { TEST_DATABASE_URL } from './db-url';

/**
 * `contents.service.ts` — ciclo de vida do Conteúdo bruto (TASK-006-006 /
 * COMP-006-003) sobre o Postgres real (harness de TASK-003-016).
 *
 * Inventário de casos do critério de mutação **contável** (lição ativa
 * [Segurança] "enumerar por DADO, não por rota") — **4 métodos, 4 provas**:
 *   1. `createRawContent`  — "authorId vem do actorId, nunca do input"
 *   2. `getRawContent`     — "fora do alcance → 404" (mutação do alcance) +
 *                            "soft-deleted → 404" (mutação de `deletedAt`)
 *   3. `updateRawContent`  — idem, sobre a guarda de escrita
 *   4. `softDeleteRawContent` — idem, sobre a guarda de escrita
 * Cada mutação nomeada (neutralizar `deletedAt: null` OU o alcance `authorId`
 * num método) reprova a prova correspondente abaixo.
 */

async function createUser(role: UserRole = 'EDITOR') {
  return testPrisma.user.create({
    data: {
      email: `user-${randomUUID()}@example.com`,
      name: 'Usuária de fixture',
      passwordHash: 'irrelevante-para-este-teste',
      role,
    },
  });
}

async function createTopic(): Promise<string> {
  const { topicId } = await createTopicWithNames();
  return topicId;
}

/** Variante de `createTopic` que devolve os nomes semeados, para asserção do resumo. */
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
  radarClass?: CreateRawContentInput['radarClass'];
  sourceType?: CreateRawContentInput['sourceType'];
  sourceCitation?: string;
  sourceUrl?: string;
  deletedAt?: Date | null;
  lastEditedById?: string | null;
  lastEditedAt?: Date | null;
  /** Ponto fixo de `createdAt` — usado para fixar ordem determinística sem `sleep` entre criações. */
  createdAt?: Date;
}

async function seedRawContent(seed: RawContentSeed) {
  return testPrisma.rawContent.create({
    data: {
      authorId: seed.authorId,
      topicId: seed.topicId,
      rawText: seed.rawText ?? 'Art. 113 do CTN define a obrigação tributária.',
      radarClass: seed.radarClass ?? 'ALTA',
      createdAt: seed.createdAt,
      sourceType: seed.sourceType,
      sourceCitation: seed.sourceCitation,
      sourceUrl: seed.sourceUrl,
      deletedAt: seed.deletedAt ?? null,
      lastEditedById: seed.lastEditedById ?? null,
      lastEditedAt: seed.lastEditedAt ?? null,
    },
  });
}

function actorOf(user: { id: string; role: UserRole }): ContentActor {
  return { id: user.id, role: user.role };
}

/**
 * Sonda de round-trips (lição [Performance]) — única definição no módulo,
 * reusada por `getRawContent` e `listRawContents`.
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

/** Captura a mensagem de um `AppError` esperado, para comparação literal entre recusas. */
async function captureMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('esperava rejeição, mas a chamada resolveu');
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('createRawContent — authorId vem do actorId, nunca do input (prova 1/4)', () => {
  it('grava authorId = actorId mesmo quando o input carrega um authorId diferente', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();

    const input = {
      topicId,
      rawText: 'Fato gerador da obrigação tributária.',
      radarClass: 'MEDIA',
      // Mutante do critério contável: se `createRawContent` lesse `authorId`
      // do `input` em vez do parâmetro `actorId`, o valor gravado seria o de
      // `editorB` — a asserção abaixo reprova.
      authorId: editorB.id,
    } as unknown as CreateRawContentInput;

    const created = await createRawContent(input, editorA.id, testPrisma);

    expect(created.authorId).toBe(editorA.id);
    expect(created.radarClass).toBe('MEDIA');

    const row = await testPrisma.rawContent.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.authorId).toBe(editorA.id);
  });
});

describe('getRawContent — alcance e remoção reversível (prova 2/4; AC-005-008, AC-005-014, AC-005-037)', () => {
  it('devolve o conteúdo ativo no alcance, com a fonte normativa como persistida', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({
      authorId: editorA.id,
      topicId,
      sourceType: 'CTN',
      sourceCitation: 'CTN, art. 113',
      sourceUrl: 'https://planalto.gov.br/ctn',
    });

    const result = await getRawContent(seeded.id, actorOf(editorA), testPrisma);

    expect(result).toMatchObject({
      id: seeded.id,
      sourceType: 'CTN',
      sourceCitation: 'CTN, art. 113',
      sourceUrl: 'https://planalto.gov.br/ctn',
    });
  });

  it('id inexistente → AppError 404', async () => {
    const editorA = await createUser('EDITOR');

    await expect(getRawContent(randomUUID(), actorOf(editorA), testPrisma)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('soft-deleted (mesmo autor) → 404 — mutação de `deletedAt: null` reprova este caso', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId, deletedAt: new Date() });

    await expect(getRawContent(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(AppError);
  });

  it('ativo, mas de outro autor (EDITOR fora do alcance) → 404 — mutação do alcance reprova este caso', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorB.id, topicId });

    await expect(getRawContent(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('soft-deleted de outro autor → 404 — as duas negações valem, sem precedência a observar (where conjuntivo e comutativo)', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({
      authorId: editorB.id,
      topicId,
      deletedAt: new Date(),
    });

    await expect(getRawContent(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('ADMIN alcança item ativo de um EDITOR (ramo ADMIN do alcance)', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });

    const result = await getRawContent(seeded.id, actorOf(admin), testPrisma);
    expect(result.id).toBe(seeded.id);
  });
});

describe('getRawContent — round-trips fixados (lição [Performance])', () => {
  it('resolve o Conteúdo bruto com exatamente 1 round-trip (select explícito, sem include)', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });

    const queries = await withQueryProbe((probe) =>
      getRawContent(seeded.id, actorOf(editorA), probe),
    );

    expect(queries).toHaveLength(1);
  });
});

describe('updateRawContent — autoria imutável + carimbo de última alteração (prova 3/4; AC-005-009, AC-005-036)', () => {
  it('ADMIN edita item de EDITOR: authorId permanece do EDITOR; carimbo aponta o ADMIN; valores novos persistidos', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const seeded = await seedRawContent({
      authorId: editorA.id,
      topicId,
      rawText: 'texto original',
    });

    const before = Date.now();
    const updated = await updateRawContent(
      seeded.id,
      { rawText: 'novo' },
      actorOf(admin),
      testPrisma,
    );
    const after = Date.now();

    expect(updated.authorId).toBe(editorA.id);
    expect(updated.rawText).toBe('novo');
    expect(updated.lastEditedById).toBe(admin.id);
    expect(updated.lastEditedAt).not.toBeNull();
    const stampedAt = updated.lastEditedAt?.getTime() ?? 0;
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(after);
  });

  it('EDITOR edita o próprio item (ramo EDITOR do alcance)', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({
      authorId: editorA.id,
      topicId,
      rawText: 'texto original',
    });

    const updated = await updateRawContent(
      seeded.id,
      { rawText: 'editado pelo próprio autor' },
      actorOf(editorA),
      testPrisma,
    );

    expect(updated.rawText).toBe('editado pelo próprio autor');
    expect(updated.lastEditedById).toBe(editorA.id);
  });

  it('id inexistente → 404', async () => {
    const editorA = await createUser('EDITOR');

    await expect(
      updateRawContent(randomUUID(), { rawText: 'x' }, actorOf(editorA), testPrisma),
    ).rejects.toThrow(NotFoundError);
  });

  it('soft-deleted (mesmo autor) → 404 — mutação de `deletedAt: null` reprova este caso', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId, deletedAt: new Date() });

    await expect(
      updateRawContent(seeded.id, { rawText: 'x' }, actorOf(editorA), testPrisma),
    ).rejects.toThrow(NotFoundError);
  });

  it('ativo, mas de outro autor (EDITOR fora do alcance) → 404 — mutação do alcance reprova este caso', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorB.id, topicId });

    await expect(
      updateRawContent(seeded.id, { rawText: 'x' }, actorOf(editorA), testPrisma),
    ).rejects.toThrow(NotFoundError);
  });

  it('soft-deleted de outro autor → 404 — as duas negações valem, sem precedência a observar (where conjuntivo e comutativo)', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorB.id, topicId, deletedAt: new Date() });

    await expect(
      updateRawContent(seeded.id, { rawText: 'x' }, actorOf(editorA), testPrisma),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('softDeleteRawContent — remoção reversível (prova 4/4; AC-005-013, AC-005-037, AC-005-036)', () => {
  it('marca deletedAt sem tocar authorId/lastEditedById; getRawContent passa a recusar; a Quebra vinculada permanece no banco', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({
      authorId: editorA.id,
      topicId,
      lastEditedById: editorA.id,
      lastEditedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await testPrisma.ruleBreakdown.create({
      data: {
        rawContentId: seeded.id,
        concept: 'conceito',
        action: 'ação',
        object: 'objeto',
        essence: 'síntese',
      },
    });

    await softDeleteRawContent(seeded.id, actorOf(editorA), testPrisma);

    const row = await testPrisma.rawContent.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.authorId).toBe(editorA.id);
    expect(row.lastEditedById).toBe(editorA.id);
    expect(row.lastEditedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    await expect(getRawContent(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      NotFoundError,
    );

    const breakdown = await testPrisma.ruleBreakdown.findUnique({
      where: { rawContentId: seeded.id },
    });
    expect(breakdown).not.toBeNull();
  });

  it('ADMIN remove item de EDITOR (ramo ADMIN do alcance)', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });

    await softDeleteRawContent(seeded.id, actorOf(admin), testPrisma);

    const row = await testPrisma.rawContent.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('item já soft-deleted → 404 — não reidempotente; mutação de `deletedAt: null` reprova este caso', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const originalDeletedAt = new Date('2026-01-01T00:00:00Z');
    const seeded = await seedRawContent({
      authorId: editorA.id,
      topicId,
      deletedAt: originalDeletedAt,
    });

    await expect(softDeleteRawContent(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      NotFoundError,
    );

    const row = await testPrisma.rawContent.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(row.deletedAt?.toISOString()).toBe(originalDeletedAt.toISOString());
  });

  it('ativo, mas de outro autor (EDITOR fora do alcance) → 404; o item permanece ativo — mutação do alcance reprova este caso', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorB.id, topicId });

    await expect(softDeleteRawContent(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      NotFoundError,
    );

    const row = await testPrisma.rawContent.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(row.deletedAt).toBeNull();
  });
});

/**
 * `listRawContents` (TASK-006-008 / COMP-006-003) — terceira fatia do
 * service, único método novo desta TASK que toca `raw_contents` em leitura
 * (fechamento contável do gate 8: 1 método, 1 prova de mutação do predicado
 * de escopo + 1 caso por ramo de alcance).
 */
describe('listRawContents — ordenação, envelope e resumo (AC-005-001, AC-005-035)', () => {
  it('3 itens do mesmo autor em createdAt distintos → data do mais recente para o mais antigo, envelope completo, resumo não-nulo', async () => {
    const editorA = await createUser('EDITOR');
    const { topicId, disciplineName, topicName } = await createTopicWithNames();

    const oldest = await seedRawContent({
      authorId: editorA.id,
      topicId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const middle = await seedRawContent({
      authorId: editorA.id,
      topicId,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    const newest = await seedRawContent({
      authorId: editorA.id,
      topicId,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });

    const result = await listRawContents({ page: 1, perPage: 20 }, actorOf(editorA), testPrisma);

    expect(Object.keys(result).sort()).toEqual(['data', 'page', 'perPage', 'total']);
    expect(result.data.map((item) => item.id)).toEqual([newest.id, middle.id, oldest.id]);
    for (const item of result.data) {
      expect(item.disciplineName).toBe(disciplineName);
      expect(item.topicName).toBe(topicName);
      expect(item.radarClass).not.toBeNull();
    }
  });
});

describe('listRawContents — alcance por autor (AC-005-018, gate 8, prova 1/1 desta TASK)', () => {
  it('ADMIN alcança itens de outro autor; EDITOR só os próprios', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();

    const activeA = await seedRawContent({ authorId: editorA.id, topicId });
    const deletedA = await seedRawContent({
      authorId: editorA.id,
      topicId,
      deletedAt: new Date(),
    });
    const activeB = await seedRawContent({ authorId: editorB.id, topicId });

    const asEditorA = await listRawContents({ page: 1, perPage: 20 }, actorOf(editorA), testPrisma);
    const ids = asEditorA.data.map((item) => item.id);
    expect(ids).toEqual([activeA.id]);
    expect(ids).not.toContain(deletedA.id);
    expect(ids).not.toContain(activeB.id);

    const asAdmin = await listRawContents({ page: 1, perPage: 20 }, actorOf(admin), testPrisma);
    const adminIds = asAdmin.data.map((item) => item.id);
    expect(adminIds.sort()).toEqual([activeA.id, activeB.id].sort());
    expect(adminIds).not.toContain(deletedA.id);
  });
});

describe('listRawContents — total aplica o mesmo predicado de escopo de data (paginação)', () => {
  it('3 itens do EDITOR (1 soft-deleted) → data.length === 2 e total === 2 (não 3)', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();

    await seedRawContent({ authorId: editorA.id, topicId });
    await seedRawContent({ authorId: editorA.id, topicId });
    await seedRawContent({ authorId: editorA.id, topicId, deletedAt: new Date() });

    const result = await listRawContents({ page: 1, perPage: 10 }, actorOf(editorA), testPrisma);

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('2 EDITORes (A, B) + item soft-deleted de A → total de A conta só os próprios ativos; total do ADMIN soma os dois', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();

    await seedRawContent({ authorId: editorA.id, topicId });
    await seedRawContent({ authorId: editorA.id, topicId, deletedAt: new Date() });
    await seedRawContent({ authorId: editorB.id, topicId });

    // Mutante do critério: count({ where: ACTIVE_RAW_CONTENT_WHERE }) sem
    // `authorId` faria `asEditorA.total` contar também o item de B (2, não 1).
    const asEditorA = await listRawContents({ page: 1, perPage: 10 }, actorOf(editorA), testPrisma);
    expect(asEditorA.total).toBe(1);

    const asAdmin = await listRawContents({ page: 1, perPage: 10 }, actorOf(admin), testPrisma);
    expect(asAdmin.total).toBe(2);
  });
});

describe('listRawContents — sourceCitation e flag "tem Quebra da regra" (AC-005-016, AC-005-025)', () => {
  it('item com fonte + Quebra traz a citação e a flag true; item sem Quebra traz a flag false', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();

    const withBreakdown = await seedRawContent({
      authorId: editorA.id,
      topicId,
      sourceType: 'CTN',
      sourceCitation: 'CTN, art. 113',
    });
    await testPrisma.ruleBreakdown.create({
      data: {
        rawContentId: withBreakdown.id,
        concept: 'conceito',
        action: 'ação',
        object: 'objeto',
        essence: 'síntese',
      },
    });
    const withoutBreakdown = await seedRawContent({ authorId: editorA.id, topicId });

    const result = await listRawContents({ page: 1, perPage: 20 }, actorOf(editorA), testPrisma);

    const summaryWith = result.data.find((item) => item.id === withBreakdown.id);
    const summaryWithout = result.data.find((item) => item.id === withoutBreakdown.id);

    expect(summaryWith?.sourceCitation).toBe('CTN, art. 113');
    expect(summaryWith?.hasRuleBreakdown).toBe(true);
    expect(summaryWithout?.hasRuleBreakdown).toBe(false);
  });
});

describe('listRawContents — select explícito (nenhum include implícito de relação)', () => {
  it('Object.keys(summary) == conjunto documentado de RawContentSummary — sem chave crua de relação', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    await seedRawContent({ authorId: editorA.id, topicId });

    const result = await listRawContents({ page: 1, perPage: 20 }, actorOf(editorA), testPrisma);

    expect(result.data).toHaveLength(1);
    const [summary] = result.data;
    if (!summary) throw new Error('fixture não gerou item — assert acima já deveria ter reprovado');

    expect(Object.keys(summary).sort()).toEqual(
      [
        'id',
        'rawText',
        'disciplineName',
        'topicName',
        'radarClass',
        'sourceCitation',
        'hasRuleBreakdown',
      ].sort(),
    );
  });
});

describe('listRawContents — round-trips fixados (lição [Performance], gate 10)', () => {
  it('1 item semeado (com Topic/Discipline/RuleBreakdown reais) → exatamente 2 eventos query', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });
    await testPrisma.ruleBreakdown.create({
      data: {
        rawContentId: seeded.id,
        concept: 'conceito',
        action: 'ação',
        object: 'objeto',
        essence: 'síntese',
      },
    });

    const queries = await withQueryProbe((probe) =>
      listRawContents({ page: 1, perPage: 20 }, actorOf(editorA), probe),
    );

    expect(queries).toHaveLength(2);
  });

  it('3 itens semeados → ainda exatamente 2 eventos query (não cresce com o nº de itens)', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    await seedRawContent({ authorId: editorA.id, topicId });
    await seedRawContent({ authorId: editorA.id, topicId });
    await seedRawContent({ authorId: editorA.id, topicId });

    const queries = await withQueryProbe((probe) =>
      listRawContents({ page: 1, perPage: 20 }, actorOf(editorA), probe),
    );

    expect(queries).toHaveLength(2);
  });
});

/**
 * `getRuleBreakdown`/`saveRuleBreakdown` (TASK-006-009 / COMP-006-003) — quarta
 * fatia do service: upsert 1:1 da Quebra da regra por `rawContentId` (`@unique`,
 * T001), obrigatoriedade dos 4 blocos essenciais e inalcançabilidade herdada do
 * pai (DEC-006-001). Fechamento contável do gate 8 (2 métodos, 2 provas): as
 * **2** funções que tocam `raw_contents` via `assertRawContentReachable` —
 * `getRuleBreakdown` (leitura) e `saveRuleBreakdown` (escrita em
 * `rule_breakdowns` condicionada ao pai) — têm cada uma prova de segunda
 * instância cuja mutação do predicado reprova, incluindo a negação da
 * **escrita** de EDITOR A sobre o `RawContent` de EDITOR B (IDOR de escrita —
 * decisão 4.232).
 */
const breakdownInputA: SaveRuleBreakdownInput = {
  concept: 'Vínculo jurídico entre Fisco e contribuinte.',
  action: 'Cobrar o tributo devido.',
  object: 'A obrigação tributária.',
  condition: 'Quando há substituição tributária.',
  exception: 'Salvo isenção legal expressa.',
  essence: 'Nasce da ocorrência do fato gerador.',
};

const breakdownInputB: SaveRuleBreakdownInput = {
  concept: 'Segundo conceito, após alteração.',
  action: 'Segunda ação, após alteração.',
  object: 'Segundo objeto, após alteração.',
  essence: 'Segunda síntese, após alteração.',
  // Omitidos de propósito (undefined, não string) — simula o corpo de
  // requisição que não envia os campos; `saveRuleBreakdownSchema` colapsa
  // undefined/null/'' para undefined, então `saveRuleBreakdown` grava null
  // (A-005-009 — "não se aplica").
  condition: undefined,
  exception: undefined,
};

describe('saveRuleBreakdown / getRuleBreakdown — round-trip e atualização in-place (AC-005-019, AC-005-024, prova 1/2 gate 8)', () => {
  it('grava os 6 campos, lê exatamente como persistido; 2ª gravação atualiza a mesma linha e a leitura seguinte reflete os novos valores', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });

    const saved = await saveRuleBreakdown(seeded.id, breakdownInputA, actorOf(editorA), testPrisma);
    expect(saved).toEqual({
      concept: breakdownInputA.concept,
      action: breakdownInputA.action,
      object: breakdownInputA.object,
      condition: breakdownInputA.condition,
      exception: breakdownInputA.exception,
      essence: breakdownInputA.essence,
    });

    const read = await getRuleBreakdown(seeded.id, actorOf(editorA), testPrisma);
    expect(read).toEqual(saved);

    // 2ª gravação: outros valores, e condition/exception omitidos ("não se
    // aplica" — A-005-009) → viram null, nunca preservam o valor antigo.
    const updated = await saveRuleBreakdown(
      seeded.id,
      breakdownInputB,
      actorOf(editorA),
      testPrisma,
    );
    expect(updated.concept).toBe(breakdownInputB.concept);
    expect(updated.action).toBe(breakdownInputB.action);
    expect(updated.object).toBe(breakdownInputB.object);
    expect(updated.essence).toBe(breakdownInputB.essence);
    expect(updated.condition).toBeNull();
    expect(updated.exception).toBeNull();

    const rereadAfterUpdate = await getRuleBreakdown(seeded.id, actorOf(editorA), testPrisma);
    expect(rereadAfterUpdate).toEqual(updated);

    // Upsert 1:1 (AC-005-020): a 2ª gravação nunca cria uma segunda linha.
    const rowCount = await testPrisma.ruleBreakdown.count({
      where: { rawContentId: seeded.id },
    });
    expect(rowCount).toBe(1);
  });
});

describe('saveRuleBreakdown — unicidade 1:1 sob corrida (AC-005-020, fronteira: RawContent sem RuleBreakdown)', () => {
  it('2 saveRuleBreakdown concorrentes para o mesmo rawContentId sem Quebra prévia → exatamente 1 linha; conteúdo é um dos dois inputs', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });

    // Mutante do critério (check-then-act: findFirst + create incondicional,
    // sem apoiar no `@unique`/`upsert`): sob esta corrida, criaria 2 linhas.
    // O `@unique` + `upsert` nativo do Postgres resolve atomicamente.
    await Promise.all([
      saveRuleBreakdown(seeded.id, breakdownInputA, actorOf(editorA), testPrisma),
      saveRuleBreakdown(seeded.id, breakdownInputB, actorOf(editorA), testPrisma),
    ]);

    const count = await testPrisma.ruleBreakdown.count({ where: { rawContentId: seeded.id } });
    expect(count).toBe(1);

    const row = await testPrisma.ruleBreakdown.findUniqueOrThrow({
      where: { rawContentId: seeded.id },
    });
    expect([breakdownInputA.concept, breakdownInputB.concept]).toContain(row.concept);
  });
});

describe('getRuleBreakdown / saveRuleBreakdown — recusa quando o pai não existe/soft-deleted/fora do alcance (AC-005-021, AC-005-013, AC-005-037, AC-005-031, prova 2/2 gate 8)', () => {
  it('rawContentId inexistente → AppError nas duas funções', async () => {
    const editorA = await createUser('EDITOR');
    const randomId = randomUUID();

    await expect(getRuleBreakdown(randomId, actorOf(editorA), testPrisma)).rejects.toThrow(
      AppError,
    );
    await expect(
      saveRuleBreakdown(randomId, breakdownInputA, actorOf(editorA), testPrisma),
    ).rejects.toThrow(AppError);
  });

  it('pai soft-deleted (mesmo autor) → AppError nas duas funções; a Quebra gravada antes da remoção continua no banco, mas inalcançável (AC-005-013, AC-005-031, AC-005-037) — mutação de `deletedAt: null` reprova este caso', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });
    await saveRuleBreakdown(seeded.id, breakdownInputA, actorOf(editorA), testPrisma);

    await softDeleteRawContent(seeded.id, actorOf(editorA), testPrisma);

    await expect(getRuleBreakdown(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      AppError,
    );
    await expect(
      saveRuleBreakdown(seeded.id, breakdownInputB, actorOf(editorA), testPrisma),
    ).rejects.toThrow(AppError);

    const orphan = await testPrisma.ruleBreakdown.findUnique({
      where: { rawContentId: seeded.id },
    });
    expect(orphan).not.toBeNull();
    expect(orphan?.concept).toBe(breakdownInputA.concept);
  });

  it('pai de outro autor (EDITOR B), ator EDITOR A → AppError nas duas funções (IDOR de escrita — decisão 4.232); nenhum byte alcança rule_breakdowns — mutação do alcance reprova este caso', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorB.id, topicId });

    await expect(getRuleBreakdown(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      saveRuleBreakdown(seeded.id, breakdownInputA, actorOf(editorA), testPrisma),
    ).rejects.toThrow(NotFoundError);

    const count = await testPrisma.ruleBreakdown.count({ where: { rawContentId: seeded.id } });
    expect(count).toBe(0);
  });

  it('ADMIN alcança leitura e escrita da Quebra de conteúdo de EDITOR (ramo ADMIN do alcance)', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });

    const saved = await saveRuleBreakdown(seeded.id, breakdownInputA, actorOf(admin), testPrisma);
    expect(saved.concept).toBe(breakdownInputA.concept);

    const read = await getRuleBreakdown(seeded.id, actorOf(admin), testPrisma);
    expect(read).toEqual(saved);
  });
});

/**
 * Ramo "pai alcançável, sem Quebra ainda": caminho feliz de T014 abrir o
 * editor de uma Quebra nova. Decisão do Tech Lead (reversível):
 * `getRuleBreakdown` mantém o 404 — T014 trata esse 404 como "abrir
 * formulário vazio".
 */
describe('getRuleBreakdown / saveRuleBreakdown — pai alcançável sem Quebra ainda', () => {
  it('pai alcançável sem Quebra ainda → getRuleBreakdown recusa com 404, saveRuleBreakdown cria normalmente', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const seeded = await seedRawContent({ authorId: editorA.id, topicId });

    await expect(getRuleBreakdown(seeded.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      'Quebra da regra não encontrada.',
    );

    const created = await saveRuleBreakdown(
      seeded.id,
      breakdownInputA,
      actorOf(editorA),
      testPrisma,
    );
    expect(created.concept).toBe(breakdownInputA.concept);

    const read = await getRuleBreakdown(seeded.id, actorOf(editorA), testPrisma);
    expect(read).toEqual(created);
  });
});

/**
 * Precedência de guards de `assertRawContentReachable`: `inexistente → fora
 * do alcance → soft-deleted`. A ordem importa porque cada guard tem mensagem
 * própria — quem NÃO alcança o pai (id aleatório OU item de outro autor,
 * removido ou não) recebe SEMPRE a mesma mensagem literal; só quem alcança
 * (dono ou ADMIN) sobre item soft-deleted vê a mensagem de remoção. Inverter
 * a ordem (soft-delete antes do alcance) vazaria um oráculo de autoria via
 * mensagem (A01): um EDITOR A que possui o id de um `RawContent` de EDITOR B
 * distinguiria "não encontrado" (item ativo de B) de "foi removido" (item de
 * B soft-deleted). Os casos abaixo são nomeados por PAPEL (não por "quem
 * vence") e comparam as duas mensagens de não-alcance por igualdade literal
 * entre si, não só por tipo `AppError`.
 */
describe('assertRawContentReachable — precedência de guards', () => {
  const NOT_FOUND_MESSAGE = 'Conteúdo bruto não encontrado.';
  const REMOVED_MESSAGE = 'Conteúdo bruto foi removido.';

  it('não-dono sobre conteúdo removido de outro autor → recusa indistinguível de "não encontrado"', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const removedOfB = await seedRawContent({
      authorId: editorB.id,
      topicId,
      deletedAt: new Date(),
    });

    const messageForRandomId = await captureMessage(() =>
      getRuleBreakdown(randomUUID(), actorOf(editorA), testPrisma),
    );
    const messageForRemovedOfOtherAuthor = await captureMessage(() =>
      getRuleBreakdown(removedOfB.id, actorOf(editorA), testPrisma),
    );

    // Comparação literal entre as duas recusas de não-alcance — não só tipo
    // AppError. O mutante que reordena de volta (soft-deleted antes de fora
    // do alcance) faria `messageForRemovedOfOtherAuthor` virar REMOVED_MESSAGE.
    expect(messageForRemovedOfOtherAuthor).toBe(messageForRandomId);
    expect(messageForRemovedOfOtherAuthor).toBe(NOT_FOUND_MESSAGE);
    expect(messageForRemovedOfOtherAuthor).not.toBe(REMOVED_MESSAGE);

    await expect(
      saveRuleBreakdown(removedOfB.id, breakdownInputA, actorOf(editorA), testPrisma),
    ).rejects.toThrow(NOT_FOUND_MESSAGE);
  });

  it('dono sobre o próprio conteúdo removido → recusa por remoção', async () => {
    const editorA = await createUser('EDITOR');
    const topicId = await createTopic();
    const ownRemoved = await seedRawContent({
      authorId: editorA.id,
      topicId,
      deletedAt: new Date(),
    });

    await expect(getRuleBreakdown(ownRemoved.id, actorOf(editorA), testPrisma)).rejects.toThrow(
      REMOVED_MESSAGE,
    );
    await expect(
      saveRuleBreakdown(ownRemoved.id, breakdownInputA, actorOf(editorA), testPrisma),
    ).rejects.toThrow(REMOVED_MESSAGE);
  });

  it('ADMIN sobre conteúdo removido de EDITOR → recusa por remoção (ramo ADMIN do alcance)', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const removed = await seedRawContent({
      authorId: editorA.id,
      topicId,
      deletedAt: new Date(),
    });

    await expect(getRuleBreakdown(removed.id, actorOf(admin), testPrisma)).rejects.toThrow(
      REMOVED_MESSAGE,
    );
  });
});
