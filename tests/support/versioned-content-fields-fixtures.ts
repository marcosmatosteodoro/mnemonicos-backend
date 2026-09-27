import type { VersionedContentFields } from '../../src/modules/content-versions/versioned-content-diff';

/**
 * Fixture compartilhada dos 11 campos versionados (`VersionedContentFields`) —
 * helper único (perfil node-22.md §7, "Fixtures compartilhadas"): builder com
 * defaults + overrides, para uma coluna nova não quebrar as cópias uma a uma.
 */
export function buildVersionedContentFields(
  overrides: Partial<VersionedContentFields> = {},
): VersionedContentFields {
  return {
    rawText: 'Art. 113 do CTN define a obrigação tributária.',
    radarClass: 'ALTA',
    sourceType: 'LEI',
    sourceCitation: 'Lei 5.172/1966',
    sourceUrl: 'https://exemplo.gov.br/lei-5172',
    concept: 'Vínculo jurídico entre Fisco e contribuinte.',
    action: 'Cobrar o tributo devido.',
    object: 'A obrigação tributária.',
    condition: 'Quando há substituição tributária.',
    exception: 'Salvo isenção legal expressa.',
    essence: 'Nasce da ocorrência do fato gerador.',
    ...overrides,
  };
}
