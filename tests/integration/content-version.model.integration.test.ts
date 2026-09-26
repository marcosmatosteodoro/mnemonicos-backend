import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `ContentVersion` + valor aditivo `VERSAO_EDITORIAL` — prova de contrato do
 * schema (TASK-029-001), sem passar por nenhum service (nascem em
 * TASK-029-002). Grava/lê direto via `testPrisma`, mesmo molde de
 * `material-reforco.model.integration.test.ts`/
 * `visual-associations.model.integration.test.ts`.
 */

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('ContentVersion — criada e lida de volta vinculada a RawContent/autor', () => {
  it('cria 1 ContentVersion com number 1 e lê os 6 campos de volta via Prisma Client', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const legislativeClosureDate = new Date('2026-09-01T00:00:00.000Z');
    const contentSnapshot = {
      rawText: 'Art. 113 do CTN define a obrigação tributária.',
      radarClass: 'ALTA',
      concept: 'Vínculo jurídico entre Fisco e contribuinte.',
    };

    const contentVersion = await testPrisma.contentVersion.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        number: 1,
        legislativeClosureDate,
        contentSnapshot,
      },
    });

    // Se `@@map("content_versions")` ou alguma das 2 FKs `Restrict` novas
    // estivesse errada, o `create` acima já teria rejeitado com erro do
    // Postgres — a leitura de volta é a 2ª metade do contrato (o dado
    // persistido é o dado lido).
    await expect(
      testPrisma.contentVersion.findUniqueOrThrow({ where: { id: contentVersion.id } }),
    ).resolves.toMatchObject({
      rawContentId: rawContent.id,
      authorId: editor.id,
      number: 1,
      legislativeClosureDate,
      contentSnapshot,
    });
  });
});

describe('ContentVersion — @@unique([rawContentId, number]) rejeita duplicidade', () => {
  it('rejeita a 2ª ContentVersion do MESMO rawContentId com number: 1, mantendo a 1ª intacta', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const first = await testPrisma.contentVersion.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        number: 1,
        legislativeClosureDate: new Date('2026-09-01T00:00:00.000Z'),
        contentSnapshot: { rawText: 'x' },
      },
    });

    // Oráculo é o PAR comportamental (rejeita + 1ª linha sobrevive), nunca
    // `err.code` do Prisma como oráculo primário — mesma cautela da lição
    // ativa "FK onDelete: Restrict no Postgres não gera P2003" (a violação de
    // `@@unique` mapeia para P2002, mas o comportamento observável é o que
    // prova o contrato, não o código do driver).
    await expect(
      testPrisma.contentVersion.create({
        data: {
          rawContentId: rawContent.id,
          authorId: editor.id,
          number: 1,
          legislativeClosureDate: new Date('2026-09-15T00:00:00.000Z'),
          contentSnapshot: { rawText: 'y' },
        },
      }),
    ).rejects.toThrow();

    await expect(
      testPrisma.contentVersion.findUniqueOrThrow({ where: { id: first.id } }),
    ).resolves.toMatchObject({
      rawContentId: rawContent.id,
      number: 1,
      contentSnapshot: { rawText: 'x' },
    });
  });
});

describe('ProductionStageEvent — valor aditivo VERSAO_EDITORIAL gravável na mesma sessão da migração', () => {
  it('grava e lê stageType: VERSAO_EDITORIAL logo após a migração ter aplicado o ADD VALUE', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const created = await testPrisma.productionStageEvent.create({
      data: {
        rawContentId: rawContent.id,
        stageType: 'VERSAO_EDITORIAL',
        transitionType: 'CONCLUSAO',
        actorId: editor.id,
      },
    });

    const read = await testPrisma.productionStageEvent.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(read.stageType).toBe('VERSAO_EDITORIAL');
    expect(read.transitionType).toBe('CONCLUSAO');
  });
});
