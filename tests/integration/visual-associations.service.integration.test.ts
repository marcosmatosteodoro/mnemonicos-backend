import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client';
import type {
  CreateVisualAssociationBodyInput,
  UpdateVisualAssociationBodyInput,
} from '../../src/modules/visual-associations/visual-associations.schema';
import {
  createVisualAssociation,
  listVisualAssociations,
  updateVisualAssociation,
} from '../../src/modules/visual-associations/visual-associations.service';
import { createUser } from '../support/production-events-fixtures';
import {
  actorOf,
  createVisualAssociation as seedVisualAssociation,
  linkFrameToAssociation,
  PNG_FIXTURE_BUFFER,
  softDeleteRawContentRow,
} from '../support/visual-association-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';
import { TEST_DATABASE_URL } from './db-url';

/**
 * Sonda de round-trips (lição [Performance]) — mesmo padrão local de
 * `contents.service.integration.test.ts`/`tira.service.integration.test.ts`.
 */
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

/**
 * `createVisualAssociation`/`updateVisualAssociation` (COMP-023-005) direto contra o
 * Postgres real, sem passar pela rota — prova de que o SERVICE, por construção, nunca lê
 * `input.authorId`/`input.author`: o `data` do `create`/`update` é montado campo a campo
 * (DEC-023-012), então mesmo que uma fronteira mais permissiva (schema, chamador direto)
 * deixasse o campo espúrio passar, ele nunca alcançaria o INSERT/UPDATE. A fronteira HTTP
 * real (`requireAuth` + Zod) é provada em `visual-associations.routes.integration.test.ts`
 * — para `POST`, os 3 campos (`category`+`cognitiveDescription`+`authorId`) excedem o teto
 * `fields: 2` do `multer` (só governa o transporte multipart) antes de chegar ao service;
 * para `PATCH`, o `.partial()` permite `authorId` chegar dentro do teto (multipart) ou via
 * `application/json` (que não passa pelo `multer`), e o service o descarta do mesmo jeito.
 */

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('createVisualAssociation — authorId é SEMPRE actor.id (DEC-023-012)', () => {
  it('um campo authorId espúrio presente no objeto de input (em runtime) é ignorado — a linha criada pertence ao ator real', async () => {
    const editor = await createUser('EDITOR');
    const other = await createUser('EDITOR');

    // `CreateVisualAssociationBodyInput` não declara `authorId` — o `as` simula um
    // input que, por alguma fronteira futura mais permissiva, ainda carregasse o campo
    // em runtime (o schema Zod atual já o descarta antes disso, TASK-023-003).
    const spoofedInput = {
      category: 'Tributário',
      cognitiveDescription: 'Ilustra o fato gerador.',
      authorId: other.id,
    } as CreateVisualAssociationBodyInput;

    const created = await createVisualAssociation(
      spoofedInput,
      { buffer: PNG_FIXTURE_BUFFER, sizeBytes: PNG_FIXTURE_BUFFER.length },
      actorOf(editor),
      testPrisma,
    );

    // Mutante: `authorId: (input as { authorId?: string }).authorId ?? actor.id` faz
    // esta asserção reprovar — o campo espúrio venceria.
    expect(created.authorId).toBe(editor.id);
    expect(created.authorId).not.toBe(other.id);

    const row = await testPrisma.visualAssociation.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.authorId).toBe(editor.id);
  });
});

describe('updateVisualAssociation — authorId é SEMPRE o autor original (DEC-023-012)', () => {
  it('um campo authorId espúrio presente no objeto de input (em runtime) é ignorado — a linha editada permanece do autor original', async () => {
    const editor = await createUser('EDITOR');
    const other = await createUser('EDITOR');
    const existing = await seedVisualAssociation(editor.id);

    // `UpdateVisualAssociationBodyInput` não declara `authorId` — o `as` simula um
    // input que, por alguma fronteira futura mais permissiva, ainda carregasse o campo
    // em runtime (o schema Zod atual já o descarta antes disso, TASK-023-003).
    const spoofedInput = {
      category: 'Tributário',
      authorId: other.id,
    } as UpdateVisualAssociationBodyInput;

    const updated = await updateVisualAssociation(
      existing.id,
      spoofedInput,
      undefined,
      actorOf(editor),
      testPrisma,
    );

    // Mutante: `authorId: (input as { authorId?: string }).authorId` reintroduzido no
    // `data` do `update` faz esta asserção reprovar — o campo espúrio venceria.
    expect(updated.authorId).toBe(editor.id);
    expect(updated.authorId).not.toBe(other.id);

    const row = await testPrisma.visualAssociation.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(row.authorId).toBe(editor.id);
  });
});

/**
 * `listVisualAssociations` (COMP-023-005 / TASK-023-014) — round-trips fixados em
 * teste (lição [Performance] "include/select aninhado de relação não é 1 statement por
 * padrão", TRISK-023-005): a contagem de `linkCount` atravessa `frames` →
 * `strip` → `ruleBreakdown` → `rawContent.deletedAt` via `_count` FILTRADO — medido
 * contra o Postgres real, não presumido.
 */
describe('listVisualAssociations — round-trips fixados (TRISK-023-005, lição [Performance])', () => {
  it('listagem de 1 associação sem nenhum vínculo resolve com a contagem de queries FIXADA (findMany + count)', async () => {
    const editor = await createUser('EDITOR');
    await seedVisualAssociation(editor.id);

    const queries = await withQueryProbe((probe) =>
      listVisualAssociations({ page: 1, perPage: 20 }, probe),
    );

    expect(queries).toHaveLength(2);
  });

  it('3 associações semeadas, cada uma com 2 vínculos (1 ativo + 1 soft-deleted) → AINDA exatamente as mesmas 2 queries (o _count filtrado não cresce com o nº de associações nem com o nº de vínculos)', async () => {
    const editor = await createUser('EDITOR');
    for (let i = 0; i < 3; i += 1) {
      const association = await seedVisualAssociation(editor.id);
      const active = await linkFrameToAssociation(editor, association.id);
      const softDeleted = await linkFrameToAssociation(editor, association.id);
      await softDeleteRawContentRow(softDeleted.rawContentId);
      void active;
    }

    const queries = await withQueryProbe((probe) =>
      listVisualAssociations({ page: 1, perPage: 20 }, probe),
    );

    expect(queries).toHaveLength(2);
  });
});
