import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client';
import { ConflictError, NotFoundError } from '../../src/http/errors';
import type { ContentActor } from '../../src/modules/contents/contents.service';
// Namespace (não named import): espiar `recordProductionStageEvent` (AC-011-015,
// fail-secure) exige o objeto de módulo para `jest.spyOn` — mesmo padrão de
// `contents.service.integration.test.ts` (TASK-010-003). `tira.service.ts`
// segue importando por named import (mesmo padrão de `contents.service.ts`); o
// spy intercepta porque o emit deste projeto é CommonJS (perfil §11) — o named
// import vira acesso de propriedade a cada chamada, não um binding capturado.
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import {
  addMnemonicFrame,
  openMnemonicStrip,
  removeMnemonicFrame,
  reorderMnemonicFrames,
  updateMnemonicFrameText,
} from '../../src/modules/tira/tira.service';
import {
  BREAKDOWN_FIELDS,
  createRawContent,
  createTopic,
  createUser,
  seedRuleBreakdown,
} from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';
import { TEST_DATABASE_URL } from './db-url';

/**
 * `tira.service.ts` — `openMnemonicStrip` (TASK-012-005 / COMP-012-004) sobre
 * o Postgres real (molde `contents.service.integration.test.ts`): geração
 * inicial idempotente, reabertura simples, concorrência real (AC-011-025),
 * alcance por autoria herdado (AC-011-020/022), fail-secure (AC-011-015).
 * Reusa `tests/support/production-events-fixtures.ts` — não recria fixture
 * equivalente.
 */

function actorOf(user: { id: string; role: 'EDITOR' | 'ADMIN' | 'STUDENT' }): ContentActor {
  return { id: user.id, role: user.role };
}

/**
 * Blocos opcionais (`condition`/`exception`) em branco — gera só 3 Quadros
 * (`concept`/`action`/`object`, os 3 únicos campos NOT NULL de
 * `RuleBreakdown`). Usada pelos testes que precisam esvaziar a Tira por
 * completo (AC-011-024): não há como gerar menos de 3 Quadros na abertura.
 */
async function seedRuleBreakdownWithoutOptionalBlocks(rawContentId: string) {
  return testPrisma.ruleBreakdown.create({
    data: {
      rawContentId,
      concept: BREAKDOWN_FIELDS.concept,
      action: BREAKDOWN_FIELDS.action,
      object: BREAKDOWN_FIELDS.object,
      condition: null,
      exception: null,
      essence: BREAKDOWN_FIELDS.essence,
    },
  });
}

/** Sonda de round-trips (lição [Performance]) — mesmo padrão local de `contents.service.integration.test.ts`/`disciplines.integration.test.ts`. */
async function withQueryProbe(run: (probe: PrismaClient) => Promise<unknown>): Promise<string[]> {
  const probe = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 1 }),
    log: [{ emit: 'event', level: 'query' }],
  });
  const queries: string[] = [];
  probe.$on('query', (event) => queries.push(event.query));

  try {
    await run(probe);
  } finally {
    await probe.$disconnect();
  }

  return queries;
}

/** Captura a mensagem de um `AppError` esperado, para comparação literal entre recusas. */
async function captureMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('esperava rejeição, mas a chamada resolveu');
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('openMnemonicStrip — geração inicial e reabertura simples (AC-011-001, AC-011-002, AC-011-003, AC-011-012)', () => {
  it('1ª abertura gera 5 Quadros na ordem canônica, posições 1..5; 2ª chamada (reabertura) devolve a MESMA Tira, sem gerar 2ª linha', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    const first = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    expect(first.frames.map((frame) => frame.originBlock)).toEqual([
      'concept',
      'action',
      'object',
      'condition',
      'exception',
    ]);
    expect(first.frames.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5]);

    const second = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(second.id).toBe(first.id);
    expect(second.frames).toEqual(first.frames);

    const breakdown = await testPrisma.ruleBreakdown.findUniqueOrThrow({
      where: { rawContentId: rawContent.id },
    });
    const count = await testPrisma.mnemonicStrip.count({
      where: { ruleBreakdownId: breakdown.id },
    });
    expect(count).toBe(1);
  });
});

describe('openMnemonicStrip — só ABERTURA é emitida na geração; etapa permanece ABERTA indefinidamente (AC-011-013, AC-011-021)', () => {
  it('1ª abertura grava exatamente 1 evento (ABERTURA); reabrir a Tira mantém a MESMA contagem, nenhum evento novo', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const eventsAfterFirst = await productionEventsService.listProductionStageEvents(
      rawContent.id,
      testPrisma,
    );
    const tiraEventsAfterFirst = eventsAfterFirst.filter(
      (event) => event.stageType === 'TIRA_MNEMONICA',
    );
    expect(tiraEventsAfterFirst).toHaveLength(1);
    expect(tiraEventsAfterFirst[0]?.transitionType).toBe('ABERTURA');

    await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const eventsAfterSecond = await productionEventsService.listProductionStageEvents(
      rawContent.id,
      testPrisma,
    );
    const tiraEventsAfterSecond = eventsAfterSecond.filter(
      (event) => event.stageType === 'TIRA_MNEMONICA',
    );
    expect(tiraEventsAfterSecond).toHaveLength(1);
  });
});

describe('openMnemonicStrip — recusa quando a Quebra da regra ainda não foi salva (AC-011-023, parte)', () => {
  it('rawContent alcançável, sem RuleBreakdown associada → ConflictError com mensagem pt-BR; nenhuma criação parcial', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);

    await expect(openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma)).rejects.toThrow(
      ConflictError,
    );

    const message = await captureMessage(() =>
      openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma),
    );
    expect(message).toBe('Conclua a Quebra da regra antes de abrir a Tira mnemônica.');

    const count = await testPrisma.mnemonicStrip.count();
    expect(count).toBe(0);
  });
});

/**
 * Concorrência REAL (`Promise.all`, não sequencial) — AC-011-025, DEC-012-008.
 * Mutante do critério: um `findFirst` + `create` incondicional (check-then-act)
 * no lugar de `create` + captura de violação única produziria 2 linhas de
 * `MnemonicStrip` sob esta corrida — a asserção de contagem exata reprova esse
 * mutante.
 */
describe('openMnemonicStrip — concorrência real da 1ª abertura (AC-011-025, DEC-012-008)', () => {
  it('2 chamadas concorrentes sem Tira prévia → exatamente 1 MnemonicStrip e exatamente 1 evento de ABERTURA', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    const [resultA, resultB] = await Promise.all([
      openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma),
      openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma),
    ]);

    // Fronteira exata da invariante (i) create sucede na 1ª → ABERTURA; (ii)
    // create falha por violação única na 2ª → lê a Tira da vencedora, sem 2º
    // evento — os dois resultados apontam para a MESMA Tira.
    expect(resultA.id).toBe(resultB.id);
    expect(resultA.frames).toEqual(resultB.frames);

    const breakdown = await testPrisma.ruleBreakdown.findUniqueOrThrow({
      where: { rawContentId: rawContent.id },
    });
    const stripCount = await testPrisma.mnemonicStrip.count({
      where: { ruleBreakdownId: breakdown.id },
    });
    expect(stripCount).toBe(1);

    const events = await productionEventsService.listProductionStageEvents(
      rawContent.id,
      testPrisma,
    );
    const aberturas = events.filter(
      (event) => event.stageType === 'TIRA_MNEMONICA' && event.transitionType === 'ABERTURA',
    );
    expect(aberturas).toHaveLength(1);
  });
});

