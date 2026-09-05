import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import type { UserRole } from '../../src/domain/types';
import { PrismaClient } from '../../src/generated/prisma/client';
import { AppError, NotFoundError } from '../../src/http/errors';
import type { CreateRawContentInput } from '../../src/modules/contents/contents.schema';
import {
  type ContentActor,
  createRawContent,
  getRawContent,
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
  const discipline = await testPrisma.discipline.create({
    data: { name: `Disciplina ${randomUUID()}`, slug: `disciplina-${randomUUID()}` },
  });
  const topic = await testPrisma.topic.create({
    data: {
      disciplineId: discipline.id,
      name: `Tema ${randomUUID()}`,
      slug: `tema-${randomUUID()}`,
    },
  });
  return topic.id;
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
}

async function seedRawContent(seed: RawContentSeed) {
  return testPrisma.rawContent.create({
    data: {
      authorId: seed.authorId,
      topicId: seed.topicId,
      rawText: seed.rawText ?? 'Art. 113 do CTN define a obrigação tributária.',
      radarClass: seed.radarClass ?? 'ALTA',
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

  it('soft-deleted de outro autor → 404 (par de guards que coincide; o filtro de remoção decide, mesmo com o alcance também negando)', async () => {
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

  it('soft-deleted de outro autor → 404 (par de guards que coincide)', async () => {
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
