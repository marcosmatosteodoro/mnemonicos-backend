// Namespace (não named import): espiar `recordProductionStageEvent`
// (NFR-026-005, fail-secure) exige o objeto de módulo para `jest.spyOn` —
// mesmo padrão de `tira.service.integration.test.ts`.
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import type { ContentActor } from '../../src/modules/contents/contents.service';
import {
  createContrast,
  listContrasts,
  removeContrast,
  updateContrast,
} from '../../src/modules/contrasts/contrasts.service';
import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `contrasts.service.ts` (COMP-027-002 / TASK-027-003) sobre o Postgres real
 * (molde `tira.service.integration.test.ts`): CRUD completo, guarda composta
 * (alcance por autoria do `RawContent` pai + autor-ou-ADMIN na escrita),
 * preservação sob soft-delete (NFR-026-004), fail-secure (NFR-026-005) e o
 * eixo POSITIVO de DEC-027-005 (leitura sem filtro por autoria do Contraste).
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

async function seedContrast(rawContentId: string, authorId: string) {
  return testPrisma.contrast.create({
    data: {
      rawContentId,
      authorId,
      confusableText: 'Prescrição tributária.',
      distinctionText: 'Decadência atinge o direito de lançar; prescrição, o de cobrar.',
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('createContrast — persiste com authorId do ator, nunca do input (AC-026-001, DEC-023-012 herdada)', () => {
  it('cria o Contraste com Confundível+distinção preenchidos, authorId = actor.id, e emite exatamente 1 evento MATERIAL_REFORCO', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const created = await createContrast(
      rawContent.id,
      { confusableText: 'Decadência.', distinctionText: 'Prescrição corre após o lançamento.' },
      actorOf(editor),
      testPrisma,
    );

    expect(created.authorId).toBe(editor.id);
    expect(created.rawContentId).toBe(rawContent.id);

    await expect(
      testPrisma.contrast.findUniqueOrThrow({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      authorId: editor.id,
      confusableText: 'Decadência.',
      distinctionText: 'Prescrição corre após o lançamento.',
    });

    const events = await testPrisma.productionStageEvent.findMany({
      where: { rawContentId: rawContent.id, stageType: 'MATERIAL_REFORCO' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.transitionType).toBe('ABERTURA');
  });
});

describe('listContrasts — devolve os Contrastes ordenados por createdAt asc (AC-026-001)', () => {
  it('2 Contrastes criados em sequência voltam na ordem de criação', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    const first = await createContrast(
      rawContent.id,
      { confusableText: 'Primeiro confundível.', distinctionText: 'Primeira distinção.' },
      actorOf(editor),
      testPrisma,
    );
    const second = await createContrast(
      rawContent.id,
      { confusableText: 'Segundo confundível.', distinctionText: 'Segunda distinção.' },
      actorOf(editor),
      testPrisma,
    );

    const listed = await listContrasts(rawContent.id, actorOf(editor), testPrisma);
    expect(listed.map((contrast) => contrast.id)).toEqual([first.id, second.id]);
  });
});

describe('listContrasts — eixo POSITIVO de DEC-027-005: sem filtro por authorId do Contraste dentro do alcance do RawContent', () => {
  it('RawContent de A com 2 Contrastes (um de A, um de ADMIN) → listContrasts chamado por A devolve AMBOS', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);

    const contrastOfA = await createContrast(
      rawContentOfA.id,
      { confusableText: 'Confundível de A.', distinctionText: 'Distinção de A.' },
      actorOf(editorA),
      testPrisma,
    );
    const contrastOfAdmin = await createContrast(
      rawContentOfA.id,
      { confusableText: 'Confundível do ADMIN.', distinctionText: 'Distinção do ADMIN.' },
      actorOf(admin),
      testPrisma,
    );

    // Falsificável: um filtro acidental por `authorId` adicionado a
    // `listContrasts` no futuro faz este caso reprovar — A deixaria de ver o
    // Contraste registrado pelo ADMIN no MESMO RawContent que ele alcança.
    const listed = await listContrasts(rawContentOfA.id, actorOf(editorA), testPrisma);
    expect(listed.map((contrast) => contrast.id).sort()).toEqual(
      [contrastOfA.id, contrastOfAdmin.id].sort(),
    );
  });
});

describe('Guarda composta — mutação contável por método (decisão 4.139/4.232): B não alcança o RawContent de A', () => {
  it('createContrast: B não cria em rawContentId de A → NotFoundError "Conteúdo bruto não encontrado."; nenhuma linha criada', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);

    const countBefore = await testPrisma.contrast.count({
      where: { rawContentId: rawContentOfA.id },
    });

    const message = await captureMessage(() =>
      createContrast(
        rawContentOfA.id,
        { confusableText: 'Não deveria persistir.', distinctionText: 'Não deveria persistir.' },
        actorOf(editorB),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');

    const countAfter = await testPrisma.contrast.count({
      where: { rawContentId: rawContentOfA.id },
    });
    expect(countAfter).toBe(countBefore);
  });

  it('listContrasts: B não lista os Contrastes de A → NotFoundError "Conteúdo bruto não encontrado."', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedContrast(rawContentOfA.id, editorA.id);

    const message = await captureMessage(() =>
      listContrasts(rawContentOfA.id, actorOf(editorB), testPrisma),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');
  });

  it('updateContrast: B não edita o Contraste de A usando rawContentId/contrastId corretos de A → NotFoundError "Conteúdo bruto não encontrado."; a linha de A permanece intocada', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    const contrastOfA = await seedContrast(rawContentOfA.id, editorA.id);

    const message = await captureMessage(() =>
      updateContrast(
        rawContentOfA.id,
        contrastOfA.id,
        { confusableText: 'Não deveria persistir.', distinctionText: 'Não deveria persistir.' },
        actorOf(editorB),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');

    await expect(
      testPrisma.contrast.findUniqueOrThrow({ where: { id: contrastOfA.id } }),
    ).resolves.toMatchObject({
      confusableText: contrastOfA.confusableText,
      distinctionText: contrastOfA.distinctionText,
    });
  });

  it('removeContrast: B não remove o Contraste de A usando rawContentId/contrastId corretos de A → NotFoundError "Conteúdo bruto não encontrado."; a linha de A permanece intocada', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    const contrastOfA = await seedContrast(rawContentOfA.id, editorA.id);

    const message = await captureMessage(() =>
      removeContrast(rawContentOfA.id, contrastOfA.id, actorOf(editorB), testPrisma),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');

    await expect(
      testPrisma.contrast.findUniqueOrThrow({ where: { id: contrastOfA.id } }),
    ).resolves.toBeTruthy();

    const rawContentAfter = await testPrisma.rawContent.findUniqueOrThrow({
      where: { id: rawContentOfA.id },
    });
    expect(rawContentAfter.deletedAt).toBeNull();
  });
});

describe('Guarda composta — 5º caso (autor-ou-ADMIN): EDITOR C alcança o MESMO RawContent de A mas não é o autor do Contraste', () => {
  // DEC-027-005: `assertRawContentReachable` só deixa um EDITOR não-ADMIN
  // alcançar o PRÓPRIO RawContent — por isso "C alcança o MESMO RawContent
  // de A" só é realizável quando C É o dono do RawContent (aqui, `editorA`);
  // o "A" da guarda autor-ou-ADMIN, nesta descrição, é quem AUTOROU o
  // Contraste (o ADMIN, no seed abaixo) — um ator distinto do dono do
  // RawContent. `editorA` desempenha o papel de "C" do critério de pronto:
  // alcança o pai, mas não é autor DESTE Contraste específico.
  it('updateContrast: dono do RawContent, não-autor do Contraste → ForbiddenError; ADMIN, no mesmo cenário, edita com sucesso', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    // Contraste no RawContent de A, criado por outro ator (ADMIN) — A alcança
    // o RawContent (é o dono), mas não é o autor DESTE Contraste.
    const contrastOfAdmin = await seedContrast(rawContentOfA.id, admin.id);

    const messageForNonAuthor = await captureMessage(() =>
      updateContrast(
        rawContentOfA.id,
        contrastOfAdmin.id,
        { confusableText: 'Não deveria persistir.', distinctionText: 'Não deveria persistir.' },
        actorOf(editorA),
        testPrisma,
      ),
    );
    expect(messageForNonAuthor).toBe('Você não tem permissão para alterar este contraste.');

    const untouched = await testPrisma.contrast.findUniqueOrThrow({
      where: { id: contrastOfAdmin.id },
    });
    expect(untouched.confusableText).toBe(contrastOfAdmin.confusableText);

    const updatedByAdmin = await updateContrast(
      rawContentOfA.id,
      contrastOfAdmin.id,
      { confusableText: 'Editado pelo ADMIN.', distinctionText: 'Distinção editada.' },
      actorOf(admin),
      testPrisma,
    );
    expect(updatedByAdmin.confusableText).toBe('Editado pelo ADMIN.');
  });

  it('removeContrast: dono do RawContent, não-autor do Contraste → ForbiddenError; ADMIN, no mesmo cenário, remove com sucesso', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    const contrastOfAdmin = await seedContrast(rawContentOfA.id, admin.id);

    const messageForNonAuthor = await captureMessage(() =>
      removeContrast(rawContentOfA.id, contrastOfAdmin.id, actorOf(editorA), testPrisma),
    );
    expect(messageForNonAuthor).toBe('Você não tem permissão para remover este contraste.');

    await expect(
      testPrisma.contrast.findUniqueOrThrow({ where: { id: contrastOfAdmin.id } }),
    ).resolves.toBeTruthy();

    await removeContrast(rawContentOfA.id, contrastOfAdmin.id, actorOf(admin), testPrisma);

    await expect(
      testPrisma.contrast.findUnique({ where: { id: contrastOfAdmin.id } }),
    ).resolves.toBeNull();
  });
});

describe('Preservação sob soft-delete do RawContent titular (AC-026-003, NFR-026-004)', () => {
  it('createContrast recusa sobre RawContent soft-deleted, nenhuma linha criada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { deletedAt: new Date() },
    });

    const countBefore = await testPrisma.contrast.count({ where: { rawContentId: rawContent.id } });

    const message = await captureMessage(() =>
      createContrast(
        rawContent.id,
        { confusableText: 'Não deveria persistir.', distinctionText: 'Não deveria persistir.' },
        actorOf(editor),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto foi removido.');

    const countAfter = await testPrisma.contrast.count({ where: { rawContentId: rawContent.id } });
    expect(countAfter).toBe(countBefore);
  });

  it('listContrasts/updateContrast/removeContrast recusam sobre um Contraste JÁ EXISTENTE cujo RawContent foi soft-deleted; a linha do Contraste permanece no banco (leitura direta fora do service)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const contrast = await seedContrast(rawContent.id, editor.id);

    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { deletedAt: new Date() },
    });

    await expect(listContrasts(rawContent.id, actorOf(editor), testPrisma)).rejects.toThrow(
      'Conteúdo bruto foi removido.',
    );
    await expect(
      updateContrast(
        rawContent.id,
        contrast.id,
        { confusableText: 'Não deveria persistir.', distinctionText: 'Não deveria persistir.' },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('Conteúdo bruto foi removido.');
    await expect(
      removeContrast(rawContent.id, contrast.id, actorOf(editor), testPrisma),
    ).rejects.toThrow('Conteúdo bruto foi removido.');

    // Preservada para expurgo futuro — nunca excluída fisicamente pela
    // remoção do pai (NFR-026-004).
    const preserved = await testPrisma.contrast.findUnique({ where: { id: contrast.id } });
    expect(preserved).not.toBeNull();
    expect(preserved?.confusableText).toBe(contrast.confusableText);
  });
});

