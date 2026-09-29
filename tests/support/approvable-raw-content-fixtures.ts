import type { VersionedContentFields } from '../../src/modules/content-versions/versioned-content-diff';
import { testPrisma } from '../integration/db';
import { createRawContent, seedRuleBreakdown } from './production-events-fixtures';
import { buildVersionedContentFields } from './versioned-content-fields-fixtures';

/**
 * `RawContent`+`RuleBreakdown` elegíveis para `approveContentVersion` — reusa
 * `createRawContent`/`seedRuleBreakdown` e só sobrescreve `sourceType`/
 * `sourceCitation`/`sourceUrl` (ausentes por padrão em `createRawContent` —
 * necessário para passar a barreira de FR-032-013), via `update` direto (sem
 * tocar `lastEditedById`/`lastEditedAt`). Fonte dos valores de override:
 * `buildVersionedContentFields` (`tests/support/`) — helper único (perfil
 * node-22.md §7), reusado por `content-versions.service.integration.test.ts`
 * e `publication.service.integration.test.ts`.
 */
export async function seedApprovableRawContent(
  authorId: string,
  topicId: string,
  overrides: Partial<
    Pick<VersionedContentFields, 'sourceType' | 'sourceCitation' | 'sourceUrl'>
  > = {},
) {
  const { sourceType, sourceCitation, sourceUrl } = buildVersionedContentFields(overrides);
  const rawContent = await createRawContent(authorId, topicId);
  await seedRuleBreakdown(rawContent.id);
  return testPrisma.rawContent.update({
    where: { id: rawContent.id },
    data: { sourceType, sourceCitation, sourceUrl },
  });
}