describe('openMnemonicStrip — soft-delete do RawContent de origem torna a Tira e os Quadros inalcançáveis (AC-011-020, NFR-011-006)', () => {
  it('gera a Tira, soft-deleta o RawContent de origem, reabre → NotFoundError "Conteúdo bruto foi removido."; nenhuma linha de mnemonic_strips/mnemonic_frames é apagada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    const created = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { deletedAt: new Date() },
    });

    await expect(openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma)).rejects.toThrow(
      NotFoundError,
    );

    const message = await captureMessage(() =>
      openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma),
    );
    expect(message).toBe('Conteúdo bruto foi removido.');

    const strip = await testPrisma.mnemonicStrip.findUnique({ where: { id: created.id } });
    expect(strip).not.toBeNull();
    const framesCount = await testPrisma.mnemonicFrame.count({ where: { stripId: created.id } });
    expect(framesCount).toBe(created.frames.length);
  });
});

/**
 * Fechamento contável (item (c) da régua de contorno): 2 métodos tocam
 * tabela escopada por autoria herdada (`mnemonicStrip`/`mnemonicFrame`, via a
 * cadeia `RawContent → RuleBreakdown → MnemonicStrip`) — `openMnemonicStrip`
 * (este caso) e `reorderMnemonicFrames` (abaixo) — 2 provas.
 */
describe('openMnemonicStrip — alcance por autoria (AC-011-022, NFR-011-001, gate 8)', () => {
  it('EDITOR B não alcança a Tira de Conteúdo bruto de EDITOR A — mesma mensagem literal de um id inexistente', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContentOfA.id);

    const messageForOtherAuthor = await captureMessage(() =>
      openMnemonicStrip(rawContentOfA.id, actorOf(editorB), testPrisma),
    );
    const messageForRandomId = await captureMessage(() =>
      openMnemonicStrip(randomUUID(), actorOf(editorB), testPrisma),
    );

    // Comparação literal entre as duas recusas — não só tipo AppError: os
    // dois casos são indistinguíveis pelo oráculo (mesmo corolário de A01 de
    // `contents.service.ts`).
    expect(messageForOtherAuthor).toBe(messageForRandomId);
    expect(messageForOtherAuthor).toBe('Conteúdo bruto não encontrado.');

    const count = await testPrisma.mnemonicStrip.count();
    expect(count).toBe(0);
  });
});

describe('openMnemonicStrip — fail-secure: falha na emissão do evento reverte a criação inteira (AC-011-015, NFR-011-003)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recordProductionStageEvent rejeitando dentro da transação → openMnemonicStrip rejeita; nenhuma MnemonicStrip/MnemonicFrame persiste', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma)).rejects.toThrow(
      'falha simulada na emissão',
    );

    const stripCount = await testPrisma.mnemonicStrip.count();
    expect(stripCount).toBe(0);
    const frameCount = await testPrisma.mnemonicFrame.count();
    expect(frameCount).toBe(0);
  });
});

/**
 * Relação de LISTA (`MnemonicStrip.frames`) — lição [Performance], ressalva 2:
 * `join` não vence de graça para 1-N. Medido contra o Postgres real, não
 * presumido; a estratégia escolhida (`relationLoadStrategy: 'join'`) fica
 * declarada em comentário em `tira.service.ts`.
 */
describe('openMnemonicStrip — round-trips fixados para a relação de lista `frames` (lição [Performance])', () => {
  it('reabertura simples (Tira já gerada, com 5 Quadros) resolve com a contagem de queries FIXADA (relationLoadStrategy: "join")', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const queries = await withQueryProbe((probe) =>
      openMnemonicStrip(rawContent.id, actorOf(editor), probe),
    );

    // Reabertura simples, medido contra o Postgres real: assertRawContentReachable
    // (1 SELECT) + ruleBreakdown.findUnique (1 SELECT) + mnemonicStrip.findUnique
    // com relationLoadStrategy: 'join' (1 SELECT — LATERAL JOIN + JSONB_AGG, não
    // N+1 pelos 5 Quadros) + o COMMIT da `$transaction` — 4 eventos de query, não
    // 5 (que uma consulta N+1 por Quadro produziria).
    expect(queries).toHaveLength(4);
  });
});

/**
 * `reorderMnemonicFrames` (COMP-012-004) — reindexação atômica
 * em 2 fases (`reassignPositions`, DEC-012-003) e reordenação de Quadros
 * (FR-011-006). Reusa a mesma fixture de 5 Quadros de `openMnemonicStrip`.
 */
