import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Namespace (não named import): espiar `recordProductionStageEvent`
// (NFR-028-002, fail-secure) exige o objeto de módulo para `jest.spyOn` —
// mesmo padrão de `contrasts.service.integration.test.ts`.
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import {
  saveRuleBreakdown,
  updateRawContent,
  type ContentActor,
} from '../../src/modules/contents/contents.service';
import { approveContentVersionSchema } from '../../src/modules/content-versions/content-versions.schema';
import {
  approveContentVersion,
  closeContentVersion,
  listContentVersions,
} from '../../src/modules/content-versions/content-versions.service';
import { seedApprovableRawContent } from '../support/approvable-raw-content-fixtures';
import { withFailingTiraSignal } from '../support/failing-tira-signal';
import {
  BREAKDOWN_FIELDS,
  createRawContent,
  createTopic,
  createUser,
  seedRuleBreakdown,
} from '../support/production-events-fixtures';
import { withQueryProbe } from '../support/query-probe';
import { stripComments } from '../support/strip-comments';
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Envolve o `tx` de uma transação Prisma para que `ruleBreakdown.findUnique`
 * espere `delayMs` antes de resolver — usado para forçar interleaving real
 * (via lock do Postgres) entre `closeContentVersion` e uma escrita
 * concorrente na mesma linha. Todo o resto é delegado por `Reflect.get`
 * (mesmo padrão de `withFailingTiraSignal`, `tests/support/`).
 */
function withDelayedRuleBreakdownRead<T extends object>(tx: T, delayMs: number): T {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === 'ruleBreakdown') {
        const real = Reflect.get(target, prop, target) as Record<string, unknown>;
        return new Proxy(real, {
          get(innerTarget, innerProp) {
            if (innerProp === 'findUnique') {
              const original = Reflect.get(innerTarget, innerProp, innerTarget) as (
                ...args: unknown[]
              ) => Promise<unknown>;
              return async (...args: unknown[]) => {
                await delay(delayMs);
                return original.apply(innerTarget, args);
              };
            }
            return Reflect.get(innerTarget, innerProp, innerTarget) as unknown;
          },
        });
      }
      return Reflect.get(target, prop, target);
    },
  });
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
    expect(created.validApprovalForExport).toBe(false);

    const listed = await listContentVersions(rawContent.id, actorOf(editor), testPrisma);
    expect(listed.map((version) => version.id)).toEqual([created.id]);
    expect(listed[0]?.validApprovalForExport).toBe(false);
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

  it('RawContent com 3 Versões fechadas, a última APROVADA e sem alteração posterior → exatamente 5 statements (TASK-033-004, NFR-032-003/AC-032-013)', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);

    let closed = undefined as Awaited<ReturnType<typeof closeContentVersion>> | undefined;
    for (let i = 0; i < 3; i += 1) {
      closed = await closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editor),
        testPrisma,
      );
    }
    await approveContentVersion(
      rawContent.id,
      closed!.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );

    const queries = await withQueryProbe((probe) =>
      listContentVersions(rawContent.id, actorOf(editor), probe),
    );

    // 5 statements, medidos: assertRawContentReachable + findMany +
    // rawContent.findUniqueOrThrow + ruleBreakdown.findUniqueOrThrow +
    // productionStageEvent.findFirst (dentro de resolveAlterationSignal) —
    // nenhum cresce com N (3 Versões fechadas).
    expect(queries).toHaveLength(5);
  });

  it('MESMO cenário com 8 Versões fechadas → também exatamente 5 statements (custo não cresce com N)', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);

    let closed = undefined as Awaited<ReturnType<typeof closeContentVersion>> | undefined;
    for (let i = 0; i < 8; i += 1) {
      closed = await closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf(editor),
        testPrisma,
      );
    }
    await approveContentVersion(
      rawContent.id,
      closed!.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );

    const queries = await withQueryProbe((probe) =>
      listContentVersions(rawContent.id, actorOf(editor), probe),
    );

    // Falsificável junto com o caso de N=3 acima: os dois, lado a lado, com a
    // MESMA contagem, provam que o custo não é proporcional a N (nunca 10).
    expect(queries).toHaveLength(5);
  });

  it('Versão vigente APROVADA mas com sinal de alteração de CONTEÚDO aceso → exatamente 4 statements (short-circuit de resolveAlterationSignal, pula productionStageEvent)', async () => {
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

    // Escrita DIRETA (mesmo padrão de AC-032-016): altera o conteúdo
    // versionado depois da aprovação, sem emitir CONTEUDO_BRUTO.
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { rawText: 'Texto alterado depois da aprovação.' },
    });

    const queries = await withQueryProbe((probe) =>
      listContentVersions(rawContent.id, actorOf(editor), probe),
    );

    expect(queries).toHaveLength(4);
  });
});

