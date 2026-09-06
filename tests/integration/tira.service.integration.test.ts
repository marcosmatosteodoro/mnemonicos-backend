import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client';
import { ConflictError } from '../../src/http/errors';
import type { ContentActor } from '../../src/modules/contents/contents.service';
// Namespace (não named import): espiar `recordProductionStageEvent` (AC-011-015,
// fail-secure) exige o objeto de módulo para `jest.spyOn` — mesmo padrão de
// `contents.service.integration.test.ts` (TASK-010-003). `tira.service.ts`
// segue importando por named import (mesmo padrão de `contents.service.ts`); o
// spy intercepta porque o emit deste projeto é CommonJS (perfil §11) — o named
// import vira acesso de propriedade a cada chamada, não um binding capturado.
import * as productionEventsService from '../../src/modules/production-events/production-events.service';
import { openMnemonicStrip } from '../../src/modules/tira/tira.service';
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
      'Conteúdo bruto foi removido.',
    );

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