describe('reorderMnemonicFrames — reindexação correta em qualquer permutação, inclusive troca genuína de posição (AC-011-010)', () => {
  it('reorder inverte a sequência completa: posições finais 1..5 sem lacuna nem duplicidade, inclusive com swap genuíno', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(opened.frames).toHaveLength(5);

    const reversedOrder = [...opened.frames].reverse().map((frame) => frame.id);

    const reordered = await reorderMnemonicFrames(
      rawContent.id,
      { order: reversedOrder },
      actorOf(editor),
      testPrisma,
    );

    expect(reordered.frames.map((frame) => frame.id)).toEqual(reversedOrder);
    expect(reordered.frames.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5]);

    // Prova de SWAP genuíno (não um deslocamento sequencial): a posição
    // ANTIGA do 1º Quadro original (1) agora é a do ÚLTIMO original, e
    // vice-versa — exatamente o par que um "shift direto" sem 2 fases
    // colidiria contra `@@unique([stripId, position])` a meio caminho.
    const firstOriginal = opened.frames[0]!;
    const lastOriginal = opened.frames[opened.frames.length - 1]!;
    const firstAfter = reordered.frames.find((frame) => frame.id === firstOriginal.id);
    const lastAfter = reordered.frames.find((frame) => frame.id === lastOriginal.id);
    expect(firstAfter?.position).toBe(5);
    expect(lastAfter?.position).toBe(1);

    const persisted = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(persisted.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('reorderMnemonicFrames — alcance por autoria (AC-011-020, AC-011-022, gate 8, 2 métodos/2 provas)', () => {
  it('EDITOR B não alcança a Tira de Conteúdo bruto de EDITOR A, mesmo com um order VÁLIDO (conjunto real de A) — mesma mensagem literal de um rawContentId inexistente; posições de A intocadas', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContentOfA.id);
    const stripOfA = await openMnemonicStrip(rawContentOfA.id, actorOf(editorA), testPrisma);

    // `order` VÁLIDO — o conjunto real de ids de Quadros de A — para que a
    // única coisa capaz de barrar B seja o guard de alcance por autoria
    // (`assertRawContentReachable`), nunca `isExactFrameSet` (que aceitaria
    // este `order` sem reclamar, já que ele bate 1:1 com os ids de A).
    const validOrderOfA = [...stripOfA.frames].reverse().map((frame) => frame.id);

    const messageForOtherAuthor = await captureMessage(() =>
      reorderMnemonicFrames(
        rawContentOfA.id,
        { order: validOrderOfA },
        actorOf(editorB),
        testPrisma,
      ),
    );
    const messageForRandomId = await captureMessage(() =>
      reorderMnemonicFrames(randomUUID(), { order: validOrderOfA }, actorOf(editorB), testPrisma),
    );

    // Mesmo corolário de A01 do bloco `openMnemonicStrip` acima: os dois
    // casos são indistinguíveis pelo oráculo — nunca um "409 conjunto errado"
    // que revelaria a B que a Tira de A existe e que o conjunto de ids que
    // ele tentou está estruturalmente correto para ALGUMA Tira.
    expect(messageForOtherAuthor).toBe(messageForRandomId);
    expect(messageForOtherAuthor).toBe('Conteúdo bruto não encontrado.');

    const framesOfA = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripOfA.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(framesOfA.map((frame) => frame.position)).toEqual(
      stripOfA.frames.map((frame) => frame.position),
    );
  });
});

/**
 * Prova de atomicidade REAL (RISK-011-003, AC-011-011) — a garantia que
 * `@@unique([stripId, position])` só reprova (DEC-012-002) porque a
 * reindexação atravessa um estado transitório inválido: sem esta prova, o
 * gate de revisão teria só a DECLARAÇÃO de atomicidade (DEC-012-003), não a
 * demonstração.
 *
 * Mecanismo de interceptação: `jest.spyOn` NÃO alcança a chamada real feita
 * via `tx.mnemonicFrame.updateMany` — o objeto `tx` que `$transaction` entrega
 * ao callback é uma instância NOVA por transação (delegate próprio, sem
 * identidade compartilhada com `testPrisma.mnemonicFrame`); espiar o
 * delegate de `testPrisma` não intercepta nada dentro do `tx` (um spy nesse
 * ponto conta 0 chamadas). A interceptação que alcança a query REAL dentro da transação é
 * `$extends({ query: {...} })`: a extensão de client compõe no pipeline de
 * execução da query em si, e o `tx` herdado de um client estendido carrega a
 * MESMA composição — por isso o `db` injetado aqui é `testPrisma.$extends(...)`,
 * não `testPrisma` puro.
 */
describe('reorderMnemonicFrames — atomicidade REAL da reindexação em 2 fases (AC-011-011, RISK-011-003)', () => {
  it('falha real entre Fase 1 e Fase 2 não deixa nenhuma posição parcial persistida (AC-011-011)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(opened.frames).toHaveLength(5);

    const originalPositions = opened.frames
      .map((frame) => ({ id: frame.id, position: frame.position }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const reversedOrder = [...opened.frames].reverse().map((frame) => frame.id);

    let updateManyCallCount = 0;
    // `reassignPositions` chama `mnemonicFrame.updateMany` num laço de N
    // invocações por fase: com 5 Quadros, chamadas 1-5 são a Fase 1 (offset) e
    // 6-10 são a Fase 2 (final). Falhar na 8ª (3ª da Fase 2) garante que TODA
    // a Fase 1 e PARTE da Fase 2 já rodaram quando a falha ocorre — nem a 1ª
    // (6) nem a última (10) do laço da Fase 2.
    const FAILING_CALL_INDEX = 8;
    const extendedClient = testPrisma.$extends({
      query: {
        mnemonicFrame: {
          async updateMany({ args, query }) {
            updateManyCallCount += 1;
            if (updateManyCallCount === FAILING_CALL_INDEX) {
              throw new Error('falha injetada na Fase 2 (AC-011-011)');
            }
            return query(args);
          },
        },
      },
    });

    // `db` injetável de `reorderMnemonicFrames` é um tipo privado do módulo
    // (mesmo padrão de `MnemonicStripClient` — não exportado); o cliente
    // estendido por `$extends` carrega um generic de extensão que o TS não
    // infere como o mesmo tipo estrutural, embora implemente exatamente a
    // mesma superfície em runtime (prova empírica acima). Cast local,
    // restrito a este teste.
    await expect(
      reorderMnemonicFrames(
        rawContent.id,
        { order: reversedOrder },
        actorOf(editor),
        extendedClient as unknown as Parameters<typeof reorderMnemonicFrames>[3],
      ),
    ).rejects.toThrow('falha injetada na Fase 2 (AC-011-011)');

    // Prova de que a interceptação de fato alcançou a chamada REAL dentro da
    // transação (nunca simulação fora dela): a falha só dispara exatamente na
    // 8ª chamada — se o `db` injetado não fosse o cliente realmente usado
    // pela transação, `updateManyCallCount` teria ficado em 0.
    expect(updateManyCallCount).toBe(FAILING_CALL_INDEX);

    const afterFailure = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      select: { id: true, position: true },
    });
    const afterPositions = afterFailure
      .map((frame) => ({ id: frame.id, position: frame.position }))
      .sort((a, b) => a.id.localeCompare(b.id));

    // Nem a posição TEMPORÁRIA da Fase 1 (negativa) nem a posição FINAL
    // parcial da Fase 2 sobrevive — as posições voltam a ser IDÊNTICAS às de
    // antes da chamada, prova de que o ROLLBACK desfez a transação inteira.
    expect(afterPositions).toEqual(originalPositions);
  });
});

describe('reorderMnemonicFrames — 1ª mutação humana decide CONCLUSAO, demais decidem RETRABALHO (AC-011-014, DEC-012-006)', () => {
  it('1ª chamada de reorder bem-sucedida grava CONCLUSAO; 2ª chamada grava RETRABALHO, nunca uma 2ª CONCLUSAO', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const firstOrder = [...opened.frames].reverse().map((frame) => frame.id);
    await reorderMnemonicFrames(rawContent.id, { order: firstOrder }, actorOf(editor), testPrisma);

    const eventsAfterFirst = await productionEventsService.listProductionStageEvents(
      rawContent.id,
      testPrisma,
    );
    const tiraEventsAfterFirst = eventsAfterFirst
      .filter((event) => event.stageType === 'TIRA_MNEMONICA')
      .map((event) => event.transitionType);
    expect(tiraEventsAfterFirst).toEqual(['ABERTURA', 'CONCLUSAO']);

    const secondOrder = [...firstOrder].reverse();
    await reorderMnemonicFrames(rawContent.id, { order: secondOrder }, actorOf(editor), testPrisma);

    const eventsAfterSecond = await productionEventsService.listProductionStageEvents(
      rawContent.id,
      testPrisma,
    );
    const tiraEventsAfterSecond = eventsAfterSecond
      .filter((event) => event.stageType === 'TIRA_MNEMONICA')
      .map((event) => event.transitionType);
    expect(tiraEventsAfterSecond).toEqual(['ABERTURA', 'CONCLUSAO', 'RETRABALHO']);
  });
});

