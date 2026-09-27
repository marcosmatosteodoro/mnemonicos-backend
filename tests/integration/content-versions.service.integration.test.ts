import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Namespace (não named import): espiar `recordProductionStageEvent`
// (NFR-028-002, fail-secure) exige o objeto de módulo para `jest.spyOn` —
// mesmo padrão de `contrasts.service.integration.test.ts`.
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import { updateRawContent, type ContentActor } from '../../src/modules/contents/contents.service';
import { approveContentVersionSchema } from '../../src/modules/content-versions/content-versions.schema';
import {
  approveContentVersion,
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
import { buildVersionedContentFields } from '../support/versioned-content-fields-fixtures';
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

/**
 * `RawContent`+`RuleBreakdown` elegíveis para `approveContentVersion`
 * (fonte normativa presente por padrão — sourceType/sourceCitation, ausentes
 * em `createRawContent`/A necessário para passar a barreira de FR-030-013)
 * a partir do MESMO builder (`buildVersionedContentFields`, `tests/support/`)
 * que também alimenta `contentSnapshot` no fechamento real via
 * `closeContentVersion` — nenhuma duplicação dos 11 campos versionados.
 */
async function seedApprovableRawContent(
  authorId: string,
  topicId: string,
  overrides: Partial<ReturnType<typeof buildVersionedContentFields>> = {},
) {
  const fields = buildVersionedContentFields(overrides);
  const rawContent = await testPrisma.rawContent.create({
    data: {
      authorId,
      topicId,
      rawText: fields.rawText,
      radarClass: fields.radarClass,
      sourceType: fields.sourceType,
      sourceCitation: fields.sourceCitation,
      sourceUrl: fields.sourceUrl,
    },
  });
  await testPrisma.ruleBreakdown.create({
    data: {
      rawContentId: rawContent.id,
      concept: fields.concept,
      action: fields.action,
      object: fields.object,
      condition: fields.condition,
      exception: fields.exception,
      essence: fields.essence,
    },
  });
  return rawContent;
}

const APPROVE_INPUT = { legalCheckConfirmed: true, pedagogicalCheckConfirmed: true } as const;

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

describe('AC-030-001 (parte ESCRITA) / AC-030-008 (FR-030-009): ADMIN elegível aprova a Versão vigente', () => {
  it('grava approvedById/approvedAt e emite exatamente 1 ProductionStageEvent APROVACAO_VERSAO/CONCLUSAO', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const approved = await approveContentVersion(
      rawContent.id,
      closed.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );

    expect(approved.approvedById).toBe(admin.id);
    expect(approved.approvedAt).toBeInstanceOf(Date);

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBe(admin.id);
    expect(row.approvedAt).not.toBeNull();

    const events = await productionEventsService.listProductionStageEvents(
      rawContent.id,
      testPrisma,
    );
    const approvalEvents = events.filter((event) => event.stageType === 'APROVACAO_VERSAO');
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]?.transitionType).toBe('CONCLUSAO');
  });
});

