import { softDeleteRawContent } from '../../src/modules/contents/contents.service';
import type { ContentActor } from '../../src/modules/contents/contents.service';
import {
  approveContentVersion,
  closeContentVersion,
} from '../../src/modules/content-versions/content-versions.service';
import type { VersionedContentFields } from '../../src/modules/content-versions/versioned-content-diff';
import {
  listActiveContentsForPanel,
  listCurrentVersionedFieldsForApprovedContents,
  listLatestVersionsForPanel,
  listStageEventsForPanel,
  listTiraPublicationEventsForPanel,
} from '../../src/modules/strategic-panel/strategic-panel.service';
import { seedApprovableRawContent } from '../support/approvable-raw-content-fixtures';
import {
  RAW_CONTENT_TEXT_FIELDS,
  createRawContent,
  createTopic,
  createUser,
  seedRuleBreakdown,
} from '../support/production-events-fixtures';
import { withQueryProbe } from '../support/query-probe';
import { buildVersionedContentFields } from '../support/versioned-content-fields-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `strategic-panel.service.ts` (COMP-035-004/005/006/007, TASK-035-005) sobre o
 * Postgres real (molde `content-versions.service.integration.test.ts`): as 4
 * leituras em lote (Conteúdos ativos, eventos de etapa, Publicações Tira,
 * Versões + campos versionados atuais dos aprovados) que alimentam o cálculo
 * puro (TASK-035-004) — orquestração completa é TASK-035-006.
 */

function actorOf(user: { id: string; role: 'EDITOR' | 'ADMIN' | 'STUDENT' }): ContentActor {
  return { id: user.id, role: user.role };
}

async function seedElegibleRawContent(authorId: string, topicId: string) {
  const rawContent = await createRawContent(authorId, topicId);
  await seedRuleBreakdown(rawContent.id);
  return rawContent;
}

const APPROVE_INPUT = { legalCheckConfirmed: true, pedagogicalCheckConfirmed: true } as const;

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('AC-034-011 (FR-034-014): listActiveContentsForPanel exclui soft-deletado', () => {
  it('2 Conteúdos, 1 soft-deletado → devolve só o ativo', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const active = await seedElegibleRawContent(editor.id, topicId);
    const removed = await seedElegibleRawContent(editor.id, topicId);

    await softDeleteRawContent(removed.id, actorOf(editor), testPrisma);

    const rows = await listActiveContentsForPanel(testPrisma);

    expect(rows.map((row) => row.id)).toEqual([active.id]);
  });
});

describe('Prova de DEC-035-013 (sem AC associado): leitura FACTORY-WIDE, sem filtro por authorId', () => {
  it('2 Conteúdos ATIVOS de autores DIFERENTES → uma única chamada devolve os 2, independente de quem é o autor', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const contentOfA = await seedElegibleRawContent(editorA.id, topicId);
    const contentOfB = await seedElegibleRawContent(editorB.id, topicId);

    // Falsificável: um `scopeWhere(actor)` reintroduzido aqui faria esta
    // chamada devolver só 1 dos 2 (ou nenhum, sem actor) — a função nem
    // recebe actor/authorId como parâmetro de filtro (assinatura de 1
    // parâmetro, `db`).
    const rows = await listActiveContentsForPanel(testPrisma);

    expect(rows.map((row) => row.id).sort()).toEqual([contentOfA.id, contentOfB.id].sort());
  });
});

describe('NFR-034-003 (parte mecanismo): listActiveContentsForPanel nunca expõe rawText/sourceCitation/pegadinhaText', () => {
  it('Object.keys de cada linha devolvida não contém nenhum dos 3 campos', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    await seedElegibleRawContent(editor.id, topicId);

    const rows = await listActiveContentsForPanel(testPrisma);

    expect(rows).not.toHaveLength(0);
    for (const row of rows) {
      const keys = Object.keys(row);
      expect(keys).not.toContain('rawText');
      expect(keys).not.toContain('sourceCitation');
      expect(keys).not.toContain('pegadinhaText');
    }
  });
});

describe('NFR-034-004 (parte mecanismo): listStageEventsForPanel nunca expõe actorId', () => {
  it('Object.keys de cada linha devolvida não contém actorId — checagem sobre o OBJETO REAL devolvido', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);
    await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const rows = await listStageEventsForPanel([rawContent.id], testPrisma);

    expect(rows).not.toHaveLength(0);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('actorId');
    }
  });
});

describe('listTiraPublicationEventsForPanel: só TIRA, com pageCount (incluindo null pré-TASK-035-001)', () => {
  it('2 Conteúdos com Exportações TIRA e RESUMO → devolve só as TIRA, cada uma com o pageCount correto', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const contentWithPageCount = await seedElegibleRawContent(editor.id, topicId);
    const contentWithoutPageCount = await seedElegibleRawContent(editor.id, topicId);

    await testPrisma.publicationEvent.create({
      data: { rawContentId: contentWithPageCount.id, variant: 'TIRA', pageCount: 3 },
    });
    await testPrisma.publicationEvent.create({
      data: { rawContentId: contentWithPageCount.id, variant: 'RESUMO', pageCount: 7 },
    });
    // Exportação TIRA anterior à TASK-035-001 — criada direto no Prisma sem
    // pageCount (coluna nova, `null` = sem medida).
    await testPrisma.publicationEvent.create({
      data: { rawContentId: contentWithoutPageCount.id, variant: 'TIRA' },
    });
    await testPrisma.publicationEvent.create({
      data: { rawContentId: contentWithoutPageCount.id, variant: 'RESUMO', pageCount: 5 },
    });

    const rows = await listTiraPublicationEventsForPanel(
      [contentWithPageCount.id, contentWithoutPageCount.id],
      testPrisma,
    );

    expect(rows).toHaveLength(2);
    const byContentId = new Map(rows.map((row) => [row.rawContentId, row]));
    expect(byContentId.get(contentWithPageCount.id)?.pageCount).toBe(3);
    expect(byContentId.get(contentWithoutPageCount.id)?.pageCount).toBeNull();
  });
});