describe('reorderMnemonicFrames — rejeita order que não é exatamente o conjunto de ids da Tira (FR-011-006, contrato)', () => {
  it('order de A contendo 1 id de B (Tira distinta) é rejeitado; posições de A e de B permanecem intocadas', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();

    const rawContentA = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentA.id);
    const stripA = await openMnemonicStrip(rawContentA.id, actorOf(editor), testPrisma);

    const rawContentB = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentB.id);
    const stripB = await openMnemonicStrip(rawContentB.id, actorOf(editor), testPrisma);

    // Mesmo tamanho do conjunto real de A (5) — 4 ids de A + 1 id de B, no
    // lugar de um 5º id de A (que fica ausente).
    const invalidOrder = [
      ...stripA.frames.slice(0, 4).map((frame) => frame.id),
      stripB.frames[0]!.id,
    ];

    await expect(
      reorderMnemonicFrames(rawContentA.id, { order: invalidOrder }, actorOf(editor), testPrisma),
    ).rejects.toThrow(ConflictError);

    const framesA = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripA.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    const framesB = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripB.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(framesA.map((frame) => frame.position)).toEqual(
      stripA.frames.map((frame) => frame.position),
    );
    expect(framesB.map((frame) => frame.position)).toEqual(
      stripB.frames.map((frame) => frame.position),
    );
  });

  it('order com 1 id duplicado e outro id existente ausente (mesmo tamanho do conjunto real, conjunto errado) é rejeitado; posições intocadas', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const ids = opened.frames.map((frame) => frame.id);
    // Mesmo tamanho (5): o 1º id aparece duplicado, o último fica ausente.
    const invalidOrder = [ids[0]!, ids[0]!, ids[1]!, ids[2]!, ids[3]!];
    expect(invalidOrder).toHaveLength(ids.length);

    await expect(
      reorderMnemonicFrames(rawContent.id, { order: invalidOrder }, actorOf(editor), testPrisma),
    ).rejects.toThrow(ConflictError);

    const frames = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(frames.map((frame) => frame.position)).toEqual(
      opened.frames.map((frame) => frame.position),
    );
  });

  it('order como SUBCONJUNTO ESTRITO dos ids existentes (falta 1 id, sem duplicata) é rejeitado; posições intocadas', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(opened.frames).toHaveLength(5);

    // 4 dos 5 ids existentes, cada um aparecendo exatamente 1 vez — eixo de
    // CARDINALIDADE isolado (nem duplicata, nem id de outra Tira): só a
    // condição `order.length === existingIds.size` de `isExactFrameSet`
    // reprova este `order`; as outras 2 condições (duplicidade, pertencimento)
    // o aceitariam.
    const shortOrder = opened.frames.slice(0, 4).map((frame) => frame.id);
    expect(new Set(shortOrder).size).toBe(shortOrder.length);

    const message = await captureMessage(() =>
      reorderMnemonicFrames(rawContent.id, { order: shortOrder }, actorOf(editor), testPrisma),
    );
    expect(message).toBe(
      'A lista de quadros informada não corresponde aos quadros existentes na Tira.',
    );

    const frames = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(frames.map((frame) => frame.position)).toEqual(
      opened.frames.map((frame) => frame.position),
    );
  });
});

describe('reorderMnemonicFrames — fail-secure: falha na emissão do evento reverte a reindexação inteira (AC-011-015, NFR-011-003)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recordProductionStageEvent rejeitando dentro da transação → reorderMnemonicFrames rejeita; nenhuma posição nova persiste, nem sequer as temporárias da Fase 1', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const reversedOrder = [...opened.frames].reverse().map((frame) => frame.id);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(
      reorderMnemonicFrames(rawContent.id, { order: reversedOrder }, actorOf(editor), testPrisma),
    ).rejects.toThrow('falha simulada na emissão');

    const frames = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(frames).toEqual(
      opened.frames
        .map((frame) => ({ id: frame.id, position: frame.position }))
        .sort((a, b) => a.position - b.position),
    );
  });
});

/**
 * NFR-011-002 + lição [Performance] ("`include`/`select` aninhado de relação
 * não é 1 statement por padrão"), medido contra o Postgres real.
 *
 * O custo TOTAL de `reorderMnemonicFrames` ESCALA com o nº de Quadros — cada
 * reindexação custa 2×N `UPDATE`s (DEC-012-003/TRISK-012-002), e a Fase 2
 * PRECISA ser um laço de N invocações SEPARADAS (não 1 statement em lote)
 * para a prova de atomicidade real (AC-011-011) poder injetar falha numa
 * invocação intermediária. Por isso a asserção falsificável aqui não é
 * "contagem igual entre 3 e 5 Quadros" — é o DELTA marginal EXATO entre os
 * dois cenários: 2×(5-3) = 4. Esse delta prova duas coisas ao mesmo tempo:
 * (a) o custo de reindexação é EXATAMENTE 2 por Quadro adicional, nunca mais
 * (regressão do laço faria o delta crescer); (b) a leitura final de
 * `MnemonicStripDetail` (relationLoadStrategy: 'join') não contribui nenhuma
 * query extra por Quadro — se contribuísse, o delta seria maior que 4.
 * Números medidos contra o Postgres real (não presumidos): 14 queries para
 * N=3, 18 para N=5.
 */
describe('reorderMnemonicFrames — custo de reindexação cresce EXATAMENTE 2 queries por Quadro adicional (NFR-011-002, lição [Performance])', () => {
  it('reorder com 3 Quadros (14 queries) vs reorder com 5 Quadros (18 queries): delta EXATO de 4 — a leitura da relação `frames` não cresce com N', async () => {
    const editorA = await createUser('EDITOR');
    const topicIdA = await createTopic();
    const rawContentA = await createRawContent(editorA.id, topicIdA);
    await testPrisma.ruleBreakdown.create({
      data: {
        rawContentId: rawContentA.id,
        concept: BREAKDOWN_FIELDS.concept,
        action: BREAKDOWN_FIELDS.action,
        object: BREAKDOWN_FIELDS.object,
        condition: null,
        exception: null,
        essence: BREAKDOWN_FIELDS.essence,
      },
    });
    const openedA = await openMnemonicStrip(rawContentA.id, actorOf(editorA), testPrisma);
    expect(openedA.frames).toHaveLength(3);

    const editorB = await createUser('EDITOR');
    const topicIdB = await createTopic();
    const rawContentB = await createRawContent(editorB.id, topicIdB);
    await seedRuleBreakdown(rawContentB.id);
    const openedB = await openMnemonicStrip(rawContentB.id, actorOf(editorB), testPrisma);
    expect(openedB.frames).toHaveLength(5);

    const reversedA = [...openedA.frames].reverse().map((frame) => frame.id);
    const reversedB = [...openedB.frames].reverse().map((frame) => frame.id);

    const queriesForThree = await withQueryProbe((probe) =>
      reorderMnemonicFrames(rawContentA.id, { order: reversedA }, actorOf(editorA), probe),
    );
    const queriesForFive = await withQueryProbe((probe) =>
      reorderMnemonicFrames(rawContentB.id, { order: reversedB }, actorOf(editorB), probe),
    );

    expect(queriesForThree).toHaveLength(14);
    expect(queriesForFive).toHaveLength(18);
    expect(queriesForFive.length - queriesForThree.length).toBe(2 * (5 - 3));
  });
});

/**
 * `addMnemonicFrame`/`updateMnemonicFrameText`/`removeMnemonicFrame`
 * (COMP-012-004 / TASK-012-007) — CRUD de Quadro, reusando `reassignPositions`
 * (TASK-012-006) sem recriá-la. Reusa a mesma fixture de 5 Quadros de
 * `openMnemonicStrip`.
 */