describe('AC-032-001 (parte ESCRITA) / AC-032-008 (FR-032-009): ADMIN elegível aprova a Versão vigente', () => {
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
    expect(approved.validApprovalForExport).toBe(true);

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

describe('AC-032-001 (parte LEITURA, FR-032-007): listContentVersions expõe approvedById/approvedAt/validApprovalForExport da Versão aprovada', () => {
  it('após aprovação bem-sucedida, o histórico devolve approvedById/approvedAt idênticos aos gravados e validApprovalForExport: true', async () => {
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

    const listed = await listContentVersions(rawContent.id, actorOf(editor), testPrisma);
    const listedVersion = listed.find((version) => version.id === closed.id);

    expect(listedVersion?.approvedById).toBe(approved.approvedById);
    expect(listedVersion?.approvedAt?.getTime()).toBe(approved.approvedAt?.getTime());
    expect(listedVersion?.validApprovalForExport).toBe(true);
  });
});

describe('AC-032-006 (FR-032-006): a aprovação nunca se propaga para a Versão superada', () => {
  it('Versão 1 aprovada, EDITOR fecha a Versão 2 sem aprová-la → v1 mantém approvedById mas validApprovalForExport: false; v2 approvedById: null e validApprovalForExport: false', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);

    const v1 = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-08-01' },
      actorOf(editor),
      testPrisma,
    );
    await approveContentVersion(
      rawContent.id,
      v1.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );

    const v2 = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );

    const listed = await listContentVersions(rawContent.id, actorOf(editor), testPrisma);
    const listedV1 = listed.find((version) => version.id === v1.id);
    const listedV2 = listed.find((version) => version.id === v2.id);

    expect(listedV1?.approvedById).toBe(admin.id);
    expect(listedV1?.validApprovalForExport).toBe(false);
    expect(listedV2?.approvedById).toBeNull();
    expect(listedV2?.validApprovalForExport).toBe(false);
  });
});

describe('AC-032-020 (FR-032-007): fato histórico de aprovação intacto, mas validApprovalForExport reflete a alteração posterior', () => {
  it('Versão vigente aprovada, depois um campo versionado do RawContent é alterado (updateRawContent) → approvedById/approvedAt permanecem preenchidos, validApprovalForExport vira false', async () => {
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

    await updateRawContent(
      rawContent.id,
      { rawText: 'Texto normativo alterado depois da aprovação.' },
      actorOf(editor),
      testPrisma,
    );

    const listed = await listContentVersions(rawContent.id, actorOf(editor), testPrisma);
    const listedVersion = listed.find((version) => version.id === closed.id);

    expect(listedVersion?.approvedById).toBe(approved.approvedById);
    expect(listedVersion?.approvedAt?.getTime()).toBe(approved.approvedAt?.getTime());
    expect(listedVersion?.validApprovalForExport).toBe(false);
  });
});

