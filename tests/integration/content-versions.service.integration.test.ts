// Namespace (não named import): espiar `recordProductionStageEvent`
// (NFR-028-002, fail-secure) exige o objeto de módulo para `jest.spyOn` —
// mesmo padrão de `contrasts.service.integration.test.ts`.
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import type { ContentActor } from '../../src/modules/contents/contents.service';
import {
  closeContentVersion,
  listContentVersions,
} from '../../src/modules/content-versions/content-versions.service';
import {
  createRawContent,
  createTopic,
  createUser,
  seedRuleBreakdown,
} from '../support/production-events-fixtures';
import { withQueryProbe } from '../support/query-probe';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `content-versions.service.ts` (COMP-029-004/005 / TASK-029-002) sobre o
 * Postgres real (molde `contrasts.service.integration.test.ts`): guarda
 * composta (lock do pai + alcance por autoria + autor-ou-ADMIN + RuleBreakdown
 * obrigatória), imutabilidade das Versões anteriores, fail-secure, corrida
 * real de numeração e custo fixo da leitura (NFR-028-003).
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

async function seedElegibleRawContent(authorId: string, topicId: string) {
  const rawContent = await createRawContent(authorId, topicId);
  await seedRuleBreakdown(rawContent.id);
  return rawContent;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('AC-028-001 (FR-028-001, FR-028-005 — parte backend): 1ª Versão fechada pelo autor', () => {
  it('devolve Versão number:1 com authorId/closedAt/a data informada; listContentVersions devolve essa Versão', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);

    const created = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    expect(created.number).toBe(1);
    expect(created.rawContentId).toBe(rawContent.id);
    expect(created.authorId).toBe(editor.id);
    expect(created.legislativeClosureDate.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(created.closedAt).toBeInstanceOf(Date);

    const listed = await listContentVersions(rawContent.id, actorOf(editor), testPrisma);
    expect(listed.map((version) => version.id)).toEqual([created.id]);
  });
});

describe('AC-028-002 (FR-028-001): ADMIN fecha a 3ª Versão sobre 2 já fechadas — as 2 anteriores permanecem INTOCADAS', () => {
  it('a nova Versão recebe number:3; as 2 anteriores mantêm todos os campos e o contentSnapshot de antes', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);

    const first = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-08-01' },
      actorOf(editor),
      testPrisma,
    );
    const second = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-08-15' },
      actorOf(editor),
      testPrisma,
    );
    const firstRow = await testPrisma.contentVersion.findUniqueOrThrow({
      where: { id: first.id },
    });
    const secondRow = await testPrisma.contentVersion.findUniqueOrThrow({
      where: { id: second.id },
    });

    const third = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(admin),
      testPrisma,
    );
    expect(third.number).toBe(3);

    const firstAfter = await testPrisma.contentVersion.findUniqueOrThrow({
      where: { id: first.id },
    });
    const secondAfter = await testPrisma.contentVersion.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(firstAfter).toEqual(firstRow);
    expect(secondAfter).toEqual(secondRow);
  });
});

describe('Guarda composta — mutação contável por método (decisão 4.139/4.232): B não alcança o RawContent de A', () => {
  it('closeContentVersion: B não fecha Versão no rawContentId de A → NotFoundError "Conteúdo bruto não encontrado."; nenhuma ContentVersion criada', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await seedElegibleRawContent(editorA.id, topicId);

    const countBefore = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContentOfA.id },
    });

    const message = await captureMessage(() =>
      closeContentVersion(
        rawContentOfA.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editorB),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');

    const countAfter = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContentOfA.id },
    });
    expect(countAfter).toBe(countBefore);
  });

  it('listContentVersions: B não lê o histórico do rawContentId de A → NotFoundError "Conteúdo bruto não encontrado."; nenhum item devolvido', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await seedElegibleRawContent(editorA.id, topicId);
    await closeContentVersion(
      rawContentOfA.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editorA),
      testPrisma,
    );

    const message = await captureMessage(() =>
      listContentVersions(rawContentOfA.id, actorOf(editorB), testPrisma),
    );
    expect(message).toBe('Conteúdo bruto não encontrado.');
  });
});

describe('AC-028-003 (FR-028-002, NFR-028-001, NFR-028-002) — recusa da mensagem de B IGUAL, por igualdade literal, à recusa de um rawContentId aleatório inexistente', () => {
  it('mensagem de B (existe, não é seu) === mensagem de um id aleatório (não existe) — nunca distingue os dois casos', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await seedElegibleRawContent(editorA.id, topicId);
    const randomId = '00000000-0000-4000-8000-000000000000';

    const messageForOtherAuthor = await captureMessage(() =>
      closeContentVersion(
        rawContentOfA.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editorB),
        testPrisma,
      ),
    );
    const messageForRandomId = await captureMessage(() =>
      closeContentVersion(
        randomId,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editorB),
        testPrisma,
      ),
    );

    expect(messageForOtherAuthor).toBe(messageForRandomId);
  });
});

describe('AC-028-004 (FR-028-003): RawContent alcançável SEM RuleBreakdown salva', () => {
  it('recusa com NotFoundError "Quebra da regra precisa existir antes do fechamento."; nenhuma ContentVersion criada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId); // sem seedRuleBreakdown

    const countBefore = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContent.id },
    });

    const message = await captureMessage(() =>
      closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editor),
        testPrisma,
      ),
    );
    expect(message).toBe('Quebra da regra precisa existir antes do fechamento.');

    const countAfter = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContent.id },
    });
    expect(countAfter).toBe(countBefore);
  });
});

