// Namespace (não named import): espiar `recordProductionStageEvent`
// (NFR-026-005, fail-secure) exige o objeto de módulo para `jest.spyOn` —
// mesmo padrão de `contrasts.service.integration.test.ts`.
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import type { ContentActor } from '../../src/modules/contents/contents.service';
import {
  createFlashcard,
  listFlashcards,
  removeFlashcard,
  updateFlashcard,
} from '../../src/modules/flashcards/flashcards.service';
import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `flashcards.service.ts` (COMP-027-011 / TASK-027-004) sobre o Postgres real
 * (molde `contrasts.service.integration.test.ts`): CRUD completo, guarda
 * composta (alcance por autoria do `RawContent` pai + autor-ou-ADMIN na
 * escrita), preservação sob soft-delete (NFR-026-004), fail-secure
 * (NFR-026-005) e o eixo POSITIVO de DEC-027-005 (leitura sem filtro por
 * autoria do Flashcard).
 */

function actorOf(user: { id: string; role: 'EDITOR' | 'ADMIN' | 'STUDENT' }): ContentActor {
  return { id: user.id, role: user.role };
}

/** Captura a mensagem de um erro esperado, para comparação literal entre recusas. */
async function captureMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('esperava rejeição, mas a chamada resolveu');
}

async function seedFlashcard(rawContentId: string, authorId: string) {
  return testPrisma.productionFlashcard.create({
    data: {
      rawContentId,
      authorId,
      question: 'Qual o prazo decadencial do lançamento tributário?',
      answer: '5 anos, contados na forma do art. 173 do CTN.',
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('createFlashcard — persiste com authorId do ator, nunca do input (AC-026-008, DEC-023-012 herdada)', () => {
  it('cria o Flashcard com pergunta+resposta preenchidas, authorId = actor.id, e emite exatamente 1 evento MATERIAL_REFORCO', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const created = await createFlashcard(
      rawContent.id,
      { question: 'Pergunta.', answer: 'Resposta.' },
      actorOf(editor),
      testPrisma,
    );

    expect(created.authorId).toBe(editor.id);
    expect(created.rawContentId).toBe(rawContent.id);

    await expect(
      testPrisma.productionFlashcard.findUniqueOrThrow({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      authorId: editor.id,
      question: 'Pergunta.',
      answer: 'Resposta.',
    });

    const events = await testPrisma.productionStageEvent.findMany({
      where: { rawContentId: rawContent.id, stageType: 'MATERIAL_REFORCO' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.transitionType).toBe('ABERTURA');
  });
});

describe('listFlashcards — devolve os Flashcards ordenados por createdAt asc (AC-026-008)', () => {
  it('2 Flashcards criados em sequência voltam na ordem de criação', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const first = await createFlashcard(
      rawContent.id,
      { question: 'Primeira pergunta.', answer: 'Primeira resposta.' },
      actorOf(editor),
      testPrisma,
    );
    const second = await createFlashcard(
      rawContent.id,
      { question: 'Segunda pergunta.', answer: 'Segunda resposta.' },
      actorOf(editor),
      testPrisma,
    );

    const listed = await listFlashcards(rawContent.id, actorOf(editor), testPrisma);
    expect(listed.map((flashcard) => flashcard.id)).toEqual([first.id, second.id]);
  });
});

describe('listFlashcards — eixo POSITIVO de DEC-027-005: sem filtro por authorId do Flashcard dentro do alcance do RawContent', () => {
  it('RawContent de A com 2 Flashcards (um de A, um de ADMIN) → listFlashcards chamado por A devolve AMBOS', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);

    const flashcardOfA = await createFlashcard(
      rawContentOfA.id,
      { question: 'Pergunta de A.', answer: 'Resposta de A.' },
      actorOf(editorA),
      testPrisma,
    );
    const flashcardOfAdmin = await createFlashcard(
      rawContentOfA.id,
      { question: 'Pergunta do ADMIN.', answer: 'Resposta do ADMIN.' },
      actorOf(admin),
      testPrisma,
    );

    // Falsificável: um filtro acidental por `authorId` adicionado a
    // `listFlashcards` no futuro faz este caso reprovar — A deixaria de ver o
    // Flashcard registrado pelo ADMIN no MESMO RawContent que ele alcança.
    const listed = await listFlashcards(rawContentOfA.id, actorOf(editorA), testPrisma);
    expect(listed.map((flashcard) => flashcard.id).sort()).toEqual(
      [flashcardOfA.id, flashcardOfAdmin.id].sort(),
    );
  });
});

describe('Guarda composta — mutação contável por método (decisão 4.139/4.232): B não alcança o RawContent de A', () => {
  it('createFlashcard: B não cria em rawContentId de A → NotFoundError "Conteúdo bruto não encontrado."; nenhuma linha criada', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);

    const countBefore = await testPrisma.productionFlashcard.count({
      where: { rawContentId: rawContentOfA.id },
    });

    const message = await captureMessage(() =>
      createFlashcard(
        rawContentOfA.id,
        { question: 'Não deveria persistir.', answer: 'Não deveria persistir.' },
        actorOf(editorB),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');

    const countAfter = await testPrisma.productionFlashcard.count({
      where: { rawContentId: rawContentOfA.id },
    });
    expect(countAfter).toBe(countBefore);
  });

  it('listFlashcards: B não lista os Flashcards de A → NotFoundError "Conteúdo bruto não encontrado."', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedFlashcard(rawContentOfA.id, editorA.id);

    const message = await captureMessage(() =>
      listFlashcards(rawContentOfA.id, actorOf(editorB), testPrisma),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');
  });

  it('updateFlashcard: B não edita o Flashcard de A usando rawContentId/flashcardId corretos de A → NotFoundError "Conteúdo bruto não encontrado."; a linha de A permanece intocada', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    const flashcardOfA = await seedFlashcard(rawContentOfA.id, editorA.id);

    const message = await captureMessage(() =>
      updateFlashcard(
        rawContentOfA.id,
        flashcardOfA.id,
        { question: 'Não deveria persistir.', answer: 'Não deveria persistir.' },
        actorOf(editorB),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');

    await expect(
      testPrisma.productionFlashcard.findUniqueOrThrow({ where: { id: flashcardOfA.id } }),
    ).resolves.toMatchObject({
      question: flashcardOfA.question,
      answer: flashcardOfA.answer,
    });
  });

  it('removeFlashcard: B não remove o Flashcard de A usando rawContentId/flashcardId corretos de A → NotFoundError "Conteúdo bruto não encontrado."; a linha de A permanece intocada', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    const flashcardOfA = await seedFlashcard(rawContentOfA.id, editorA.id);

    const message = await captureMessage(() =>
      removeFlashcard(rawContentOfA.id, flashcardOfA.id, actorOf(editorB), testPrisma),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');

    await expect(
      testPrisma.productionFlashcard.findUniqueOrThrow({ where: { id: flashcardOfA.id } }),
    ).resolves.toBeTruthy();

    const rawContentAfter = await testPrisma.rawContent.findUniqueOrThrow({
      where: { id: rawContentOfA.id },
    });
    expect(rawContentAfter.deletedAt).toBeNull();
  });
});

describe('Guarda composta — 5º caso (autor-ou-ADMIN): EDITOR C alcança o MESMO RawContent de A mas não é o autor do Flashcard', () => {
  // DEC-027-005: `assertRawContentReachable` só deixa um EDITOR não-ADMIN
  // alcançar o PRÓPRIO RawContent — por isso "C alcança o MESMO RawContent
  // de A" só é realizável quando C É o dono do RawContent (aqui, `editorA`);
  // o "A" da guarda autor-ou-ADMIN, nesta descrição, é quem AUTOROU o
  // Flashcard (o ADMIN, no seed abaixo) — um ator distinto do dono do
  // RawContent. `editorA` desempenha o papel de "C" do critério de pronto:
  // alcança o pai, mas não é autor DESTE Flashcard específico.
  it('updateFlashcard: dono do RawContent, não-autor do Flashcard → ForbiddenError; ADMIN, no mesmo cenário, edita com sucesso', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    // Flashcard no RawContent de A, criado por outro ator (ADMIN) — A alcança
    // o RawContent (é o dono), mas não é o autor DESTE Flashcard.
    const flashcardOfAdmin = await seedFlashcard(rawContentOfA.id, admin.id);

    const messageForNonAuthor = await captureMessage(() =>
      updateFlashcard(
        rawContentOfA.id,
        flashcardOfAdmin.id,
        { question: 'Não deveria persistir.', answer: 'Não deveria persistir.' },
        actorOf(editorA),
        testPrisma,
      ),
    );
    expect(messageForNonAuthor).toBe('Você não tem permissão para alterar este flashcard.');

    const untouched = await testPrisma.productionFlashcard.findUniqueOrThrow({
      where: { id: flashcardOfAdmin.id },
    });
    expect(untouched.question).toBe(flashcardOfAdmin.question);

    const updatedByAdmin = await updateFlashcard(
      rawContentOfA.id,
      flashcardOfAdmin.id,
      { question: 'Editado pelo ADMIN.', answer: 'Resposta editada.' },
      actorOf(admin),
      testPrisma,
    );
    expect(updatedByAdmin.question).toBe('Editado pelo ADMIN.');
  });

  it('removeFlashcard: dono do RawContent, não-autor do Flashcard → ForbiddenError; ADMIN, no mesmo cenário, remove com sucesso', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    const flashcardOfAdmin = await seedFlashcard(rawContentOfA.id, admin.id);

    const messageForNonAuthor = await captureMessage(() =>
      removeFlashcard(rawContentOfA.id, flashcardOfAdmin.id, actorOf(editorA), testPrisma),
    );
    expect(messageForNonAuthor).toBe('Você não tem permissão para remover este flashcard.');

    await expect(
      testPrisma.productionFlashcard.findUniqueOrThrow({ where: { id: flashcardOfAdmin.id } }),
    ).resolves.toBeTruthy();

    await removeFlashcard(rawContentOfA.id, flashcardOfAdmin.id, actorOf(admin), testPrisma);

    await expect(
      testPrisma.productionFlashcard.findUnique({ where: { id: flashcardOfAdmin.id } }),
    ).resolves.toBeNull();
  });
});

describe('Preservação sob soft-delete do RawContent titular (AC-026-011, NFR-026-004)', () => {
  it('createFlashcard recusa sobre RawContent soft-deleted, nenhuma linha criada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { deletedAt: new Date() },
    });

    const countBefore = await testPrisma.productionFlashcard.count({
      where: { rawContentId: rawContent.id },
    });

    const message = await captureMessage(() =>
      createFlashcard(
        rawContent.id,
        { question: 'Não deveria persistir.', answer: 'Não deveria persistir.' },
        actorOf(editor),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto foi removido.');

    const countAfter = await testPrisma.productionFlashcard.count({
      where: { rawContentId: rawContent.id },
    });
    expect(countAfter).toBe(countBefore);
  });

  it('listFlashcards/updateFlashcard/removeFlashcard recusam sobre um Flashcard JÁ EXISTENTE cujo RawContent foi soft-deleted; a linha do Flashcard permanece no banco (leitura direta fora do service)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const flashcard = await seedFlashcard(rawContent.id, editor.id);

    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { deletedAt: new Date() },
    });

    await expect(listFlashcards(rawContent.id, actorOf(editor), testPrisma)).rejects.toThrow(
      'Conteúdo bruto foi removido.',
    );
    await expect(
      updateFlashcard(
        rawContent.id,
        flashcard.id,
        { question: 'Não deveria persistir.', answer: 'Não deveria persistir.' },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('Conteúdo bruto foi removido.');
    await expect(
      removeFlashcard(rawContent.id, flashcard.id, actorOf(editor), testPrisma),
    ).rejects.toThrow('Conteúdo bruto foi removido.');

    // Preservada para expurgo futuro — nunca excluída fisicamente pela
    // remoção do pai (NFR-026-004).
    const preserved = await testPrisma.productionFlashcard.findUnique({
      where: { id: flashcard.id },
    });
    expect(preserved).not.toBeNull();
    expect(preserved?.question).toBe(flashcard.question);
  });
});

