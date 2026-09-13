import type { CreateVisualAssociationBodyInput } from '../../src/modules/visual-associations/visual-associations.schema';
import { createVisualAssociation } from '../../src/modules/visual-associations/visual-associations.service';
import { createUser } from '../support/production-events-fixtures';
import { actorOf, PNG_FIXTURE_BUFFER } from '../support/visual-association-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `createVisualAssociation` (COMP-023-005) direto contra o Postgres real, sem passar
 * pela rota — prova de que o SERVICE, por construção, nunca lê `input.authorId`/
 * `input.author`: o `data` do `create` é montado campo a campo (DEC-023-012), então
 * mesmo que uma fronteira mais permissiva (schema, chamador direto) deixasse o campo
 * espúrio passar, ele nunca alcançaria o INSERT. A fronteira HTTP real (`requireAuth` +
 * Zod) é provada em `visual-associations.routes.integration.test.ts` — para `POST`, os 3
 * campos (`category`+`cognitiveDescription`+`authorId`) excedem o teto `fields: 2` do
 * `multer` (só governa o transporte multipart) antes de chegar ao service; para `PATCH`,
 * o `.partial()` permite `authorId` chegar dentro do teto (multipart) ou via
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