describe('AC-030-002 (FR-030-002): approveContentVersionSchema recusa confirmação incompleta ANTES do service', () => {
  it.each([
    ['legalCheckConfirmed: false', { legalCheckConfirmed: false, pedagogicalCheckConfirmed: true }],
    ['pedagogicalCheckConfirmed ausente', { legalCheckConfirmed: true }],
    ['os 2 false', { legalCheckConfirmed: false, pedagogicalCheckConfirmed: false }],
  ])('%s → ZodError, nenhuma leitura do service acontece', (_label, input) => {
    const result = approveContentVersionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('AC-030-003 (FR-030-003): RawContent alcançável sem nenhuma Versão fechada', () => {
  it('recusa com NotFoundError "Não há Versão para aprovar."', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);

    const message = await captureMessage(() =>
      approveContentVersion(rawContent.id, 1, APPROVE_INPUT, actorOf(admin), testPrisma),
    );
    expect(message).toBe('Não há Versão para aprovar.');
  });
});

describe('AC-030-004 (FR-030-004, NFR-030-002) + AC-030-023: segregação de funções — prova COMPORTAMENTAL própria (escrita nova sobre content_versions)', () => {
  it('quem fechou a Versão (ContentVersion.authorId) não pode aprová-la', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(editor),
        testPrisma,
      ),
    );
    expect(message).toBe('Você não tem permissão para aprovar esta Versão.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });

  it('autor original do RawContent (RawContent.authorId) não pode aprovar, mesmo sem ter fechado a Versão', async () => {
    const author = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(author.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(admin),
      testPrisma,
    );

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(author),
        testPrisma,
      ),
    );
    expect(message).toBe('Você não tem permissão para aprovar esta Versão.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });

  it('último editor do RawContent (RawContent.lastEditedById), setado DEPOIS do fechamento via updateRawContent, ainda bloqueia (leitura AO VIVO, DEC-031-006)', async () => {
    const author = await createUser('EDITOR');
    const lastEditorAdmin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(author.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(author),
      testPrisma,
    );

    // Nenhum campo versionado muda (input vazio) — só lastEditedById/lastEditedAt
    // são tocados, então o sinal de alteração (guard 10) segue apagado e a
    // segregação (guard 8) é quem recusa.
    await updateRawContent(rawContent.id, {}, actorOf(lastEditorAdmin), testPrisma);

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(lastEditorAdmin),
        testPrisma,
      ),
    );
    expect(message).toBe('Você não tem permissão para aprovar esta Versão.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });
});

/**
 * AC-030-005 (FR-030-005) — prova de AUSÊNCIA, universo declarado = `src`
 * inteiro (lição "[Testes] Prova de ausência por leitura de texto-fonte
 * precisa declarar o universo lido"): varredura recursiva real de todo
 * `src/` (exclui `generated`), comentários removidos antes do match (mesmo
 * `stripComments` de `production-events.service.integration.test.ts`) —
 * nenhuma outra função grava/apaga um `ContentVersion`.
 */
function stripCommentsForMutationScan(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listTsFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'generated' ? [] : listTsFilesRecursive(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const CONTENT_VERSION_MUTATION_PATTERN = /contentVersion\.(update|updateMany|delete|deleteMany)\(/g;
const SRC_ROOT = resolve(__dirname, '../../src');

describe('AC-030-005 (FR-030-005): nenhuma outra função em src grava/apaga um ContentVersion — prova de ausência, universo = src inteiro', () => {
  it('exatamente 1 ocorrência em todo src/ — a updateMany desta própria TASK, com where completo (approvedById: null)', () => {
    const matches: Array<{ file: string; snippet: string }> = [];

    for (const file of listTsFilesRecursive(SRC_ROOT)) {
      const source = stripCommentsForMutationScan(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(CONTENT_VERSION_MUTATION_PATTERN)) {
        const start = match.index ?? 0;
        matches.push({ file, snippet: source.slice(start, start + 150) });
      }
    }

    expect(matches).toHaveLength(1);
    expect(matches[0]?.file).toContain('content-versions.service.ts');
    expect(matches[0]?.snippet).toContain('updateMany');
    expect(matches[0]?.snippet).toContain('approvedById: null');
  });
});

describe('AC-030-014 (FR-030-013): Versão vigente sem fonte normativa registrada no contentSnapshot', () => {
  it('recusa com ConflictError "Falta fonte normativa registrada nesta Versão."; nenhum approvedById gravado', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId, {
      sourceType: null,
      sourceCitation: null,
    });
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(admin),
        testPrisma,
      ),
    );
    expect(message).toBe('Falta fonte normativa registrada nesta Versão.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });
});

describe('AC-030-015 (FR-030-014): duplo travamento pelo número — corrida por ESTADO sequencial', () => {
  it('aprovar informando o number de uma Versão que DEIXOU de ser a vigente → ConflictError "O número informado não é mais o da Versão vigente."; nenhum approvedById gravado', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);

    await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-07-01' },
      actorOf(editor),
      testPrisma,
    );
    const second = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-08-01' },
      actorOf(editor),
      testPrisma,
    );
    expect(second.number).toBe(2);

    // ANTES da chamada de aprovação, outro fechamento supera a Versão vigente
    // (a corrida por ESTADO, não de concorrência real de escrita).
    await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        second.number,
        APPROVE_INPUT,
        actorOf(admin),
        testPrisma,
      ),
    );
    expect(message).toBe('O número informado não é mais o da Versão vigente.');

    const rows = await testPrisma.contentVersion.findMany({
      where: { rawContentId: rawContent.id },
    });
    expect(rows.every((row) => row.approvedById === null)).toBe(true);
  });
});