describe('addMnemonicFrame — inserção desloca os Quadros seguintes sem lacuna nem duplicidade (AC-011-004, AC-011-005)', () => {
  it('adiciona no meio da sequência (posição 3 de 5): os 6 Quadros ficam com posições 1..6 contíguas, o novo entra exatamente na posição pedida', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(opened.frames).toHaveLength(5);

    const added = await addMnemonicFrame(
      rawContent.id,
      { text: 'Quadro novo inserido no meio', position: 3 },
      actorOf(editor),
      testPrisma,
    );

    expect(added.frames).toHaveLength(6);
    expect(added.frames.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5, 6]);

    const newFrame = added.frames.find((frame) => frame.text === 'Quadro novo inserido no meio');
    expect(newFrame?.position).toBe(3);
    expect(newFrame?.originBlock).toBeNull();

    // Os 2 Quadros originais que ocupavam a posição 3 em diante foram
    // deslocados 1 posição adiante, sem perder identidade nem texto.
    const originalAtThree = opened.frames[2]!;
    const originalAtFour = opened.frames[3]!;
    expect(added.frames.find((frame) => frame.id === originalAtThree.id)?.position).toBe(4);
    expect(added.frames.find((frame) => frame.id === originalAtFour.id)?.position).toBe(5);

    const persisted = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(persisted.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('adiciona na 1ª posição (clamped a 0): o novo Quadro assume a posição 1, todos os demais deslocam 1 adiante', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const added = await addMnemonicFrame(
      rawContent.id,
      { text: 'Quadro novo no início', position: 1 },
      actorOf(editor),
      testPrisma,
    );

    expect(added.frames).toHaveLength(6);
    expect(added.frames[0]?.text).toBe('Quadro novo no início');
    expect(added.frames.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(added.frames.slice(1).map((frame) => frame.id)).toEqual(
      opened.frames.map((frame) => frame.id),
    );
  });

  it('adiciona com posição 0 (fora do domínio validado pelo schema Zod na rota, mas o SERVICE não repete essa validação — chamado direto aqui) — clamped ao índice 0, MESMO resultado de position: 1', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const added = await addMnemonicFrame(
      rawContent.id,
      { text: 'Quadro com posição 0', position: 0 },
      actorOf(editor),
      testPrisma,
    );

    // Mutante-alvo: remover `Math.max(..., 0)` do clamp de `insertionIndex`
    // faz `input.position - 1` (aqui, -1) chegar cru a `existingIds.slice`,
    // que interpreta índice NEGATIVO contando do FIM do array — o novo
    // Quadro apareceria perto do FIM (posição 5), não no INÍCIO (posição 1)
    // como o clamp exige. Índice negativo é alcançável aqui porque o SERVICE
    // é chamado direto (sem o schema Zod da rota na frente).
    expect(added.frames).toHaveLength(6);
    expect(added.frames[0]?.text).toBe('Quadro com posição 0');
    expect(added.frames.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(added.frames.slice(1).map((frame) => frame.id)).toEqual(
      opened.frames.map((frame) => frame.id),
    );
  });

  it('adiciona além do fim da lista (posição maior que N+1, clamped ao final): o novo Quadro assume a última posição', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const added = await addMnemonicFrame(
      rawContent.id,
      { text: 'Quadro novo no fim', position: 999 },
      actorOf(editor),
      testPrisma,
    );

    expect(added.frames).toHaveLength(6);
    expect(added.frames[5]?.text).toBe('Quadro novo no fim');
    expect(added.frames.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(added.frames.map((frame) => frame.id).slice(0, 5)).toEqual(
      opened.frames.map((frame) => frame.id),
    );
  });
});

describe('updateMnemonicFrameText — texto persistido, posição intocada (AC-011-006, AC-011-007)', () => {
  it('atualiza o texto do Quadro do meio; a posição permanece a mesma e os demais Quadros não mudam', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const target = opened.frames[2]!;
    const updated = await updateMnemonicFrameText(
      rawContent.id,
      target.id,
      { text: 'Texto editado pelo EDITOR' },
      actorOf(editor),
      testPrisma,
    );

    const updatedFrame = updated.frames.find((frame) => frame.id === target.id);
    expect(updatedFrame?.text).toBe('Texto editado pelo EDITOR');
    expect(updatedFrame?.position).toBe(target.position);

    // Os demais Quadros permanecem com o texto e a posição originais.
    const others = updated.frames.filter((frame) => frame.id !== target.id);
    const originalOthers = opened.frames.filter((frame) => frame.id !== target.id);
    expect(others).toEqual(originalOthers);
  });
});

describe('removeMnemonicFrame — remoção do meio recompõe as posições sem lacuna (AC-011-008, AC-011-009)', () => {
  it('remove o Quadro da posição 2 (de 4): os 3 restantes recompõem para as posições 1,2,3, sem lacuna nem duplicidade', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await testPrisma.ruleBreakdown.create({
      data: {
        rawContentId: rawContent.id,
        concept: BREAKDOWN_FIELDS.concept,
        action: BREAKDOWN_FIELDS.action,
        object: BREAKDOWN_FIELDS.object,
        condition: BREAKDOWN_FIELDS.condition,
        exception: null,
        essence: BREAKDOWN_FIELDS.essence,
      },
    });
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(opened.frames).toHaveLength(4);

    const removedFrame = opened.frames[1]!;
    const remaining = await removeMnemonicFrame(
      rawContent.id,
      removedFrame.id,
      actorOf(editor),
      testPrisma,
    );

    expect(remaining.frames).toHaveLength(3);
    expect(remaining.frames.map((frame) => frame.id)).not.toContain(removedFrame.id);
    expect(remaining.frames.map((frame) => frame.position)).toEqual([1, 2, 3]);
    expect(remaining.frames.map((frame) => frame.id)).toEqual(
      [opened.frames[0]!, opened.frames[2]!, opened.frames[3]!].map((frame) => frame.id),
    );

    const persisted = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    expect(persisted.map((frame) => frame.position)).toEqual([1, 2, 3]);
  });
});

describe('removeMnemonicFrame — remover o ÚLTIMO Quadro restante esvazia a Tira, sem regeneração (AC-011-024, FR-011-002)', () => {
  it('remove os 3 Quadros um a um até `frames: []`; reabrir a Tira (openMnemonicStrip) NÃO gera novos Quadros', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdownWithoutOptionalBlocks(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(opened.frames).toHaveLength(3);

    let current = opened;
    for (const frame of [...opened.frames]) {
      current = await removeMnemonicFrame(rawContent.id, frame.id, actorOf(editor), testPrisma);
    }

    expect(current.frames).toEqual([]);

    const framesInDb = await testPrisma.mnemonicFrame.count({ where: { stripId: opened.id } });
    expect(framesInDb).toBe(0);

    const reopened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(reopened.id).toBe(opened.id);
    expect(reopened.frames).toEqual([]);
  });
});

describe('round-trip completo: add+edit+remove+reorder sobrevivem à reabertura (AC-011-012)', () => {
  it('sequência open→add→edit→remove→reorder sobre a MESMA Tira; reabrir devolve os Quadros restantes na ordem e texto da última mutação', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(opened.frames).toHaveLength(5);

    const added = await addMnemonicFrame(
      rawContent.id,
      { text: 'Sexto quadro adicionado', position: 6 },
      actorOf(editor),
      testPrisma,
    );
    expect(added.frames).toHaveLength(6);

    const frameToEdit = added.frames[0]!;
    const edited = await updateMnemonicFrameText(
      rawContent.id,
      frameToEdit.id,
      { text: 'Primeiro quadro, texto editado' },
      actorOf(editor),
      testPrisma,
    );

    const frameToRemove = edited.frames[1]!;
    const removed = await removeMnemonicFrame(
      rawContent.id,
      frameToRemove.id,
      actorOf(editor),
      testPrisma,
    );
    expect(removed.frames).toHaveLength(5);

    const reorderedIds = [...removed.frames].reverse().map((frame) => frame.id);
    const reordered = await reorderMnemonicFrames(
      rawContent.id,
      { order: reorderedIds },
      actorOf(editor),
      testPrisma,
    );
    expect(reordered.frames.map((frame) => frame.id)).toEqual(reorderedIds);

    const reopened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    expect(reopened.frames).toEqual(reordered.frames);
  });
});

