import {
  hasVersionedContentChanged,
  type VersionedContentFields,
} from '../../src/modules/content-versions/versioned-content-diff';

/**
 * `hasVersionedContentChanged` (COMP-029-003, TASK-029-003) — função PURA, sem I/O:
 * (a) os mesmos 11 campos → `false`; (b) qualquer 1 dos 11 campos divergente → `true`,
 * 1 teste por campo (fechamento contável por CAMPO, não por "1 teste representativo").
 */

const BASE: VersionedContentFields = {
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
};

describe('hasVersionedContentChanged — mesmos 11 campos (AC-028-013, caso simétrico)', () => {
  it('current e snapshot idênticos (mesmo objeto de valores, cópias distintas) → false', () => {
    const current: VersionedContentFields = { ...BASE };
    const snapshot: VersionedContentFields = { ...BASE };

    expect(hasVersionedContentChanged(current, snapshot)).toBe(false);
  });
});

describe('hasVersionedContentChanged — 1 campo divergente → true (fechamento por CAMPO, 11 casos)', () => {
  it.each<[keyof VersionedContentFields, VersionedContentFields[keyof VersionedContentFields]]>([
    ['rawText', 'Texto bruto alterado.'],
    ['radarClass', 'MEDIA'],
    ['sourceType', 'CF'],
    ['sourceCitation', 'Outra citação'],
    ['sourceUrl', 'https://exemplo.gov.br/outra'],
    ['concept', 'Outro conceito.'],
    ['action', 'Outra ação.'],
    ['object', 'Outro objeto.'],
    ['condition', 'Outra condição.'],
    ['exception', 'Outra exceção.'],
    ['essence', 'Outra síntese.'],
  ])('campo "%s" divergente → true', (field, alteredValue) => {
    const current: VersionedContentFields = { ...BASE, [field]: alteredValue };
    const snapshot: VersionedContentFields = { ...BASE };

    expect(hasVersionedContentChanged(current, snapshot)).toBe(true);
  });
});
