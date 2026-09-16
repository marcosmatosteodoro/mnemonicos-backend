import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `Contrast` / `ProductionFlashcard` / `RawContent.pegadinhaText` / valor
 * aditivo `MATERIAL_REFORCO` — prova de contrato do schema (TASK-027-001),
 * sem passar por nenhum service (nascem em TASK-027-003/004/005). Grava/lê
 * direto via `testPrisma`, mesmo molde de
 * `production-events.model.integration.test.ts`/
 * `visual-associations.model.integration.test.ts`.
 */

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('Contrast / ProductionFlashcard — criados e lidos de volta vinculados a RawContent/autor', () => {
  it('cria 1 Contrast e 1 ProductionFlashcard vinculados ao mesmo RawContent/autor e lê ambos de volta', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const contrast = await testPrisma.contrast.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        confusableText: 'Decadência tributária.',
        distinctionText: 'Prescrição corre após o lançamento definitivo; decadência, antes dele.',
      },
    });

    const flashcard = await testPrisma.productionFlashcard.create({
      data: {
        rawContentId: rawContent.id,
        authorId: editor.id,
        question: 'O que extingue o direito de lançar o crédito tributário fora do prazo?',
        answer: 'A decadência.',
      },
    });

    // Se `@@map("contrasts")`/`@@map("production_flashcards")` ou alguma das 4
    // FKs `Restrict` novas estivesse errada, o `create` acima já teria
    // rejeitado com erro do Postgres — a leitura de volta é a 2ª metade do
    // contrato (o dado persistido é o dado lido).
    await expect(
      testPrisma.contrast.findUniqueOrThrow({ where: { id: contrast.id } }),
    ).resolves.toMatchObject({
      rawContentId: rawContent.id,
      authorId: editor.id,
      confusableText: 'Decadência tributária.',
      distinctionText: 'Prescrição corre após o lançamento definitivo; decadência, antes dele.',
    });

    await expect(
      testPrisma.productionFlashcard.findUniqueOrThrow({ where: { id: flashcard.id } }),
    ).resolves.toMatchObject({
      rawContentId: rawContent.id,
      authorId: editor.id,
      question: 'O que extingue o direito de lançar o crédito tributário fora do prazo?',
      answer: 'A decadência.',
    });
  });
});

describe('RawContent.pegadinhaText — coluna nova, nasce null nesta wave (TRISK-027-003, DEC-027-002)', () => {
  it('lê pegadinhaText como null direto do RawContent seedado, sem nenhum consumidor de escrita ainda', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    await expect(
      testPrisma.rawContent.findUniqueOrThrow({ where: { id: rawContent.id } }),
    ).resolves.toMatchObject({ pegadinhaText: null });
  });
});

describe('ProductionStageEvent — valor aditivo MATERIAL_REFORCO gravável na mesma sessão da migração (TRISK-027-001, DEC-027-004)', () => {
  it('grava e lê stageType: MATERIAL_REFORCO logo após a migração ter aplicado o ADD VALUE', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const created = await testPrisma.productionStageEvent.create({
      data: {
        rawContentId: rawContent.id,
        stageType: 'MATERIAL_REFORCO',
        transitionType: 'ABERTURA',
        actorId: editor.id,
      },
    });

    const read = await testPrisma.productionStageEvent.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(read.stageType).toBe('MATERIAL_REFORCO');
    expect(read.transitionType).toBe('ABERTURA');
  });
});