describe('AC-028-005 (FR-028-003): RawContent do próprio autor, soft-deleted', () => {
  it('recusa com NotFoundError "Conteúdo bruto foi removido."; nenhuma ContentVersion criada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { deletedAt: new Date() },
    });

    const countBefore = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContent.id },
    });

    const message = await captureMessage(() =>
      closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editor),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto foi removido.');

    const countAfter = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContent.id },
    });
    expect(countAfter).toBe(countBefore);
  });
});

describe('listContentVersions — eixo POSITIVO de DEC-029-002: sem filtro por authorId da Versão dentro do alcance do RawContent', () => {
  it('RawContent de A com 2 Versões (1 do próprio A, 1 de um ADMIN) → listContentVersions chamado por A devolve AMBAS, em ordem de number asc', async () => {
    const editorA = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentOfA = await seedElegibleRawContent(editorA.id, topicId);

    const byA = await closeContentVersion(
      rawContentOfA.id,
      { legislativeClosureDate: '2026-08-01' },
      actorOf(editorA),
      testPrisma,
    );
    const byAdmin = await closeContentVersion(
      rawContentOfA.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(admin),
      testPrisma,
    );

    // Falsificável: um filtro acidental por `authorId` da Versão adicionado
    // no futuro faz este caso reprovar — A deixaria de ver a Versão fechada
    // pelo ADMIN no MESMO RawContent que ele alcança.
    const listed = await listContentVersions(rawContentOfA.id, actorOf(editorA), testPrisma);
    expect(listed.map((version) => version.id)).toEqual([byA.id, byAdmin.id]);
  });
});

describe('AC-028-008 (FR-028-007) e DEC-029-005: evento de etapa VERSAO_EDITORIAL sempre CONCLUSAO, mesmo na 1ª chamada do par', () => {
  it('1º fechamento de Versão registra exatamente 1 evento VERSAO_EDITORIAL/CONCLUSAO (nunca ABERTURA)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);

    await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const events = await productionEventsService.listProductionStageEvents(
      rawContent.id,
      testPrisma,
    );
    const versaoEvents = events.filter((event) => event.stageType === 'VERSAO_EDITORIAL');
    // Falsificável: se recordProductionStageEvent ignorasse o override e
    // decidisse por decideStageTransition, a 1ª chamada seria ABERTURA (0
    // eventos prévios do par) — esta asserção reprovaria.
    expect(versaoEvents).toHaveLength(1);
    expect(versaoEvents[0]?.transitionType).toBe('CONCLUSAO');
  });
});

describe('NFR-028-001/002 (fail-secure): falha na emissão do evento reverte a transação inteira', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recordProductionStageEvent rejeitando → closeContentVersion rejeita; nenhuma ContentVersion criada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    const countBefore = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContent.id },
    });

    await expect(
      closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('falha simulada na emissão');

    const countAfter = await testPrisma.contentVersion.count({
      where: { rawContentId: rawContent.id },
    });
    expect(countAfter).toBe(countBefore);
  });
});

/**
 * Corrida de numeração — prova de CONCORRÊNCIA REAL (lição ativa "[Segurança]
 * Corrida (TOCTOU) só se fecha com prova de CONCORRÊNCIA real contando linhas
 * no fim; prova estrutural ou caso sequencial nunca fecha", DEC-029-004).
 * Mutante do critério: confiar só na constraint `@@unique` sem o lock de
 * linha do pai deixaria uma janela onde as 2 transações leem o MESMO
 * `number` antes de qualquer INSERT — produzindo 2 Versões `number: 1` (ou
 * erro de unicidade vazando ao chamador).
 */
describe('closeContentVersion — corrida de numeração, concorrência REAL (DEC-029-004)', () => {
  it('2 chamadas para o MESMO rawContentId disparadas em paralelo (Promise.all) → exatamente 2 ContentVersions com number 1 e 2', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);

    const [resultA, resultB] = await Promise.all([
      closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editor),
        testPrisma,
      ),
      closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-02' },
        actorOf(editor),
        testPrisma,
      ),
    ]);

    expect([resultA.number, resultB.number].sort()).toEqual([1, 2]);

    const versions = await testPrisma.contentVersion.findMany({
      where: { rawContentId: rawContent.id },
    });
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.number).sort()).toEqual([1, 2]);
  });
});

/**
 * NFR-028-003/AC-028-012 — medição real via `withQueryProbe`
 * (`tests/support/query-probe.ts`): custo de `listContentVersions` depende só
 * de N (Versões daquele RawContent), nunca do acervo inteiro. Falsificável:
 * uma implementação que iterasse e buscasse cada Versão em loop produziria
 * N+1 statements — cresceria com N.
 */
describe('listContentVersions — custo fixo de round-trips, independente de N (NFR-028-003/AC-028-012)', () => {
  it('RawContent com 5 Versões fechadas → exatamente 2 statements (guarda de alcance + findMany), nenhum round-trip por Versão', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);

    for (let i = 0; i < 5; i += 1) {
      await closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editor),
        testPrisma,
      );
    }

    const queries = await withQueryProbe((probe) =>
      listContentVersions(rawContent.id, actorOf(editor), probe),
    );

    // 2 statements, medidos: assertRawContentReachable (1 SELECT do
    // RawContent, guarda de alcance) + contentVersion.findMany (1 SELECT
    // filtrado por rawContentId, servido pelo índice único) — nenhum dos 2
    // cresce com N (5 Versões fechadas não produzem 5 statements).
    expect(queries).toHaveLength(2);
  });
});
