import type { ContentActor } from '../../src/modules/contents/contents.service';
import type { CreateVisualAssociationBodyInput } from '../../src/modules/visual-associations/visual-associations.schema';
import { createVisualAssociation } from '../../src/modules/visual-associations/visual-associations.service';
import { createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `createVisualAssociation` (COMP-023-005 / TASK-023-008) direto contra o Postgres real,
 * sem passar pela rota — prova do contrato do próprio item (DEC-023-012) na camada onde
 * ele de fato se aplica: `visual-associations.routes.integration.test.ts` não consegue
 * levar um `authorId` espúrio até aqui (o teto `fields: 2` do `multer` recusa o 3º campo
 * antes de chegar ao service), então esta é a prova de que o SERVICE, por construção,
 * nunca lê `input.authorId`/`input.author` — mesmo que um dia outra fronteira (schema
 * mais permissivo, chamador direto) deixasse o campo passar.
 */

const PNG_FIXTURE_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function actorOf(user: { id: string; role: 'EDITOR' | 'ADMIN' | 'STUDENT' }): ContentActor {
  return { id: user.id, role: user.role };
}

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
