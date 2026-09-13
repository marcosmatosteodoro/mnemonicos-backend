import { randomUUID } from 'node:crypto';

import type { ContentActor } from '../../src/modules/contents/contents.service';
import { testPrisma } from '../integration/db';

/**
 * Fixtures compartilhadas de `VisualAssociation` (COMP-023-001/003/005) — helper único
 * (perfil node-22.md §7, "Fixtures compartilhadas"): usado por
 * `visual-associations.routes.integration.test.ts`,
 * `visual-associations.model.integration.test.ts`,
 * `visual-associations.service.integration.test.ts` e
 * `visual-association-storage.integration.test.ts`.
 */

/**
 * Prefixo de PNG — assinatura de 8 bytes + cabeçalho do chunk IHDR; basta para magic
 * bytes (`detectImageSignature`), não é um PNG decodificável (sem IDAT/IEND).
 */
export const PNG_FIXTURE_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/** `ContentActor` a partir de um usuário de fixture (`createUser`). */
export function actorOf(user: { id: string; role: 'EDITOR' | 'ADMIN' | 'STUDENT' }): ContentActor {
  return { id: user.id, role: user.role };
}

/**
 * `VisualAssociation` gravada direto via `testPrisma` — fixture de setup, fora do
 * service/rota sob teste. `overrides.imageData` permite o caso sem binário ainda
 * (`Buffer.alloc(0)`, usado por `visual-association-storage.integration.test.ts` antes
 * de gravar o binário de verdade).
 */
export async function createVisualAssociation(
  authorId: string,
  overrides: {
    category?: string;
    cognitiveDescription?: string;
    imageData?: Buffer;
    mimeType?: string;
  } = {},
) {
  return testPrisma.visualAssociation.create({
    data: {
      authorId,
      category: overrides.category ?? `Categoria ${randomUUID()}`,
      cognitiveDescription: overrides.cognitiveDescription ?? 'Cena que ancora a regra na memória.',
      // `Buffer` é `Uint8Array<ArrayBufferLike>`; o campo `Bytes` do Prisma espera
      // `Uint8Array<ArrayBuffer>` — só o parâmetro genérico diverge (mesmo gotcha de
      // `visual-associations.service.ts`, node-22.md §11).
      imageData: (overrides.imageData ?? PNG_FIXTURE_BUFFER) as unknown as Uint8Array<ArrayBuffer>,
      mimeType: overrides.mimeType ?? 'image/png',
    },
  });
}
