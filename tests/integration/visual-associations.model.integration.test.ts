import {
  addMnemonicFrame,
  openMnemonicStrip,
  removeMnemonicFrame,
} from '../../src/modules/tira/tira.service';
import {
  createRawContent,
  createTopic,
  createUser,
  seedRuleBreakdown,
} from '../support/production-events-fixtures';
import { actorOf, createVisualAssociation } from '../support/visual-association-fixtures';
import { closeTestDb, Prisma, resetDb, testPrisma } from './db';

/**
 * `VisualAssociation` / `VisualAssociationLinkEvent` — prova de contrato do
 * schema (TASK-023-001 / COMP-023-004), sem passar por
 * `visual-associations.service.ts` (ainda inexistente, TASK-023-005 em
 * diante). Grava/lê direto via `testPrisma`, mesmo molde de
 * `production-events.model.integration.test.ts`.
 */

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('VisualAssociation — FK SetNull de MnemonicFrame.visualAssociationId (AC-022-017)', () => {
  it('remover o Quadro vinculado preserva a associação no acervo (removeMnemonicFrame conclui sem bloqueio)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const actor = actorOf(editor);

    await openMnemonicStrip(rawContent.id, actor, testPrisma);
    const withExtraFrame = await addMnemonicFrame(
      rawContent.id,
      { text: 'Quadro com associação visual', position: 6 },
      actor,
      testPrisma,
    );
    const frame = withExtraFrame.frames.find((f) => f.text === 'Quadro com associação visual');
    if (frame === undefined) throw new Error('Quadro recém-criado não encontrado na Tira.');

    const association = await createVisualAssociation(editor.id);

    // Vínculo via schema puro (COMP-023-008 ainda não existe, TASK-023-008).
    await testPrisma.mnemonicFrame.update({
      where: { id: frame.id },
      data: { visualAssociationId: association.id },
    });

    // Ato observável: remover o Quadro conclui sem bloqueio.
    await removeMnemonicFrame(rawContent.id, frame.id, actor, testPrisma);

    // A associação sobrevive à remoção do Quadro — a FK é SetNull no lado do
    // Quadro, nunca Cascade/Restrict que a apagaria ou bloquearia a remoção.
    await expect(
      testPrisma.visualAssociation.findUniqueOrThrow({ where: { id: association.id } }),
    ).resolves.toMatchObject({ id: association.id });
  });
});

describe('VisualAssociation.author — FK Restrict recusa hard-delete do autor', () => {
  it('rejeita o delete do autor e a VisualAssociation sobrevive (par comportamental — nunca err.code como asserção primária)', async () => {
    const author = await createUser('EDITOR');
    const association = await createVisualAssociation(author.id);

    try {
      await testPrisma.user.delete({ where: { id: author.id } });
      throw new Error('esperava rejeição, mas o delete resolveu');
    } catch (err) {
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const knownErr = err as Prisma.PrismaClientKnownRequestError;
      // FK `Restrict` é não-adiável e viola SQLSTATE 23001, que o adapter-pg
      // não mapeia (só 23502/23503/23505) — cai no genérico P2039, não P2003
      // (mesmo comportamento documentado em production-events.model, TASK-010-001).
      // A garantia real e estável do AC é o par abaixo (rejeição + sobrevivência
      // da linha), nunca este código como asserção primária.
      expect(knownErr.code).toBe('P2039');
      expect(knownErr.message).toContain('visual_associations_authorId_fkey');
      expect(knownErr.message).toContain('RESTRICT');
    }

    // O autor nunca foi removido: a violação de RESTRICT reverte a instrução
    // inteira, nunca um estado parcial.
    await expect(
      testPrisma.user.findUniqueOrThrow({ where: { id: author.id } }),
    ).resolves.toBeDefined();

    // ...e a VisualAssociation em si segue íntegra e alcançável.
    await expect(
      testPrisma.visualAssociation.findUniqueOrThrow({ where: { id: association.id } }),
    ).resolves.toMatchObject({ authorId: author.id });
  });
});

describe('VisualAssociationLinkEvent — sobrevive à remoção da associação referenciada (DEC-023-011/TRISK-023-007)', () => {
  it('a linha do log de reuso permanece legível depois que a VisualAssociation que ela referencia é apagada', async () => {
    const author = await createUser('EDITOR');
    const association = await createVisualAssociation(author.id);

    const event = await testPrisma.visualAssociationLinkEvent.create({
      data: {
        visualAssociationId: association.id,
        wasReuse: false,
      },
    });

    // Confirma a leitura de volta antes de qualquer remoção.
    await expect(
      testPrisma.visualAssociationLinkEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).resolves.toMatchObject({ visualAssociationId: association.id, wasReuse: false });

    // Sem FK (DEC-023-011): apagar a associação referenciada não é bloqueado
    // nem propaga nenhuma alteração à linha do log.
    await testPrisma.visualAssociation.delete({ where: { id: association.id } });

    await expect(
      testPrisma.visualAssociationLinkEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).resolves.toMatchObject({ visualAssociationId: association.id, wasReuse: false });
  });
});
