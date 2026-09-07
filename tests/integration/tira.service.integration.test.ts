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
import { openMnemonicStrip, reorderMnemonicFrames } from '../../src/modules/tira/tira.service';
import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
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

const BREAKDOWN_FIELDS = {
  concept: 'Vínculo jurídico entre Fisco e contribuinte.',
  action: 'Cobrar o tributo devido.',
  object: 'A obrigação tributária.',
  condition: 'Quando há substituição tributária.',
  exception: 'Salvo isenção legal expressa.',
  essence: 'Nasce da ocorrência do fato gerador.',
};

async function seedRuleBreakdown(rawContentId: string) {
  return testPrisma.ruleBreakdown.create({
    data: { rawContentId, ...BREAKDOWN_FIELDS },
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
 * Fechamento contável (item (c) da régua de contorno): 1 método desta TASK
 * toca tabela escopada por autoria herdada (`mnemonicStrip`/`mnemonicFrame`,
 * via a cadeia `RawContent → RuleBreakdown → MnemonicStrip`) —
 * `openMnemonicStrip` — 1 prova (este caso).
 */
describe('openMnemonicStrip — alcance por autoria (AC-011-022, NFR-011-001, gate 8, 1 método/1 prova)', () => {
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
 * `reorderMnemonicFrames` (COMP-012-004 / TASK-012-006) — reindexação atômica
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
 * delegate de `testPrisma` não intercepta nada dentro do `tx` (confirmado
 * empiricamente antes de escrever este teste — um spy nesse ponto conta 0
 * chamadas). A interceptação que alcança a query REAL dentro da transação é
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
 * Adaptação declarada (fatia sensível — ver report da TASK-012-006): o custo
 * TOTAL de `reorderMnemonicFrames` ESCALA com o nº de Quadros — cada
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