describe('listLatestVersionsForPanel: orderBy number asc — a última do array é a de maior number', () => {
  it('Conteúdo com 3 Versões fechadas → devolve as 3, na ordem de fechamento (número crescente)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedElegibleRawContent(editor.id, topicId);

    await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-07-01' },
      actorOf(editor),
      testPrisma,
    );
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { rawText: 'Texto da versão 2.' },
    });
    await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-08-01' },
      actorOf(editor),
      testPrisma,
    );
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { rawText: 'Texto da versão 3.' },
    });
    await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const rows = await listLatestVersionsForPanel([rawContent.id], testPrisma);

    expect(rows).toHaveLength(3);
    // Falsificável: um `orderBy: { number: 'desc' }` inverteria esta
    // sequência — cada contentSnapshot carrega o rawText vigente NO MOMENTO
    // do fechamento, então a ordem do array denuncia a ordem de `number`.
    const rawTexts = rows.map(
      (row) => (row.contentSnapshot as unknown as VersionedContentFields).rawText,
    );
    expect(rawTexts).toEqual([
      RAW_CONTENT_TEXT_FIELDS.rawText,
      'Texto da versão 2.',
      'Texto da versão 3.',
    ]);
  });
});

describe('listCurrentVersionedFieldsForApprovedContents: só devolve o que existe, nunca lança para id sem par', () => {
  it('2 Conteúdos aprovados + 1 sem RuleBreakdown no array de entrada → Map com exatamente 2 chaves', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();

    const approved1 = await seedApprovableRawContent(editor.id, topicId);
    const closed1 = await closeContentVersion(
      approved1.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );
    await approveContentVersion(
      approved1.id,
      closed1.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );

    const approved2 = await seedApprovableRawContent(editor.id, topicId);
    const closed2 = await closeContentVersion(
      approved2.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );
    await approveContentVersion(
      approved2.id,
      closed2.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );

    // "Não aprovado": nem RuleBreakdown tem — simula "só busca o que existe"
    // (o filtro por aprovação é do CHAMADOR; esta função não lança nem inclui
    // campos vazios para um id sem par).
    const notApproved = await createRawContent(editor.id, topicId);

    const map = await listCurrentVersionedFieldsForApprovedContents(
      [approved1.id, approved2.id, notApproved.id],
      testPrisma,
    );

    expect(map.size).toBe(2);
    expect(map.has(notApproved.id)).toBe(false);
    expect(map.get(approved1.id)).toEqual(buildVersionedContentFields());
    expect(map.get(approved2.id)).toEqual(buildVersionedContentFields());
  });
});

/**
 * NFR-034-001 — medição real via `withQueryProbe` (`tests/support/query-probe.ts`,
 * molde `content-versions.service.integration.test.ts:445-469`): cada leitura em
 * lote produz exatamente 1 statement (2 para `listCurrentVersionedFieldsForApprovedContents`,
 * que soma `RawContent`+`RuleBreakdown`), nunca 1 por Conteúdo — falsificável: uma
 * implementação que iterasse `rawContentIds` num loop produziria N statements,
 * crescendo com o fixture de 5.
 */
describe('query-count por função (NFR-034-001): fixture de 5 Conteúdos, custo fixo por chamada', () => {
  it('cada função produz exatamente 1 statement (2 para listCurrentVersionedFieldsForApprovedContents)', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const rawContent = await seedApprovableRawContent(editor.id, topicId);
      const closed = await closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editor),
        testPrisma,
      );
      await approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(admin),
        testPrisma,
      );
      rawContentIds.push(rawContent.id);
    }

    const activeContentsQueries = await withQueryProbe((probe) =>
      listActiveContentsForPanel(probe),
    );
    expect(activeContentsQueries).toHaveLength(1);

    const stageEventsQueries = await withQueryProbe((probe) =>
      listStageEventsForPanel(rawContentIds, probe),
    );
    expect(stageEventsQueries).toHaveLength(1);

    const publicationQueries = await withQueryProbe((probe) =>
      listTiraPublicationEventsForPanel(rawContentIds, probe),
    );
    expect(publicationQueries).toHaveLength(1);

    const versionsQueries = await withQueryProbe((probe) =>
      listLatestVersionsForPanel(rawContentIds, probe),
    );
    expect(versionsQueries).toHaveLength(1);

    const versionedFieldsQueries = await withQueryProbe((probe) =>
      listCurrentVersionedFieldsForApprovedContents(rawContentIds, probe),
    );
    expect(versionedFieldsQueries).toHaveLength(2);
  });
});