/**
 * FR-011-009 nomeia 4 sujeitos de mutação humana (add/edit/remove/reorder);
 * reorder já provado em TASK-012-006 (bloco acima, "1ª mutação humana decide
 * CONCLUSAO..."). Aqui, 1 caso por FUNÇÃO nova desta TASK — cada uma sobre
 * uma Tira RECÉM-gerada (só ABERTURA emitida), confirmando que a 1ª mutação
 * humana decide CONCLUSAO e a 2ª decide RETRABALHO (DEC-012-006).
 */
describe('addMnemonicFrame — 1ª mutação humana decide CONCLUSAO, 2ª decide RETRABALHO (AC-011-014)', () => {
  it('1ª chamada de addMnemonicFrame grava CONCLUSAO; 2ª chamada grava RETRABALHO', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    await addMnemonicFrame(
      rawContent.id,
      { text: 'Quadro 1', position: 99 },
      actorOf(editor),
      testPrisma,
    );
    const eventsAfterFirst = (
      await productionEventsService.listProductionStageEvents(rawContent.id, testPrisma)
    )
      .filter((event) => event.stageType === 'TIRA_MNEMONICA')
      .map((event) => event.transitionType);
    expect(eventsAfterFirst).toEqual(['ABERTURA', 'CONCLUSAO']);

    await addMnemonicFrame(
      rawContent.id,
      { text: 'Quadro 2', position: 99 },
      actorOf(editor),
      testPrisma,
    );
    const eventsAfterSecond = (
      await productionEventsService.listProductionStageEvents(rawContent.id, testPrisma)
    )
      .filter((event) => event.stageType === 'TIRA_MNEMONICA')
      .map((event) => event.transitionType);
    expect(eventsAfterSecond).toEqual(['ABERTURA', 'CONCLUSAO', 'RETRABALHO']);
  });
});

describe('updateMnemonicFrameText — 1ª mutação humana decide CONCLUSAO, 2ª decide RETRABALHO (AC-011-014)', () => {
  it('1ª chamada de updateMnemonicFrameText grava CONCLUSAO; 2ª chamada grava RETRABALHO', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    const target = opened.frames[0]!;

    await updateMnemonicFrameText(
      rawContent.id,
      target.id,
      { text: 'Texto 1' },
      actorOf(editor),
      testPrisma,
    );
    const eventsAfterFirst = (
      await productionEventsService.listProductionStageEvents(rawContent.id, testPrisma)
    )
      .filter((event) => event.stageType === 'TIRA_MNEMONICA')
      .map((event) => event.transitionType);
    expect(eventsAfterFirst).toEqual(['ABERTURA', 'CONCLUSAO']);

    await updateMnemonicFrameText(
      rawContent.id,
      target.id,
      { text: 'Texto 2' },
      actorOf(editor),
      testPrisma,
    );
    const eventsAfterSecond = (
      await productionEventsService.listProductionStageEvents(rawContent.id, testPrisma)
    )
      .filter((event) => event.stageType === 'TIRA_MNEMONICA')
      .map((event) => event.transitionType);
    expect(eventsAfterSecond).toEqual(['ABERTURA', 'CONCLUSAO', 'RETRABALHO']);
  });
});

describe('removeMnemonicFrame — 1ª mutação humana decide CONCLUSAO, 2ª decide RETRABALHO (AC-011-014)', () => {
  it('1ª chamada de removeMnemonicFrame grava CONCLUSAO; 2ª chamada grava RETRABALHO', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(opened.frames.length).toBeGreaterThanOrEqual(2);

    await removeMnemonicFrame(rawContent.id, opened.frames[0]!.id, actorOf(editor), testPrisma);
    const eventsAfterFirst = (
      await productionEventsService.listProductionStageEvents(rawContent.id, testPrisma)
    )
      .filter((event) => event.stageType === 'TIRA_MNEMONICA')
      .map((event) => event.transitionType);
    expect(eventsAfterFirst).toEqual(['ABERTURA', 'CONCLUSAO']);

    await removeMnemonicFrame(rawContent.id, opened.frames[1]!.id, actorOf(editor), testPrisma);
    const eventsAfterSecond = (
      await productionEventsService.listProductionStageEvents(rawContent.id, testPrisma)
    )
      .filter((event) => event.stageType === 'TIRA_MNEMONICA')
      .map((event) => event.transitionType);
    expect(eventsAfterSecond).toEqual(['ABERTURA', 'CONCLUSAO', 'RETRABALHO']);
  });
});

/**
 * Fail-secure (AC-011-015, NFR-011-003) — 1 caso por função nova desta TASK,
 * mesmo padrão de `openMnemonicStrip`/`reorderMnemonicFrames` acima:
 * `recordProductionStageEvent` rejeitando dentro da transação reverte a
 * operação inteira — nenhum estado meio-salvo.
 */
describe('addMnemonicFrame — fail-secure: falha na emissão do evento não deixa Quadro parcial (AC-011-015)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recordProductionStageEvent rejeitando → addMnemonicFrame rejeita; nenhum Quadro novo persiste, os 5 originais intocados', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(
      addMnemonicFrame(
        rawContent.id,
        { text: 'Quadro que não deve persistir', position: 1 },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('falha simulada na emissão');

    const frames = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      orderBy: { position: 'asc' },
      select: { id: true, text: true, position: true },
    });
    expect(frames).toEqual(
      opened.frames
        .map((frame) => ({ id: frame.id, text: frame.text, position: frame.position }))
        .sort((a, b) => a.position - b.position),
    );
  });
});

describe('updateMnemonicFrameText — fail-secure: falha na emissão do evento preserva o texto anterior (AC-011-015)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recordProductionStageEvent rejeitando → updateMnemonicFrameText rejeita; o texto do Quadro permanece o de ANTES da tentativa', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    const target = opened.frames[0]!;

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(
      updateMnemonicFrameText(
        rawContent.id,
        target.id,
        { text: 'Texto que não deve persistir' },
        actorOf(editor),
        testPrisma,
      ),
    ).rejects.toThrow('falha simulada na emissão');

    const persisted = await testPrisma.mnemonicFrame.findUniqueOrThrow({
      where: { id: target.id },
      select: { text: true, position: true },
    });
    expect(persisted.text).toBe(target.text);
    expect(persisted.position).toBe(target.position);
  });
});

describe('removeMnemonicFrame — fail-secure: falha na emissão do evento não remove nem reposiciona nenhum Quadro (AC-011-015)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('recordProductionStageEvent rejeitando → removeMnemonicFrame rejeita; todos os Quadros originais permanecem, nenhuma posição muda', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    const target = opened.frames[1]!;

    jest
      .spyOn(productionEventsService, 'recordProductionStageEvent')
      .mockRejectedValueOnce(new Error('falha simulada na emissão'));

    await expect(
      removeMnemonicFrame(rawContent.id, target.id, actorOf(editor), testPrisma),
    ).rejects.toThrow('falha simulada na emissão');

    const frames = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: opened.id },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(frames).toEqual(
      opened.frames
        .map((frame) => ({ id: frame.id, position: frame.position }))
        .sort((a, b) => a.position - b.position),
    );
  });
});

