import {
  approveContentVersion,
  closeContentVersion,
} from '../../src/modules/content-versions/content-versions.service';
import type { ContentActor } from '../../src/modules/contents/contents.service';
import { buildStrategicPanel } from '../../src/modules/strategic-panel/strategic-panel.service';
import { seedApprovableRawContent } from '../support/approvable-raw-content-fixtures';
import { createTopic, createUser } from '../support/production-events-fixtures';
import { withQueryProbe } from '../support/query-probe';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * NFR-034-001 (custo constante) — sem N+1 no predicado de F9 por composição:
 * `buildStrategicPanel` (TASK-035-006) chamado com 10 e com 200 Conteúdos —
 * TODOS com Versão vigente APROVADA e NÃO alterada, o ramo que, em
 * `resolveAlterationSignal` (`content-versions.service.ts`, F9), faria 1
 * `findFirst` de Publicação TIRA por Conteúdo — produz **exatamente a mesma
 * contagem de statements** nos 2 volumes (DEC-035-014 v0.2: 7 — as 5 leituras
 * batch de sempre + o par `listApprovedVersionSnapshots`/
 * `listCurrentVersionedFieldsForApprovedContents`, só das aprovadas, no mesmo
 * `Promise.all`; 4 com 0% aprovado — o par acima é pulado quando o
 * subconjunto de aprovadas é vazio). Fixture gerada só via
 * `seedApprovableRawContent`/`closeContentVersion`/`approveContentVersion`
 * (RISK-034-004: nunca seed direto do Prisma para a leitura de eventos de
 * etapa — `closeContentVersion`/`approveContentVersion` emitem
 * `VERSAO_EDITORIAL`/`APROVACAO_VERSAO` via `recordProductionStageEvent` por
 * dentro).
 *
 * Cada `it` fixa e afirma a PRÓPRIA contagem, sem variável compartilhada
 * entre `it`s: roda isolado (`-t`) e passa.
 *
 * Falsificável: um mutante que reintroduzisse `resolveAlterationSignal` (ou
 * qualquer leitura) por Conteúdo aprovado faria a contagem do volume=200
 * divergir da contagem fixa (7) esperada.
 */

const APPROVE_INPUT = { legalCheckConfirmed: true, pedagogicalCheckConfirmed: true } as const;

function actorOf(user: { id: string; role: 'EDITOR' | 'ADMIN' }): ContentActor {
  return { id: user.id, role: user.role };
}

async function seedApprovedUnalteredPanelVolume(
  count: number,
  editor: { id: string },
  admin: { id: string },
  topicId: string,
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, async () => {
      const rawContent = await seedApprovableRawContent(editor.id, topicId);
      const closed = await closeContentVersion(
        rawContent.id,
        { legislativeClosureDate: '2026-09-01' },
        actorOf({ id: editor.id, role: 'EDITOR' }),
        testPrisma,
      );
      await approveContentVersion(
        rawContent.id,
        closed.number,
        APPROVE_INPUT,
        actorOf({ id: admin.id, role: 'ADMIN' }),
        testPrisma,
      );
    }),
  );
}

/** Nenhuma Versão fechada/aprovada — Conteúdo ativo puro, para o volume 0% aprovado. */
async function seedUnapprovedPanelVolume(
  count: number,
  editor: { id: string },
  topicId: string,
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, () => seedApprovableRawContent(editor.id, topicId)),
  );
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
  await testPrisma.$disconnect();
});

describe('NFR-034-001 — custo constante: mesma contagem de statements com 10 e com 200 Conteúdos', () => {
  // Cada `it` afirma a PRÓPRIA contagem, sem variável entre testes: a prova
  // de "mesma contagem nos 2 volumes" está em os 2 valores fixos (7) serem
  // literalmente o mesmo número, não numa comparação que dependa de ordem de
  // execução.
  it('volume=10, 100% aprovado e não alterado → 7 statements (contagem fixada)', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    await seedApprovedUnalteredPanelVolume(10, editor, admin, topicId);

    const queries = await withQueryProbe((probe) => buildStrategicPanel(new Date(), probe));
    expect(queries).toHaveLength(7);
  }, 120_000);

  it('volume=200, mesmo padrão (sem N+1 de F9) → 7 statements (mesma contagem do volume=10)', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    await seedApprovedUnalteredPanelVolume(200, editor, admin, topicId);

    const queries = await withQueryProbe((probe) => buildStrategicPanel(new Date(), probe));
    expect(queries).toHaveLength(7);
  }, 120_000);

  it('volume=10, 0% aprovado → 4 statements (par de leituras das aprovadas pulado)', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    await seedUnapprovedPanelVolume(10, editor, topicId);

    const queries = await withQueryProbe((probe) => buildStrategicPanel(new Date(), probe));
    expect(queries).toHaveLength(4);
  }, 120_000);
});