describe('AC-030-016 (FR-030-015): sinal de alteração pós-fechamento (conteúdo OU Tira) bloqueia a aprovação', () => {
  it('conteúdo alterado após o fechamento (campo versionado do RawContent) → ConflictError', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    await updateRawContent(
      rawContent.id,
      { rawText: 'Texto alterado depois do fechamento.' },
      actorOf(editor),
      testPrisma,
    );

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(admin),
        testPrisma,
      ),
    );
    expect(message).toBe(
      'O conteúdo ou a Tira mnemônica foram alterados após o fechamento desta Versão.',
    );

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });

  it('Tira mnemônica alterada após o fechamento (evento TIRA_MNEMONICA posterior a closedAt) → ConflictError, mesma mensagem', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    await productionEventsService.recordProductionStageEvent(testPrisma, {
      rawContentId: rawContent.id,
      stageType: 'TIRA_MNEMONICA',
      transitionType: 'CONCLUSAO',
      actorId: editor.id,
      now: new Date(closed.closedAt.getTime() + 1000),
    });

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(admin),
        testPrisma,
      ),
    );
    expect(message).toBe(
      'O conteúdo ou a Tira mnemônica foram alterados após o fechamento desta Versão.',
    );

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });
});

/**
 * AC-030-018 (FR-030-017, NFR-030-001) — prova de CONCORRÊNCIA REAL (lição
 * "[Segurança] Corrida (TOCTOU) só se fecha com prova de CONCORRÊNCIA real
 * contando linhas no fim"): `Promise.all`/`Promise.allSettled` disparando as 2
 * chamadas de fato em paralelo, contagem de linhas no fim como oráculo
 * primário — nunca só a mensagem do erro.
 */
describe('AC-030-018 (FR-030-017, NFR-030-001): idempotência sob concorrência real — exatamente 1 sucesso, nunca os 2', () => {
  it('2 chamadas para a MESMA Versão, por 2 ADMINs elegíveis distintos, disparadas em paralelo → exatamente 1 sucesso e 1 ConflictError; 1 linha aprovada, 1 evento APROVACAO_VERSAO', async () => {
    const editor = await createUser('EDITOR');
    const adminA = await createUser('ADMIN');
    const adminB = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const results = await Promise.allSettled([
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(adminA),
        testPrisma,
      ),
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(adminB),
        testPrisma,
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
      'Esta Versão já foi aprovada.',
    );

    const approvedRows = await testPrisma.contentVersion.findMany({
      where: { rawContentId: rawContent.id, approvedById: { not: null } },
    });
    expect(approvedRows).toHaveLength(1);

    const events = await productionEventsService.listProductionStageEvents(
      rawContent.id,
      testPrisma,
    );
    expect(events.filter((event) => event.stageType === 'APROVACAO_VERSAO')).toHaveLength(1);
  });

  it('após 1ª aprovação bem-sucedida por ADMIN A, uma 2ª tentativa por ADMIN B elegível → ConflictError; approvedById permanece IGUAL a A (nunca sobrescrito)', async () => {
    const editor = await createUser('EDITOR');
    const adminA = await createUser('ADMIN');
    const adminB = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const approvedByA = await approveContentVersion(
      rawContent.id,
      closed.number,
      APPROVE_INPUT,
      actorOf(adminA),
      testPrisma,
    );
    expect(approvedByA.approvedById).toBe(adminA.id);

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(adminB),
        testPrisma,
      ),
    );
    expect(message).toBe('Esta Versão já foi aprovada.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBe(adminA.id);
  });
});

describe('AC-030-019 (FR-030-018): RawContent soft-deletado com Versão fechada', () => {
  it('recusa com NotFoundError "Conteúdo bruto foi removido."; nenhum approvedById gravado', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { deletedAt: new Date() },
    });

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(admin),
        testPrisma,
      ),
    );
    expect(message).toBe('Conteúdo bruto foi removido.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });
});

/**
 * Precedência entre guardas (passos 5-10 de `approveContentVersion`) — lição
 * "[Testes] Árvore de decisão com precedência: um caso por PAR de ramos que
 * pode coincidir": um caso por PAR, nomeando qual guard vence.
 */
