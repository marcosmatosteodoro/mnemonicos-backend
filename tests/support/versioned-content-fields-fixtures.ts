import type { VersionedContentFields } from '../../src/modules/content-versions/versioned-content-diff';
import { BREAKDOWN_FIELDS, RAW_CONTENT_TEXT_FIELDS } from './production-events-fixtures';

/**
 * Fixture compartilhada dos 11 campos versionados (`VersionedContentFields`) —
 * helper único (perfil node-22.md §7, "Fixtures compartilhadas"): builder com
 * defaults + overrides, para uma coluna nova não quebrar as cópias uma a uma.
 * Compõe a partir de `RAW_CONTENT_TEXT_FIELDS`/`BREAKDOWN_FIELDS` (mesmas
 * fontes de `createRawContent`/`seedRuleBreakdown`) — só os 3 campos de fonte
 * normativa (`sourceType`/`sourceCitation`/`sourceUrl`, ausentes por padrão em
 * `createRawContent`) nascem aqui.
 */
export function buildVersionedContentFields(
  overrides: Partial<VersionedContentFields> = {},
): VersionedContentFields {
  return {
    ...RAW_CONTENT_TEXT_FIELDS,
    sourceType: 'LEI',
    sourceCitation: 'Lei 5.172/1966',
    sourceUrl: 'https://exemplo.gov.br/lei-5172',
    ...BREAKDOWN_FIELDS,
    ...overrides,
  };
}