/**
 * Confused deputy no `:frameId` (achado herdado do security-engineer, gate 8
 * da Wave 1, decisão 4.140) — mesmo corolário de A01 dos blocos de
 * `openMnemonicStrip`/`reorderMnemonicFrames` acima, aqui sobre o
 * `frameId`: o `stripId` autorizado é SEMPRE o resolvido a partir da CADEIA
 * do `rawContentId` da URL (Frame → Strip → RuleBreakdown → RawContent),
 * nunca aceito cru de um `frameId` de outra Tira. Guarda de pertencimento
 * `frameId`→`stripId` (defesa contra substituição de id, A01) com mutação
 * CONTÁVEL (decisão 4.139/4.232): 2 métodos tocam esse predicado nesta TASK
 * (`updateMnemonicFrameText`, `removeMnemonicFrame`) — 2 provas.
 */
describe('updateMnemonicFrameText — guarda de pertencimento frameId→stripId (confused deputy, A01, gate 8)', () => {
  it('rejeita frameId que não pertence à cadeia do rawContentId da URL', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();

    const rawContentA = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentA.id);
    const stripA = await openMnemonicStrip(rawContentA.id, actorOf(editor), testPrisma);

    const rawContentB = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentB.id);
    const stripB = await openMnemonicStrip(rawContentB.id, actorOf(editor), testPrisma);

    const frameOfB = stripB.frames[0]!;

    const message = await captureMessage(() =>
      updateMnemonicFrameText(
        rawContentA.id,
        frameOfB.id,
        { text: 'Não deveria persistir' },
        actorOf(editor),
        testPrisma,
      ),
    );
    expect(message).toBe('Quadro não encontrado.');

    // Nem o Quadro de A (nunca tocado) nem o de B (frameId usado, mas fora da
    // cadeia de A) sofrem qualquer alteração.
    const persistedFrameOfB = await testPrisma.mnemonicFrame.findUniqueOrThrow({
      where: { id: frameOfB.id },
      select: { text: true, position: true },
    });
    expect(persistedFrameOfB.text).toBe(frameOfB.text);
    expect(persistedFrameOfB.position).toBe(frameOfB.position);

    const framesOfA = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripA.id },
      orderBy: { position: 'asc' },
      select: { id: true, text: true, position: true },
    });
    expect(framesOfA).toEqual(
      stripA.frames
        .map((frame) => ({ id: frame.id, text: frame.text, position: frame.position }))
        .sort((a, b) => a.position - b.position),
    );
  });
});

describe('removeMnemonicFrame — guarda de pertencimento frameId→stripId (confused deputy, A01, gate 8)', () => {
  it('rejeita frameId que não pertence à cadeia do rawContentId da URL', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();

    const rawContentA = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentA.id);
    const stripA = await openMnemonicStrip(rawContentA.id, actorOf(editor), testPrisma);

    const rawContentB = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentB.id);
    const stripB = await openMnemonicStrip(rawContentB.id, actorOf(editor), testPrisma);

    const frameOfB = stripB.frames[0]!;

    const message = await captureMessage(() =>
      removeMnemonicFrame(rawContentA.id, frameOfB.id, actorOf(editor), testPrisma),
    );
    expect(message).toBe('Quadro não encontrado.');

    // Nenhum Quadro de A ou de B é removido nem reposicionado.
    const countA = await testPrisma.mnemonicFrame.count({ where: { stripId: stripA.id } });
    expect(countA).toBe(stripA.frames.length);
    const framesOfB = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripB.id },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(framesOfB).toEqual(
      stripB.frames
        .map((frame) => ({ id: frame.id, position: frame.position }))
        .sort((a, b) => a.position - b.position),
    );
  });
});

/**
 * Alcance por autoria nas 3 funções NOVAS desta TASK (NFR-011-001,
 * NFR-011-006, gate 8) — 2ª ocorrência da lição [Segurança] "Guarda reusada
 * continua exigindo prova comportamental própria por novo método de escrita":
 * a prova ESTRUTURAL de `tira.service.guard-order.test.ts` (ordem de
 * execução da guarda) não é capaz de acusar um mutante no VALOR do `actor`
 * passado a `assertRawContentReachable` (`{ ...actor, role: 'ADMIN' }`) — só
 * uma prova COMPORTAMENTAL, com um 2º editor real tentando alcançar Quadros
 * de outro dono, fecha isso. Mesmo padrão dos blocos de `openMnemonicStrip`/
 * `reorderMnemonicFrames` acima (editor A/B, mensagem literal comparada por
 * igualdade a um id inexistente). Cada teste cobre 2 vetores: (a) cross-tenant
 * (EDITOR B com argumentos VÁLIDOS de A) e (b) soft-delete do MESMO dono (A) —
 * negações distintas, nenhuma delas confundível com a outra.
 */
describe('addMnemonicFrame — alcance por autoria (AC-011-020, AC-011-022, NFR-011-001, NFR-011-006, gate 8)', () => {
  it('EDITOR B não alcança o Conteúdo bruto de A (cross-tenant, argumentos válidos); o mesmo Conteúdo bruto soft-deletado do PRÓPRIO dono também é recusado — Tira de A intocada nos dois casos', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();

    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContentOfA.id);
    const stripOfA = await openMnemonicStrip(rawContentOfA.id, actorOf(editorA), testPrisma);

    // (a) cross-tenant: rawContentId VÁLIDO (de A, Tira aberta) — só a
    // guarda de alcance por autoria pode barrar B.
    const messageForOtherAuthor = await captureMessage(() =>
      addMnemonicFrame(
        rawContentOfA.id,
        { text: 'Não deveria persistir (cross-tenant)', position: 1 },
        actorOf(editorB),
        testPrisma,
      ),
    );
    const messageForRandomId = await captureMessage(() =>
      addMnemonicFrame(
        randomUUID(),
        { text: 'Não deveria persistir (id inexistente)', position: 1 },
        actorOf(editorB),
        testPrisma,
      ),
    );
    expect(messageForOtherAuthor).toBe(messageForRandomId);
    expect(messageForOtherAuthor).toBe('Conteúdo bruto não encontrado.');

    const framesOfAAfterCrossTenant = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripOfA.id },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(framesOfAAfterCrossTenant).toEqual(
      stripOfA.frames.map((frame) => ({ id: frame.id, position: frame.position })),
    );

    // (b) vetor soft-delete: MESMO dono (A) — o Conteúdo bruto é soft-deletado
    // e a recusa passa a ser a de "removido" (distinta de (a), nunca a de
    // cross-tenant vazando para quem alcança o próprio dado).
    await testPrisma.rawContent.update({
      where: { id: rawContentOfA.id },
      data: { deletedAt: new Date() },
    });

    const messageForSoftDeleted = await captureMessage(() =>
      addMnemonicFrame(
        rawContentOfA.id,
        { text: 'Não deveria persistir (soft-deleted)', position: 1 },
        actorOf(editorA),
        testPrisma,
      ),
    );
    expect(messageForSoftDeleted).toBe('Conteúdo bruto foi removido.');

    const framesOfAAfterSoftDelete = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripOfA.id },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(framesOfAAfterSoftDelete).toEqual(framesOfAAfterCrossTenant);
  });
});