describe('approveContentVersion — precedência entre guardas (um caso por par de ramos que coincide)', () => {
  it('(i) número mismatch (6) vence sobre já aprovada (7): Versão vigente já aprovada, ator informa o número de uma Versão MAIS ANTIGA → mensagem de NÚMERO', async () => {
    const editor = await createUser('EDITOR');
    const adminA = await createUser('ADMIN');
    const adminB = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const first = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-08-01' },
      actorOf(editor),
      testPrisma,
    );
    const second = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );
    await approveContentVersion(
      rawContent.id,
      second.number,
      APPROVE_INPUT,
      actorOf(adminA),
      testPrisma,
    );

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        first.number,
        APPROVE_INPUT,
        actorOf(adminB),
        testPrisma,
      ),
    );
    expect(message).toBe('O número informado não é mais o da Versão vigente.');
  });

  it('(ii) já aprovada (7) vence sobre segregação (8): Versão vigente já aprovada por outro ator; 2ª tentativa é de um PRODUTOR → mensagem de "já aprovada"', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
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

    // editor É produtor (fechou a própria Versão) — a segregação bateria se
    // fosse checada primeiro, mas a Versão já está aprovada (guard 7 vence).
    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(editor),
        testPrisma,
      ),
    );
    expect(message).toBe('Esta Versão já foi aprovada.');
  });

  it('(iii) segregação (8) vence sobre fonte ausente (9): ator é produtor E a Versão não tem fonte normativa → mensagem de PERMISSÃO', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId, {
      sourceType: null,
      sourceCitation: null,
    });
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(editor),
        testPrisma,
      ),
    );
    expect(message).toBe('Você não tem permissão para aprovar esta Versão.');
  });

  it('(iv) fonte ausente (9) vence sobre sinal de alteração (10): Versão sem fonte normativa E com conteúdo alterado após o fechamento → mensagem de FONTE', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId, {
      sourceType: null,
      sourceCitation: null,
    });
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );
    await updateRawContent(
      rawContent.id,
      { rawText: 'Texto alterado depois do fechamento.' },
      actorOf(editor),
      testPrisma,
    );

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf(admin),
        testPrisma,
      ),
    );
    expect(message).toBe('Falta fonte normativa registrada nesta Versão.');
  });
});

/**
 * Herança N1 (gate 8 da Wave 1, security-engineer): a Versão vigente é
 * resolvida pelo PRÓPRIO `rawContentId` do path — o `number` de outro
 * Conteúdo bruto nunca é confundido com o vigente daquele.
 */
describe('approveContentVersion — herança N1 (gate 8 W1): Versão resolvida pelo rawContentId do path', () => {
  it('aprovar rawContentId de A informando o number da Versão de B (que não existe em A) → recusa de número; 0 aprovações gravadas nas 2', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContentA = await seedApprovableRawContent(editor.id, topicId);
    const rawContentB = await seedApprovableRawContent(editor.id, topicId);

    const closedA = await closeContentVersion(
      rawContentA.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );
    await closeContentVersion(
      rawContentB.id,
      { legislativeClosureDate: '2026-08-01' },
      actorOf(editor),
      testPrisma,
    );
    const secondB = await closeContentVersion(
      rawContentB.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );
    expect(secondB.number).not.toBe(closedA.number);

    const message = await captureMessage(() =>
      approveContentVersion(
        rawContentA.id,
        secondB.number,
        APPROVE_INPUT,
        actorOf(admin),
        testPrisma,
      ),
    );
    expect(message).toBe('O número informado não é mais o da Versão vigente.');

    const rowsA = await testPrisma.contentVersion.findMany({
      where: { rawContentId: rawContentA.id },
    });
    const rowsB = await testPrisma.contentVersion.findMany({
      where: { rawContentId: rawContentB.id },
    });
    expect([...rowsA, ...rowsB].every((row) => row.approvedById === null)).toBe(true);
  });
});

/**
 * Herança N2 (gate 8 da Wave 1, security-engineer): fail-secure do sinal de
 * alteração — `resolveAlterationSignal` rejeitando propaga o erro, nenhuma
 * escrita acontece. O `db` injetado intercepta SÓ `productionStageEvent.findFirst`
 * dentro da transação real (via `Proxy`, delegando tudo mais por
 * `Reflect.get`) — nunca o client raiz (`prisma`), que produziria falso
 * positivo por não ser o objeto realmente usado dentro do `$transaction`.
 */
function withFailingTiraSignal<T extends object>(tx: T): T {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === 'productionStageEvent') {
        const real = Reflect.get(target, prop, target) as Record<string, unknown>;
        return new Proxy(real, {
          get(innerTarget, innerProp) {
            if (innerProp === 'findFirst') {
              return () => Promise.reject(new Error('falha simulada na leitura do sinal'));
            }
            return Reflect.get(innerTarget, innerProp, innerTarget) as unknown;
          },
        });
      }
      return Reflect.get(target, prop, target);
    },
  });
}

describe('approveContentVersion — herança N2 (gate 8 W1): fail-secure do sinal de alteração', () => {
  it('productionStageEvent.findFirst rejeitando DENTRO da transação → approveContentVersion rejeita; approvedById permanece null', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const failingDb = {
      $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        testPrisma.$transaction((tx) => callback(withFailingTiraSignal(tx))),
    } as unknown as Parameters<typeof approveContentVersion>[4];

    await expect(
      approveContentVersion(rawContent.id, closed.number, APPROVE_INPUT, actorOf(admin), failingDb),
    ).rejects.toThrow('falha simulada na leitura do sinal');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });
});