describe('removeFlashcard — DELETE físico do Flashcard, RawContent titular intocado (AC-026-010, FR-026-018)', () => {
  it('remove a linha do Flashcard (findUnique subsequente devolve null) sem afetar o RawContent titular', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const flashcard = await seedFlashcard(rawContent.id, editor.id);

    await removeFlashcard(rawContent.id, flashcard.id, actorOf(editor), testPrisma);

    await expect(
      testPrisma.productionFlashcard.findUnique({ where: { id: flashcard.id } }),
    ).resolves.toBeNull();

    const rawContentAfter = await testPrisma.rawContent.findUniqueOrThrow({
      where: { id: rawContent.id },
    });
    expect(rawContentAfter.deletedAt).toBeNull();
  });
});

describe('Fail-secure: falha na emissão do evento reverte a transação inteira (NFR-026-005)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('createFlashcard: recordProductionStageEvent rejeitando → createFlashcard rejeita; nenhuma linha criada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    const countBefore = await testPrisma.productionFlashcard.count({
      where: { rawContentId: rawContent.id },
    });

    await expect(
      createFlashcard(
        rawContent.id,
        { question: 'Não deveria persistir.', answer: 'Não deveria persistir.' },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('falha simulada na emissão');

    const countAfter = await testPrisma.productionFlashcard.count({
      where: { rawContentId: rawContent.id },
    });
    expect(countAfter).toBe(countBefore);
  });

  it('updateFlashcard: recordProductionStageEvent rejeitando → updateFlashcard rejeita; o texto permanece o de ANTES da tentativa', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const flashcard = await seedFlashcard(rawContent.id, editor.id);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(
      updateFlashcard(
        rawContent.id,
        flashcard.id,
        { question: 'Não deveria persistir.', answer: 'Não deveria persistir.' },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('falha simulada na emissão');

    const persisted = await testPrisma.productionFlashcard.findUniqueOrThrow({
      where: { id: flashcard.id },
    });
    expect(persisted.question).toBe(flashcard.question);
    expect(persisted.answer).toBe(flashcard.answer);
  });

  it('removeFlashcard: recordProductionStageEvent rejeitando → removeFlashcard rejeita; a linha permanece', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const flashcard = await seedFlashcard(rawContent.id, editor.id);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(
      removeFlashcard(rawContent.id, flashcard.id, actorOf(editor), testPrisma),
    ).rejects.toThrow('falha simulada na emissão');

    await expect(
      testPrisma.productionFlashcard.findUniqueOrThrow({ where: { id: flashcard.id } }),
    ).resolves.toBeTruthy();
  });
});