describe('AC-032-002 (FR-032-002): approveContentVersionSchema recusa confirmação incompleta ANTES do service', () => {
  it.each([
    ['legalCheckConfirmed: false', { legalCheckConfirmed: false, pedagogicalCheckConfirmed: true }],
    ['pedagogicalCheckConfirmed ausente', { legalCheckConfirmed: true }],
    ['os 2 false', { legalCheckConfirmed: false, pedagogicalCheckConfirmed: false }],
  ])('%s → ZodError, nenhuma leitura do service acontece', (_label, input) => {
    const result = approveContentVersionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('AC-032-003 (FR-032-003): RawContent alcançável sem nenhuma Versão fechada', () => {
  it('recusa com NotFoundError "Não há versão para aprovar."', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(editor.id, topicId);

    const message = await captureMessage(() =>
      approveContentVersion(rawContent.id, 1, APPROVE_INPUT, actorOf(admin), testPrisma),
    );
    expect(message).toBe('Não há versão para aprovar.');
  });

  it('RawContent alcançável SEM RuleBreakdown e SEM Versão fechada → mesma recusa, nunca exceção não prevista', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId); // sem seedRuleBreakdown

    const message = await captureMessage(() =>
      approveContentVersion(rawContent.id, 1, APPROVE_INPUT, actorOf(admin), testPrisma),
    );
    expect(message).toBe('Não há versão para aprovar.');
  });
});

describe('AC-032-004 (FR-032-004, NFR-032-002) + AC-032-023: segregação de funções — prova COMPORTAMENTAL própria (escrita nova sobre content_versions)', () => {
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
    expect(message).toBe('Você não tem permissão para aprovar esta versão.');

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
    expect(message).toBe('Você não tem permissão para aprovar esta versão.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });

  it('último editor do RawContent (RawContent.lastEditedById), setado DEPOIS do fechamento via updateRawContent, ainda bloqueia (leitura AO VIVO, DEC-033-006)', async () => {
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
    // são tocados; a segregação de funções recusa antes mesmo de chegar à
    // guarda de edição pós-fechamento (o ator É o último editor).
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
    expect(message).toBe('Você não tem permissão para aprovar esta versão.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });
});

/**
 * Guarda de edição pós-fechamento (DEC-033-006 emendada): recusa quando
 * existe `ProductionStageEvent` `CONTEUDO_BRUTO` do `rawContentId` com
 * `sequence` maior que a do `VERSAO_EDITORIAL` que fechou a Versão vigente —
 * ordenação do BANCO (`sequence`, atribuída no INSERT dentro da transação),
 * nunca do relógio de aplicação. Não importa qual identidade editou.
 */
describe('Guarda de edição pós-fechamento (DEC-033-006 emendada): CONTEUDO_BRUTO com sequence posterior ao VERSAO_EDITORIAL recusa', () => {
  it('W edita o texto normativo, X fecha a Versão, um 3º ator faz updateRawContent(id, {}) → W tenta aprovar → ConflictError (edição pós-fechamento); approvedById permanece null', async () => {
    const author = await createUser('EDITOR');
    const w = await createUser('ADMIN');
    const x = await createUser('ADMIN');
    const thirdActor = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(author.id, topicId);

    // W edita um campo versionado ANTES do fechamento — emite um
    // CONTEUDO_BRUTO com sequence MENOR que o VERSAO_EDITORIAL do fechamento.
    await updateRawContent(
      rawContent.id,
      { rawText: 'Texto revisado por W antes do fechamento.' },
      actorOf(w),
      testPrisma,
    );

    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(x),
      testPrisma,
    );

    // Um 3º ator re-salva sem mudar NENHUM campo versionado — emite um
    // CONTEUDO_BRUTO com sequence MAIOR que o VERSAO_EDITORIAL do fechamento,
    // o suficiente para a guarda recusar, independente de qual identidade.
    await updateRawContent(rawContent.id, {}, actorOf(thirdActor), testPrisma);

    const message = await captureMessage(() =>
      approveContentVersion(rawContent.id, closed.number, APPROVE_INPUT, actorOf(w), testPrisma),
    );
    expect(message).toBe(
      'O conteúdo foi editado depois do fechamento desta versão. É preciso fechar uma nova versão para aprovar.',
    );

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });

  /**
   * Vetor CONCORRENTE (DEC-033-006): interleaving forçado por lock real do
   * Postgres — `closeContentVersion` recebe um `db` cujo
   * `ruleBreakdown.findUnique` espera ~400ms DEPOIS de já ter tomado o
   * `FOR UPDATE` (passo 1), enquanto um 3º ator dispara `updateRawContent`
   * concorrente: a `UPDATE` dele fica bloqueada pelo lock do Postgres e só
   * comita DEPOIS do fechamento — com `now` (relógio de aplicação) capturado
   * ANTES de esperar o lock, ou seja, ANTERIOR a `closedAt`.
   */
  it('Guarda 8b — vetor CONCORRENTE: edição concorrente que commita DEPOIS do fechamento recusa mesmo com timestamp de aplicação ANTERIOR ao fechamento', async () => {
    const author = await createUser('EDITOR');
    const w = await createUser('ADMIN');
    const x = await createUser('ADMIN');
    const thirdActor = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(author.id, topicId);

    const delayingDb = {
      $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        testPrisma.$transaction((tx) => callback(withDelayedRuleBreakdownRead(tx, 400))),
    } as unknown as Parameters<typeof closeContentVersion>[3];

    const closePromise = closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(x),
      delayingDb,
    );
    const updatePromise = (async () => {
      // Cabeça de partida: garante que closeContentVersion já tomou o
      // FOR UPDATE antes de a UPDATE concorrente tentar a mesma linha —
      // sem isso a ordem de chegada ao Postgres seria indeterminada.
      await delay(50);
      await updateRawContent(rawContent.id, {}, actorOf(thirdActor), testPrisma);
    })();

    const [closed] = await Promise.all([closePromise, updatePromise]);

    // Controle positivo: confirma a pré-condição MEDIDA do interleaving —
    // sem isso, uma inversão de ordem (pool frio, agendamento) daria
    // vermelho mudo em vez de apontar a causa.
    const closureEvent = await testPrisma.productionStageEvent.findFirstOrThrow({
      where: { rawContentId: rawContent.id, stageType: 'VERSAO_EDITORIAL' },
      orderBy: { sequence: 'desc' },
    });
    const concurrentEvent = await testPrisma.productionStageEvent.findFirstOrThrow({
      where: { rawContentId: rawContent.id, stageType: 'CONTEUDO_BRUTO' },
      orderBy: { sequence: 'desc' },
    });
    const rawContentAfter = await testPrisma.rawContent.findUniqueOrThrow({
      where: { id: rawContent.id },
    });
    expect(concurrentEvent.sequence).toBeGreaterThan(closureEvent.sequence);
    expect(rawContentAfter.lastEditedAt).not.toBeNull();
    expect(rawContentAfter.lastEditedAt?.getTime()).toBeLessThan(closed.closedAt.getTime());

    const message = await captureMessage(() =>
      approveContentVersion(rawContent.id, closed.number, APPROVE_INPUT, actorOf(w), testPrisma),
    );
    expect(message).toBe(
      'O conteúdo foi editado depois do fechamento desta versão. É preciso fechar uma nova versão para aprovar.',
    );

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });

  it('edição de campo versionado ANTES do fechamento (via updateRawContent), sem edição posterior → aprova com sucesso (eixo legítimo)', async () => {
    const author = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(author.id, topicId);

    // O único CONTEUDO_BRUTO deste RawContent tem sequence MENOR que o
    // VERSAO_EDITORIAL emitido pelo fechamento abaixo — um predicado que
    // recusasse por "existe algum CONTEUDO_BRUTO", sem comparar sequence,
    // reprovaria este caso legítimo.
    await updateRawContent(
      rawContent.id,
      { rawText: 'Texto revisado ANTES do fechamento.' },
      actorOf(author),
      testPrisma,
    );

    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(author),
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
  });

  it('duas Versões fechadas com uma edição real entre elas → aprovar a MAIS RECENTE (V2) usa o VERSAO_EDITORIAL de V2 como referência, nunca o de V1', async () => {
    const author = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(author.id, topicId);

    const v1 = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-08-01' },
      actorOf(author),
      testPrisma,
    );

    // Edição REAL entre os dois fechamentos — emite um CONTEUDO_BRUTO com
    // sequence entre o VERSAO_EDITORIAL de V1 e o de V2 (mais antigo que o
    // vigente): um predicado que usasse o VERSAO_EDITORIAL mais ANTIGO como
    // referência (em vez do mais recente) recusaria este caso indevidamente.
    await updateRawContent(
      rawContent.id,
      { rawText: 'Texto revisado entre V1 e V2.' },
      actorOf(author),
      testPrisma,
    );

    const v2 = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(author),
      testPrisma,
    );
    expect(v2.number).toBe(v1.number + 1);

    const approved = await approveContentVersion(
      rawContent.id,
      v2.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );

    expect(approved.approvedById).toBe(admin.id);
  });

  it('Versão fechada SEM edição posterior, aprovador elegível → aprova com sucesso (o caso legítimo sobrevive)', async () => {
    const author = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    const rawContent = await seedApprovableRawContent(author.id, topicId);
    const closed = await closeContentVersion(
      rawContent.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(author),
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
  });
});

/**
 * AC-032-005 (FR-032-005) — prova de AUSÊNCIA, universo declarado = `src`
 * inteiro (lição "[Testes] Prova de ausência por leitura de texto-fonte
 * precisa declarar o universo lido"): varredura recursiva real de todo
 * `src/` (exclui `generated`), comentários removidos antes do match
 * (`stripComments`, `tests/support/`) — nenhuma outra função grava/apaga um
 * `ContentVersion`.
 */
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

describe('AC-032-005 (FR-032-005): nenhuma outra função em src grava/apaga um ContentVersion — prova de ausência, universo = src inteiro', () => {
  it('exatamente 1 ocorrência em todo src/ — a updateMany desta própria TASK, com where completo (approvedById: null)', () => {
    const matches: Array<{ file: string; snippet: string }> = [];

    for (const file of listTsFilesRecursive(SRC_ROOT)) {
      const source = stripComments(readFileSync(file, 'utf8'));
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

describe('AC-032-014 (FR-032-013): Versão vigente sem fonte normativa registrada no contentSnapshot', () => {
  it('recusa com ConflictError "Esta versão foi fechada sem fonte normativa. Registre a fonte no conteúdo e feche uma nova versão para aprovação."; nenhum approvedById gravado', async () => {
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
    expect(message).toBe(
      'Esta versão foi fechada sem fonte normativa. Registre a fonte no conteúdo e feche uma nova versão para aprovação.',
    );

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });
});

describe('AC-032-015 (FR-032-014): duplo travamento pelo número — corrida por ESTADO sequencial', () => {
  it('aprovar informando o number de uma Versão que DEIXOU de ser a vigente → ConflictError "A versão exibida não é mais a vigente. Atualize a página para ver a versão atual."; nenhum approvedById gravado', async () => {
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
    expect(message).toBe(
      'A versão exibida não é mais a vigente. Atualize a página para ver a versão atual.',
    );

    const rows = await testPrisma.contentVersion.findMany({
      where: { rawContentId: rawContent.id },
    });
    expect(rows.every((row) => row.approvedById === null)).toBe(true);
  });
});

describe('AC-032-016 (FR-032-015): sinal de alteração pós-fechamento (conteúdo OU Tira) bloqueia a aprovação', () => {
  it('MECANISMO: hasVersionedContentChanged sozinho recusa (escrita DIRETA no Prisma, sem emitir CONTEUDO_BRUTO — isola o sinal de conteúdo da guarda de edição pós-fechamento)', async () => {
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

    // Escrita DIRETA (não `updateRawContent`): não emite ProductionStageEvent
    // nenhum, então a guarda de edição pós-fechamento nunca teria como
    // recusar aqui — só `hasVersionedContentChanged` fecha este caso.
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { rawText: 'Texto alterado depois do fechamento.' },
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
      'O conteúdo ou a Tira mnemônica foram alterados depois do fechamento desta versão. É preciso fechar uma nova versão para aprovar.',
    );

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });

  it('RuleBreakdown alterada após o fechamento via saveRuleBreakdown (escritor real que não emite CONTEUDO_BRUTO, não passa pela guarda de edição pós-fechamento) → ConflictError de alteração', async () => {
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

    await saveRuleBreakdown(
      rawContent.id,
      {
        concept: BREAKDOWN_FIELDS.concept,
        action: BREAKDOWN_FIELDS.action,
        object: BREAKDOWN_FIELDS.object,
        condition: BREAKDOWN_FIELDS.condition,
        exception: BREAKDOWN_FIELDS.exception,
        essence: 'Síntese alterada depois do fechamento.',
      },
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
      'O conteúdo ou a Tira mnemônica foram alterados depois do fechamento desta versão. É preciso fechar uma nova versão para aprovar.',
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
      'O conteúdo ou a Tira mnemônica foram alterados depois do fechamento desta versão. É preciso fechar uma nova versão para aprovar.',
    );

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBeNull();
  });
});

/**
 * AC-032-018 (FR-032-017, NFR-032-001) — prova de CONCORRÊNCIA REAL (lição
 * "[Segurança] Corrida (TOCTOU) só se fecha com prova de CONCORRÊNCIA real
 * contando linhas no fim"): `Promise.all`/`Promise.allSettled` disparando as 2
 * chamadas de fato em paralelo, contagem de linhas no fim como oráculo
 * primário — nunca só a mensagem do erro.
 */
describe('AC-032-018 (FR-032-017, NFR-032-001): idempotência sob concorrência real — exatamente 1 sucesso, nunca os 2', () => {
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
      'Esta versão já foi aprovada.',
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
    expect(message).toBe('Esta versão já foi aprovada.');

    const row = await testPrisma.contentVersion.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.approvedById).toBe(adminA.id);
  });
});

describe('AC-032-019 (FR-032-018): RawContent soft-deletado com Versão fechada', () => {
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
    expect(message).toBe(
      'A versão exibida não é mais a vigente. Atualize a página para ver a versão atual.',
    );
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
    expect(message).toBe('Esta versão já foi aprovada.');
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
    expect(message).toBe('Você não tem permissão para aprovar esta versão.');
  });

  it('(iv) edição pós-fechamento (8b) vence sobre fonte ausente (9): Versão sem fonte normativa E RawContent editado depois do fechamento → mensagem de EDIÇÃO', async () => {
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
    // `updateRawContent` toca lastEditedAt (guard 8b) — a mesma ação também
    // mudaria o conteúdo, mas 8b vem ANTES na ordem e vence.
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
      'O conteúdo foi editado depois do fechamento desta versão. É preciso fechar uma nova versão para aprovar.',
    );
  });

  it('(v) fonte ausente (9) vence sobre sinal de alteração da Tira (11): Versão sem fonte normativa E Tira alterada depois do fechamento → mensagem de FONTE', async () => {
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
    // Evento de Tira (via productionEventsService direto): NÃO toca
    // RawContent.lastEditedAt — a guarda 8b não acende, e o par testado aqui
    // é genuinamente fonte ausente (9) vs. sinal de alteração (11).
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
      'Esta versão foi fechada sem fonte normativa. Registre a fonte no conteúdo e feche uma nova versão para aprovação.',
    );
  });
});

