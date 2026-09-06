import { randomUUID } from 'node:crypto';

import type { UserRole } from '../../src/domain/types';
import { closeTestDb, Prisma, resetDb, testPrisma } from './db';

/**
 * `ProductionStageEvent` — prova de contrato do model (TASK-010-001 /
 * COMP-010-001), sem passar pelo service de emissão (que nasce só na
 * TASK-010-002). Cobre, no nível do schema:
 *
 *  - AC-009-007 (parte): FK `Restrict` de `rawContentId` — um `RawContent` com
 *    evento associado não pode ser hard-deletado.
 *  - AC-009-008 (parte): a coluna `sequence` desempata eventos com
 *    `occurredAt` idêntico, na ordem de inserção.
 *
 * Grava direto via `testPrisma`, sem `production-events.service.ts` (que não
 * existe ainda nesta TASK).
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

async function createRawContent(authorId: string, topicId: string) {
  return testPrisma.rawContent.create({
    data: {
      authorId,
      topicId,
      rawText: 'Art. 113 do CTN define a obrigação tributária.',
      radarClass: 'ALTA',
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('ProductionStageEvent — FK Restrict de rawContentId sobrevive ao hard-delete (AC-009-007, parte)', () => {
  it('um RawContent com evento de etapa associado não pode ser hard-deletado', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    await testPrisma.productionStageEvent.create({
      data: {
        rawContentId: rawContent.id,
        stageType: 'CONTEUDO_BRUTO',
        transitionType: 'ABERTURA',
        actorId: editor.id,
      },
    });

    await expect(testPrisma.rawContent.delete({ where: { id: rawContent.id } })).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );

    try {
      await testPrisma.rawContent.delete({ where: { id: rawContent.id } });
      throw new Error('esperava rejeição, mas o delete resolveu');
    } catch (err) {
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
    }
  });
});

describe('ProductionStageEvent — coluna sequence desempata occurredAt idêntico (AC-009-008, parte)', () => {
  it('grava sequence estritamente crescente e preserva a ordem de inserção mesmo com occurredAt igual', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const sameInstant = new Date('2026-09-06T12:00:00.000Z');

    const first = await testPrisma.productionStageEvent.create({
      data: {
        rawContentId: rawContent.id,
        stageType: 'CONTEUDO_BRUTO',
        transitionType: 'ABERTURA',
        actorId: editor.id,
        occurredAt: sameInstant,
      },
    });
    const second = await testPrisma.productionStageEvent.create({
      data: {
        rawContentId: rawContent.id,
        stageType: 'CONTEUDO_BRUTO',
        transitionType: 'CONCLUSAO',
        actorId: editor.id,
        occurredAt: sameInstant,
      },
    });
    const third = await testPrisma.productionStageEvent.create({
      data: {
        rawContentId: rawContent.id,
        stageType: 'QUEBRA_DA_REGRA',
        transitionType: 'ABERTURA',
        actorId: editor.id,
        occurredAt: sameInstant,
      },
    });

    expect(first.sequence).toBeLessThan(second.sequence);
    expect(second.sequence).toBeLessThan(third.sequence);

    const ordered = await testPrisma.productionStageEvent.findMany({
      where: { rawContentId: rawContent.id },
      orderBy: { sequence: 'asc' },
    });

    expect(ordered.map((event) => event.id)).toEqual([first.id, second.id, third.id]);
  });
});
