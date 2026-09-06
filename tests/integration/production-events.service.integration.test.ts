import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  listProductionStageEvents,
  recordProductionStageEvent,
} from '../../src/modules/production-events/production-events.service';
import { createRawContent, createTopic, createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `production-events.service.ts` (COMP-010-002 / TASK-010-002) — mecanismo de
 * emissão e leitura de eventos de etapa. Simula a sequência de chamadas que
 * `contents.service.ts` faz: `createRawContent` emitindo abertura+conclusão
 * de "Conteúdo bruto" e abertura de "Quebra da regra" na mesma transação
 * (§4 de PLAN-010).
 */

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('recordProductionStageEvent → listProductionStageEvents — round-trip completo (AC-009-006, parte 2/2)', () => {
  it('grava 1 evento com os 5 campos de auditoria e a releitura os devolve intactos e iguais ao input', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const now = new Date('2026-09-06T12:00:00.000Z');

    await testPrisma.$transaction((tx) =>
      recordProductionStageEvent(tx, {
        rawContentId: rawContent.id,
        stageType: 'CONTEUDO_BRUTO',
        actorId: editor.id,
        now,
      }),
    );

    const events = await listProductionStageEvents(rawContent.id, testPrisma);

    expect(events).toHaveLength(1);
    const [event] = events;
    if (!event) throw new Error('fixture não gerou evento — assert acima já deveria ter reprovado');

    expect(event.rawContentId).toBe(rawContent.id);
    expect(event.stageType).toBe('CONTEUDO_BRUTO');
    // 0 eventos existentes para o par → decisão pura é ABERTURA (1ª emissão).
    expect(event.transitionType).toBe('ABERTURA');
    expect(event.actorId).toBe(editor.id);
    expect(event.occurredAt.toISOString()).toBe(now.toISOString());
  });
});

describe('recordProductionStageEvent — decisão por histórico dentro da MESMA transação (FR-009-006, FR-009-007)', () => {
  it('2ª emissão do mesmo par vê a abertura já gravada na mesma tx e decide CONCLUSAO', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const now = new Date('2026-09-06T12:00:00.000Z');

    await testPrisma.$transaction(async (tx) => {
      await recordProductionStageEvent(tx, {
        rawContentId: rawContent.id,
        stageType: 'CONTEUDO_BRUTO',
        actorId: editor.id,
        now,
      });
      await recordProductionStageEvent(tx, {
        rawContentId: rawContent.id,
        stageType: 'CONTEUDO_BRUTO',
        actorId: editor.id,
        now,
      });
    });

    const events = await listProductionStageEvents(rawContent.id, testPrisma);
    expect(events.map((event) => event.transitionType)).toEqual(['ABERTURA', 'CONCLUSAO']);
  });
});

/**
 * AC-009-008 — ordem determinística e estável, mesmo com `occurredAt`
 * idêntico: abre 1 `prisma.$transaction` de teste (harness, não produção —
 * TRISK-010-001) e chama `recordProductionStageEvent` 3× com o mesmo `now`,
 * simulando a sequência real de `createRawContent` (§4 de PLAN-010): abertura
 * + conclusão de "Conteúdo bruto", depois abertura de "Quebra da regra".
 * `listProductionStageEvents` é chamada 2× (consultas repetidas) para provar
 * que a ordem não é fruto de acaso de uma única leitura.
 */
