import { randomUUID } from 'node:crypto';

import { readVisualAssociationImage } from '../../src/modules/visual-associations/visual-association-storage';
import { createUser } from '../support/production-events-fixtures';
import {
  createVisualAssociation,
  PNG_FIXTURE_BUFFER,
} from '../support/visual-association-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `visual-association-storage.ts` (COMP-023-003): `readVisualAssociationImage` sobre o
 * Postgres real (`@prisma/adapter-pg`) — a linha é gravada direto via Prisma (mesmo
 * caminho que `visual-associations.service.ts` usa em produção, no MESMO INSERT/UPDATE),
 * nunca por uma função de escrita separada desta camada.
 */

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('readVisualAssociationImage — lê o binário persistido pelo Prisma', () => {
  it('lê de volta byte-a-byte o binário PNG gravado na criação da linha', async () => {
    const author = await createUser('EDITOR');
    const association = await createVisualAssociation(author.id, { imageData: PNG_FIXTURE_BUFFER });

    const read = await readVisualAssociationImage(testPrisma, association.id);

    expect(read).not.toBeNull();
    expect(Buffer.compare(read as Buffer, PNG_FIXTURE_BUFFER)).toBe(0);
  });

  it('devolve null para um id inexistente, sem lançar exceção', async () => {
    const missingId = randomUUID();

    await expect(readVisualAssociationImage(testPrisma, missingId)).resolves.toBeNull();
  });
});