describe('updateMnemonicFrameText — alcance por autoria (AC-011-020, AC-011-022, NFR-011-001, NFR-011-006, gate 8)', () => {
  it('EDITOR B não alcança o Conteúdo bruto de A (cross-tenant, frameId válido de A); o mesmo Conteúdo bruto soft-deletado do PRÓPRIO dono também é recusado — texto e posição de A intocados nos dois casos', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();

    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContentOfA.id);
    const stripOfA = await openMnemonicStrip(rawContentOfA.id, actorOf(editorA), testPrisma);
    const targetFrame = stripOfA.frames[0]!;

    const messageForOtherAuthor = await captureMessage(() =>
      updateMnemonicFrameText(
        rawContentOfA.id,
        targetFrame.id,
        { text: 'Não deveria persistir (cross-tenant)' },
        actorOf(editorB),
        testPrisma,
      ),
    );
    const messageForRandomId = await captureMessage(() =>
      updateMnemonicFrameText(
        randomUUID(),
        targetFrame.id,
        { text: 'Não deveria persistir (id inexistente)' },
        actorOf(editorB),
        testPrisma,
      ),
    );
    expect(messageForOtherAuthor).toBe(messageForRandomId);
    expect(messageForOtherAuthor).toBe('Conteúdo bruto não encontrado.');

    const persistedAfterCrossTenant = await testPrisma.mnemonicFrame.findUniqueOrThrow({
      where: { id: targetFrame.id },
      select: { text: true, position: true },
    });
    expect(persistedAfterCrossTenant.text).toBe(targetFrame.text);
    expect(persistedAfterCrossTenant.position).toBe(targetFrame.position);

    await testPrisma.rawContent.update({
      where: { id: rawContentOfA.id },
      data: { deletedAt: new Date() },
    });

    const messageForSoftDeleted = await captureMessage(() =>
      updateMnemonicFrameText(
        rawContentOfA.id,
        targetFrame.id,
        { text: 'Não deveria persistir (soft-deleted)' },
        actorOf(editorA),
        testPrisma,
      ),
    );
    expect(messageForSoftDeleted).toBe('Conteúdo bruto foi removido.');

    const persistedAfterSoftDelete = await testPrisma.mnemonicFrame.findUniqueOrThrow({
      where: { id: targetFrame.id },
      select: { text: true, position: true },
    });
    expect(persistedAfterSoftDelete).toEqual(persistedAfterCrossTenant);
  });
});

describe('removeMnemonicFrame — alcance por autoria (AC-011-020, AC-011-022, NFR-011-001, NFR-011-006, gate 8)', () => {
  it('EDITOR B não alcança o Conteúdo bruto de A (cross-tenant, frameId válido de A); o mesmo Conteúdo bruto soft-deletado do PRÓPRIO dono também é recusado — nenhum Quadro de A é removido nem reposicionado nos dois casos', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();

    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContentOfA.id);
    const stripOfA = await openMnemonicStrip(rawContentOfA.id, actorOf(editorA), testPrisma);
    const targetFrame = stripOfA.frames[0]!;

    const messageForOtherAuthor = await captureMessage(() =>
      removeMnemonicFrame(rawContentOfA.id, targetFrame.id, actorOf(editorB), testPrisma),
    );
    const messageForRandomId = await captureMessage(() =>
      removeMnemonicFrame(randomUUID(), targetFrame.id, actorOf(editorB), testPrisma),
    );
    expect(messageForOtherAuthor).toBe(messageForRandomId);
    expect(messageForOtherAuthor).toBe('Conteúdo bruto não encontrado.');

    const framesOfAAfterCrossTenant = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripOfA.id },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(framesOfAAfterCrossTenant).toEqual(
      stripOfA.frames.map((frame) => ({ id: frame.id, position: frame.position })),
    );

    await testPrisma.rawContent.update({
      where: { id: rawContentOfA.id },
      data: { deletedAt: new Date() },
    });

    const messageForSoftDeleted = await captureMessage(() =>
      removeMnemonicFrame(rawContentOfA.id, targetFrame.id, actorOf(editorA), testPrisma),
    );
    expect(messageForSoftDeleted).toBe('Conteúdo bruto foi removido.');

    const framesOfAAfterSoftDelete = await testPrisma.mnemonicFrame.findMany({
      where: { stripId: stripOfA.id },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(framesOfAAfterSoftDelete).toEqual(framesOfAAfterCrossTenant);
  });
});

/**
 * NFR-011-002 (consumo da primitiva) + lição [Performance]
 * ("`include`/`select` aninhado de relação não é 1 statement por padrão"):
 * cada uma das 3 funções devolve `MnemonicStripDetail` inteiro com
 * round-trips FIXADOS — a leitura final (`findUniqueOrThrow` com
 * `relationLoadStrategy: 'join'`) é 1 SELECT único, não N+1 por Quadro.
 * Números medidos contra o Postgres real (não presumidos).
 */
describe('addMnemonicFrame — round-trips fixados (NFR-011-002, lição [Performance])', () => {
  it('adicionar 1 Quadro a uma Tira de 3 resolve com a contagem de queries FIXADA', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdownWithoutOptionalBlocks(rawContent.id);
    await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    const queries = await withQueryProbe((probe) =>
      addMnemonicFrame(
        rawContent.id,
        { text: 'Quadro medido', position: 1 },
        actorOf(editor),
        probe,
      ),
    );

    // assertRawContentReachable (1) + findStripId (ruleBreakdown 1 +
    // mnemonicStrip 1) + existingFrames.findMany (1) + create (1) +
    // reassignPositions (2×4 updates, lista final com 4 ids) +
    // recordProductionStageEvent (findMany 1 + create 1) + leitura final
    // (1) = 16, + 1 evento de query do próprio driver da transação (fixo
    // nas 3 medições desta TASK, ver `updateMnemonicFrameText`/
    // `removeMnemonicFrame` abaixo) = 17 — não N+1 por Quadro.
    expect(queries).toHaveLength(17);
  });
});

describe('updateMnemonicFrameText — round-trips fixados (NFR-011-002, lição [Performance])', () => {
  it('editar o texto de 1 Quadro resolve com a contagem de queries FIXADA', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    const target = opened.frames[0]!;

    const queries = await withQueryProbe((probe) =>
      updateMnemonicFrameText(
        rawContent.id,
        target.id,
        { text: 'Texto medido' },
        actorOf(editor),
        probe,
      ),
    );

    // assertRawContentReachable (1) + findStripId (2) + updateMany (1) +
    // recordProductionStageEvent (2) + leitura final (1) = 7, + 1 evento de
    // query do próprio driver da transação = 8 (mesmo overhead fixo medido
    // em `addMnemonicFrame`/`removeMnemonicFrame`).
    expect(queries).toHaveLength(8);
  });
});

describe('removeMnemonicFrame — round-trips fixados (NFR-011-002, lição [Performance])', () => {
  it('remover 1 Quadro do meio de uma Tira de 5 resolve com a contagem de queries FIXADA', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const opened = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    const target = opened.frames[1]!;

    const queries = await withQueryProbe((probe) =>
      removeMnemonicFrame(rawContent.id, target.id, actorOf(editor), probe),
    );

    // assertRawContentReachable (1) + findStripId (2) + deleteMany (1) +
    // remainingFrames.findMany (1) + reassignPositions (2×4 updates,
    // restaram 4) + recordProductionStageEvent (2) + leitura final (1) = 16,
    // + 1 evento de query do próprio driver da transação (mesmo overhead
    // fixo medido em `addMnemonicFrame`/`updateMnemonicFrameText` acima)
    // = 17.
    expect(queries).toHaveLength(17);
  });
});
