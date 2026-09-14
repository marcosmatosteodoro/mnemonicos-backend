import { randomUUID } from 'node:crypto';

import type { ContentActor } from '../../src/modules/contents/contents.service';
import { openMnemonicStrip } from '../../src/modules/tira/tira.service';
import { testPrisma } from '../integration/db';
import { createRawContent, createTopic, seedRuleBreakdown } from './production-events-fixtures';

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

/**
 * Assinatura WEBP mínima — RIFF (offset 0) + `WEBP` (offset 8), os únicos bytes que
 * `detectImageSignature` exige. Promovida para cá (retry do gate 7/DRY, TASK-025-008):
 * fonte única para `visual-associations.routes.integration.test.ts`,
 * `image-signature.test.ts` e `publication.service.integration.test.ts` (os 2 primeiros
 * mantêm a cópia local pré-existente, fora do escopo deste retry).
 */
export const WEBP_FIXTURE_BUFFER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
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

/**
 * Monta a cadeia RawContent→RuleBreakdown→MnemonicStrip→MnemonicFrame (via
 * `openMnemonicStrip`, TASK-012-005) e vincula o 1º Quadro gerado à `associationId` —
 * gravado direto via `testPrisma` (isola o vínculo do comportamento de
 * `tira.service.ts`, que não é o alvo das provas de leitura/remoção do acervo). `author`
 * é sempre quem "alcança" o vínculo por autoria (FR-022-022/FR-022-019) — abre a Tira
 * como o próprio autor. Único ponto de montagem — usado por
 * `visual-associations.routes.integration.test.ts` (TASK-023-010/014) e
 * `visual-associations.service.integration.test.ts` (TASK-023-014, sonda de
 * round-trips).
 */
export async function linkFrameToAssociation(
  author: { id: string },
  associationId: string,
): Promise<{ rawContentId: string; frameId: string }> {
  const topicId = await createTopic();
  const rawContent = await createRawContent(author.id, topicId);
  await seedRuleBreakdown(rawContent.id);
  const actor: ContentActor = { id: author.id, role: 'EDITOR' };
  const strip = await openMnemonicStrip(rawContent.id, actor, testPrisma);
  const frame = strip.frames[0];
  if (frame === undefined) throw new Error('Tira gerada sem nenhum Quadro.');

  await testPrisma.mnemonicFrame.update({
    where: { id: frame.id },
    data: { visualAssociationId: associationId },
  });
  return { rawContentId: rawContent.id, frameId: frame.id };
}

/** Soft-delete direto via `testPrisma` (setup — não é o service `softDeleteRawContent` sob teste). */
export async function softDeleteRawContentRow(rawContentId: string): Promise<void> {
  await testPrisma.rawContent.update({
    where: { id: rawContentId },
    data: { deletedAt: new Date() },
  });
}