describe('listProductionStageEvents — ordem determinística e estável entre consultas repetidas (AC-009-008)', () => {
  it('3 emissões com o mesmo `now`, na sequência de createRawContent → mesma ordem [ABERTURA-CB, CONCLUSAO-CB, ABERTURA-QR] em 2 leituras seguidas', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    const now = new Date('2026-09-06T12:00:00.000Z');

    await testPrisma.$transaction(async (tx) => {
      // 1) abertura de "Conteúdo bruto" — 0 eventos existentes para o par.
      await recordProductionStageEvent(tx, {
        rawContentId: rawContent.id,
        stageType: 'CONTEUDO_BRUTO',
        actorId: editor.id,
        now,
      });
      // 2) conclusão de "Conteúdo bruto" — já existe a abertura do passo 1.
      await recordProductionStageEvent(tx, {
        rawContentId: rawContent.id,
        stageType: 'CONTEUDO_BRUTO',
        actorId: editor.id,
        now,
      });
      // 3) abertura de "Quebra da regra" — 0 eventos existentes para este outro par.
      await recordProductionStageEvent(tx, {
        rawContentId: rawContent.id,
        stageType: 'QUEBRA_DA_REGRA',
        actorId: editor.id,
        now,
      });
    });

    const expectedOrder: Array<{
      stageType: 'CONTEUDO_BRUTO' | 'QUEBRA_DA_REGRA';
      transitionType: 'ABERTURA' | 'CONCLUSAO';
    }> = [
      { stageType: 'CONTEUDO_BRUTO', transitionType: 'ABERTURA' },
      { stageType: 'CONTEUDO_BRUTO', transitionType: 'CONCLUSAO' },
      { stageType: 'QUEBRA_DA_REGRA', transitionType: 'ABERTURA' },
    ];

    const firstRead = await listProductionStageEvents(rawContent.id, testPrisma);
    const secondRead = await listProductionStageEvents(rawContent.id, testPrisma);

    // Todos os 3 eventos compartilham o mesmo `occurredAt` — o desempate
    // determinístico vem só de `sequence` (DEC-010-002), nunca do timestamp.
    expect(firstRead.every((event) => event.occurredAt.toISOString() === now.toISOString())).toBe(
      true,
    );

    const toComparable = (events: typeof firstRead) =>
      events.map((event) => ({ stageType: event.stageType, transitionType: event.transitionType }));

    expect(toComparable(firstRead)).toEqual(expectedOrder);
    // Consulta repetida (mesmos dados, sem nova escrita) devolve a MESMA
    // ordem — não é artefato de uma única leitura.
    expect(toComparable(secondRead)).toEqual(expectedOrder);
    expect(firstRead.map((event) => event.id)).toEqual(secondRead.map((event) => event.id));
  });
});

/**
 * AC-009-006 (parte 1/2) — tripwire estrutural de append-only: nenhum dos dois
 * consumidores CONHECIDOS do model `ProductionStageEvent` nesta fatia
 * (`production-events.service.ts`, o mecanismo em si; `contents.service.ts`,
 * o único outro arquivo do repo que poderia vir a mutar o model) contém uma
 * chamada real de mutação além de `.create(` sobre `productionStageEvent`.
 * Varredura NÃO-EXAUSTIVA, declarada (decisão 4.161/4.369): cobre os
 * consumidores conhecidos do model NESTA FATIA, não todo o repo — um arquivo
 * novo que vier a importar o service em fatia futura (F4-F9) não é coberto
 * por este teste.
 *
 * Comentários/docblocks são removidos do texto antes do match, para que a
 * asserção fique ancorada na CHAMADA real (`.productionStageEvent.update(` em
 * código executável), nunca numa menção em prosa dentro de um comentário.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MUTATION_CALL_PATTERN =
  /\.productionStageEvent\.(update|updateMany|delete|deleteMany|upsert)\s*\(/;

const PRODUCTION_EVENTS_SERVICE = resolve(
  __dirname,
  '../../src/modules/production-events/production-events.service.ts',
);
const CONTENTS_SERVICE = resolve(__dirname, '../../src/modules/contents/contents.service.ts');

describe('Tripwire estrutural — nenhuma mutação (update/updateMany/delete/deleteMany/upsert) sobre productionStageEvent (AC-009-006, parte 1/2)', () => {
  it.each([
    ['production-events.service.ts', PRODUCTION_EVENTS_SERVICE],
    ['contents.service.ts', CONTENTS_SERVICE],
  ])(
    '%s não contém nenhuma chamada de mutação sobre productionStageEvent além de .create(',
    (_label, path) => {
      const source = stripComments(readFileSync(path, 'utf8'));
      expect(MUTATION_CALL_PATTERN.test(source)).toBe(false);
    },
  );

  it('controle positivo: o padrão casa uma chamada de mutação sintética e ignora a mesma chamada dentro de comentário', () => {
    expect(
      MUTATION_CALL_PATTERN.test('await tx.productionStageEvent.update({ where, data });'),
    ).toBe(true);
    expect(
      stripComments('// await tx.productionStageEvent.update({ where, data });').includes(
        'productionStageEvent.update',
      ),
    ).toBe(false);
    // Fecha o ponto cego de um `stripComments`/padrão neutralizado (ex.: virar
    // no-op) deixando os dois testes acima "verdes por ausência de execução":
    // confirma, no texto REAL pós-stripComments, que a chamada .create( que
    // sabemos existir continua presente — se stripComments apagasse tudo, ou
    // se o arquivo mudasse de import, esta linha reprovaria primeiro.
    expect(stripComments(readFileSync(PRODUCTION_EVENTS_SERVICE, 'utf8'))).toContain(
      '.productionStageEvent.create(',
    );
  });
});
