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
 * `Promise.all`). Fixture gerada só via `seedApprovableRawContent`/
 * `closeContentVersion`/`approveContentVersion` (RISK-034-004: nunca seed
 * direto do Prisma para a leitura de eventos de etapa — `closeContentVersion`/
 * `approveContentVersion` emitem `VERSAO_EDITORIAL`/`APROVACAO_VERSAO` via
 * `recordProductionStageEvent` por dentro).
 *
 * Falsificável: um mutante que reintroduzisse `resolveAlterationSignal` (ou
 * qualquer leitura) por Conteúdo aprovado faria a contagem CRESCER com o
 * volume — 10 e 200 divergiriam, e a asserção de igualdade abaixo reprovaria.
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

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
  await testPrisma.$disconnect();
});

describe('NFR-034-001 — custo constante: mesma contagem de statements com 10 e com 200 Conteúdos', () => {
  // Fixada pelo 1º teste (volume=10), conferida pelo 2º (volume=200) — os 2
  // rodam nesta ordem no mesmo arquivo (Jest não paraleliza `it` de um mesmo
  // `describe`), e é essa comparação inter-teste que prova "mesma contagem",
  // não um número fixo redigitado 2 vezes.
  let smallVolumeStatementCount: number | undefined;

  it('volume=10, 100% aprovado e não alterado → 7 statements (contagem fixada)', async () => {
    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    await seedApprovedUnalteredPanelVolume(10, editor, admin, topicId);

    const queries = await withQueryProbe((probe) => buildStrategicPanel(new Date(), probe));
    // Contagem IMPRESSA — capturada, nunca presumida.
    // eslint-disable-next-line no-console
    console.info(`[NFR-034-001] volume=10 statements=${queries.length}`);
    expect(queries).toHaveLength(7);

    smallVolumeStatementCount = queries.length;
  }, 120_000);

  it('volume=200, mesmo padrão (sem N+1 de F9) → mesma contagem do volume=10', async () => {
    expect(smallVolumeStatementCount).toBeDefined();

    const editor = await createUser('EDITOR');
    const admin = await createUser('ADMIN');
    const topicId = await createTopic();
    await seedApprovedUnalteredPanelVolume(200, editor, admin, topicId);

    const queries = await withQueryProbe((probe) => buildStrategicPanel(new Date(), probe));
    // eslint-disable-next-line no-console
    console.info(`[NFR-034-001] volume=200 statements=${queries.length}`);
    expect(queries).toHaveLength(7);

    // Falsificável: um mutante que reintroduzisse `resolveAlterationSignal` (ou
    // qualquer leitura) por Conteúdo aprovado faria esta contagem CRESCER com o
    // volume — divergiria de `smallVolumeStatementCount` e esta asserção reprovaria.
    expect(queries.length).toBe(smallVolumeStatementCount);
  }, 120_000);
});