/**
 * Herança N1: a Versão vigente é resolvida pelo PRÓPRIO `rawContentId` do
 * path — o `number` de outro Conteúdo bruto nunca é confundido com o vigente
 * daquele.
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
    expect(message).toBe(
      'A versão exibida não é mais a vigente. Atualize a página para ver a versão atual.',
    );

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
 * Herança N2: fail-secure do sinal de alteração — `resolveAlterationSignal`
 * rejeitando propaga o erro, nenhuma escrita acontece. `withFailingTiraSignal`
 * (`tests/support/`) intercepta SÓ `productionStageEvent.findFirst` dentro da
 * transação real — nunca o client raiz (`prisma`), que produziria falso
 * positivo por não ser o objeto realmente usado dentro do `$transaction`.
 */
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

/**
 * Herança N1 (gate 8 W1), aplicada a `listContentVersions`/
 * `validApprovalForExport`: `resolveAlterationSignal` é chamado com o
 * `rawContentId` do PRÓPRIO parâmetro da função — nunca o de outro Conteúdo
 * bruto. Alterar o conteúdo só de B não pode acender o sinal computado para A.
 */
describe('listContentVersions — herança N1 (gate 8 W1): sinal de alteração não vaza entre Conteúdos brutos', () => {
  it('2 Conteúdos brutos com Versões aprovadas, alterar o conteúdo só de B → listContentVersions(A) mantém validApprovalForExport: true; listContentVersions(B) vira false', async () => {
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
    const closedB = await closeContentVersion(
      rawContentB.id,
      { legislativeClosureDate: '2026-09-01' },
      actorOf(editor),
      testPrisma,
    );
    await approveContentVersion(
      rawContentA.id,
      closedA.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );
    await approveContentVersion(
      rawContentB.id,
      closedB.number,
      APPROVE_INPUT,
      actorOf(admin),
      testPrisma,
    );

    // Escrita DIRETA (mesmo padrão de AC-032-016) — só em B.
    await testPrisma.rawContent.update({
      where: { id: rawContentB.id },
      data: { rawText: 'Texto de B alterado depois da aprovação.' },
    });

    const listedA = await listContentVersions(rawContentA.id, actorOf(editor), testPrisma);
    const listedB = await listContentVersions(rawContentB.id, actorOf(editor), testPrisma);

    expect(listedA.at(-1)?.validApprovalForExport).toBe(true);
    expect(listedB.at(-1)?.validApprovalForExport).toBe(false);
  });
});

/**
 * Herança N2 (gate 8 W1), aplicada a `listContentVersions`: fail-secure da
 * leitura — `productionStageEvent.findFirst` rejeitando durante o cálculo de
 * `validApprovalForExport` propaga o erro; nunca um default silencioso
 * (`validApprovalForExport: true` nem `false` calado). `listContentVersions`
 * não abre `$transaction` própria — `withFailingTiraSignal` embrulha o `db`
 * recebido diretamente (mesmo helper de `tests/support/`).
 */
describe('listContentVersions — herança N2 (gate 8 W1): fail-secure do cálculo de validApprovalForExport', () => {
  it('productionStageEvent.findFirst rejeitando → listContentVersions rejeita, sem devolver validApprovalForExport', async () => {
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

    await expect(
      listContentVersions(rawContent.id, actorOf(editor), withFailingTiraSignal(testPrisma)),
    ).rejects.toThrow('falha simulada na leitura do sinal');
  });
});
