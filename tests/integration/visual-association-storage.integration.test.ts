import { randomUUID } from 'node:crypto';

import {
  readVisualAssociationImage,
  saveVisualAssociationImage,
} from '../../src/modules/visual-associations/visual-association-storage';
import { createUser } from '../support/production-events-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `visual-association-storage.ts` (COMP-023-003 / TASK-023-006): as 2 funções
 * operam sobre a MESMA `$transaction`/client recebido do chamador, nunca
 * abrindo transação própria — provado aqui gravando e lendo o binário DENTRO
 * de uma `$transaction` real do Postgres (`@prisma/adapter-pg`).
 */

/** PNG de 1x1, mesma assinatura de bytes usada em `image-signature.test.ts`. */
const PNG_FIXTURE_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function createVisualAssociationWithoutImage(authorId: string) {
  return testPrisma.visualAssociation.create({
    data: {
      authorId,
      category: `Categoria ${randomUUID()}`,
      cognitiveDescription: 'Cena que ancora a regra na memória.',
      // Linha criada sem imagem ainda — o buffer real chega via
      // `saveVisualAssociationImage`, dentro da transação do teste.
      imageData: Buffer.alloc(0),
      mimeType: 'image/png',
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('saveVisualAssociationImage / readVisualAssociationImage — round-trip byte-a-byte na MESMA $transaction', () => {
  it('grava um buffer PNG real e lê de volta byte-a-byte, dentro da MESMA transação', async () => {
    const author = await createUser('EDITOR');
    const association = await createVisualAssociationWithoutImage(author.id);

    const read = await testPrisma.$transaction(async (tx) => {
      await saveVisualAssociationImage(tx, association.id, PNG_FIXTURE_BUFFER);
      return readVisualAssociationImage(tx, association.id);
    });

    expect(read).not.toBeNull();
    expect(Buffer.compare(read as Buffer, PNG_FIXTURE_BUFFER)).toBe(0);

    // Confirma que a escrita persistiu além da transação (commit real), não
    // um estado só visível dentro do callback.
    const persisted = await readVisualAssociationImage(testPrisma, association.id);
    expect(persisted).not.toBeNull();
    expect(Buffer.compare(persisted as Buffer, PNG_FIXTURE_BUFFER)).toBe(0);
  });

  it('devolve null para um id inexistente, sem lançar exceção', async () => {
    const missingId = randomUUID();

    await expect(readVisualAssociationImage(testPrisma, missingId)).resolves.toBeNull();
  });
});