describe('removeContrast — DELETE físico do Contraste, RawContent titular intocado (AC-026-004, FR-026-006)', () => {
  it('remove a linha do Contraste (findUnique subsequente devolve null) sem afetar o RawContent titular', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const contrast = await seedContrast(rawContent.id, editor.id);

    await removeContrast(rawContent.id, contrast.id, actorOf(editor), testPrisma);

    await expect(
      testPrisma.contrast.findUnique({ where: { id: contrast.id } }),
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

  it('createContrast: recordProductionStageEvent rejeitando → createContrast rejeita; nenhuma linha criada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    const countBefore = await testPrisma.contrast.count({ where: { rawContentId: rawContent.id } });

    await expect(
      createContrast(
        rawContent.id,
        { confusableText: 'Não deveria persistir.', distinctionText: 'Não deveria persistir.' },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('falha simulada na emissão');

    const countAfter = await testPrisma.contrast.count({ where: { rawContentId: rawContent.id } });
    expect(countAfter).toBe(countBefore);
  });

  it('updateContrast: recordProductionStageEvent rejeitando → updateContrast rejeita; o texto permanece o de ANTES da tentativa', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const contrast = await seedContrast(rawContent.id, editor.id);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(
      updateContrast(
        rawContent.id,
        contrast.id,
        { confusableText: 'Não deveria persistir.', distinctionText: 'Não deveria persistir.' },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('falha simulada na emissão');

    const persisted = await testPrisma.contrast.findUniqueOrThrow({ where: { id: contrast.id } });
    expect(persisted.confusableText).toBe(contrast.confusableText);
    expect(persisted.distinctionText).toBe(contrast.distinctionText);
  });

  it('removeContrast: recordProductionStageEvent rejeitando → removeContrast rejeita; a linha permanece', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const contrast = await seedContrast(rawContent.id, editor.id);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(
      removeContrast(rawContent.id, contrast.id, actorOf(editor), testPrisma),
    ).rejects.toThrow('falha simulada na emissão');

    await expect(
      testPrisma.contrast.findUniqueOrThrow({ where: { id: contrast.id } }),
    ).resolves.toBeTruthy();
  });
});
