import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `ContentVersion.approvedById`/`approvedAt` — prova de contrato do schema
 * (TASK-031-001), sem passar por nenhum service (`approveContentVersion` nasce
 * em TASK-031-003). Grava/lê direto via `testPrisma`, mesmo molde de
 * `content-version.model.integration.test.ts` (TASK-029-001).
 */

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('ContentVersion.approvedById/approvedAt — estado inicial (FR-030-006 estrutural)', () => {
  it('nasce não aprovada: approvedById e approvedAt são null quando ausentes do data do create', async () => {
    const author = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(author.id, topicId);

    const contentVersion = await testPrisma.contentVersion.create({
      data: {
        rawContentId: rawContent.id,
        authorId: author.id,
        number: 1,
        legislativeClosureDate: new Date('2026-09-01T00:00:00.000Z'),
        contentSnapshot: { rawText: 'Art. 113 do CTN define a obrigação tributária.' },
      },
    });

    const read = await testPrisma.contentVersion.findUniqueOrThrow({
      where: { id: contentVersion.id },
    });

    expect(read.approvedById).toBeNull();
    expect(read.approvedAt).toBeNull();
  });
});

describe('ContentVersion.approvedById/approvedAt — aprovação persistida e relação `approver` navegável', () => {
  it('grava approvedById/approvedAt via update e lê de volta com o approver correto pela relação nomeada', async () => {
    const author = await createUser('EDITOR');
    const approver = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await createRawContent(author.id, topicId);

    const contentVersion = await testPrisma.contentVersion.create({
      data: {
        rawContentId: rawContent.id,
        authorId: author.id,
        number: 1,
        legislativeClosureDate: new Date('2026-09-01T00:00:00.000Z'),
        contentSnapshot: { rawText: 'Art. 113 do CTN define a obrigação tributária.' },
      },
    });

    const approvedAt = new Date('2026-09-27T12:00:00.000Z');
    await testPrisma.contentVersion.update({
      where: { id: contentVersion.id },
      data: { approvedById: approver.id, approvedAt },
    });

    const read = await testPrisma.contentVersion.findUniqueOrThrow({
      where: { id: contentVersion.id },
      include: { approver: true },
    });

    expect(read.approvedById).toBe(approver.id);
    expect(read.approvedAt).toEqual(approvedAt);
    // A relação nomeada (`ContentVersionApprover`) navega até o USER correto,
    // distinta de `author` (o próprio `author.id`, que aqui é outra pessoa).
    expect(read.approver?.id).toBe(approver.id);
    expect(read.approver?.id).not.toBe(author.id);
  });
});
