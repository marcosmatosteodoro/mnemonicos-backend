import {
  NORMATIVE_SOURCE_TYPES,
  PROOF_RADAR_CLASSES,
  type NormativeSourceType,
  type ProofRadarClass,
  type RawContent,
  type RuleBreakdown,
} from '../../src/domain/types';

/**
 * Uso não-nulo dos tipos de Conteúdo bruto e Quebra da regra introduzidos em
 * `domain/types.ts` (TASK-006-004). A rede de divergência cross-repo sobre os
 * dois enums é `domain-types-parity.test.ts`, estendida em TASK-006-007; este
 * teste só prova que os símbolos exportados aqui tipam valores concretos.
 */
describe('tipos de Conteúdo bruto e Quebra da regra — domain/types.ts', () => {
  it('expõe as 5 classes do radar de prova', () => {
    expect([...PROOF_RADAR_CLASSES].sort()).toEqual(
      ['ALTA', 'DETALHE', 'EXCECAO', 'MEDIA', 'PEGADINHA'].sort(),
    );
  });

  it('expõe os 6 tipos de fonte normativa', () => {
    expect([...NORMATIVE_SOURCE_TYPES].sort()).toEqual(
      ['ATO_NORMATIVO', 'CF', 'CTN', 'LEI', 'LEI_COMPLEMENTAR', 'SUMULA'].sort(),
    );
  });

  it('constrói um RawContent não-nulo com todos os campos preenchidos', () => {
    const radarClass: ProofRadarClass = 'PEGADINHA';
    const sourceType: NormativeSourceType = 'CTN';
    const now = new Date('2026-01-01T00:00:00.000Z');

    const rawContent: RawContent = {
      id: '0192f8a0-0000-7000-8000-000000000001',
      topicId: '0192f8a0-0000-7000-8000-000000000002',
      authorId: '0192f8a0-0000-7000-8000-000000000003',
      rawText: 'O fato gerador da obrigação tributária principal...',
      radarClass,
      sourceType,
      sourceCitation: 'art. 113, CTN',
      sourceUrl: null,
      lastEditedById: null,
      lastEditedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    expect(rawContent.radarClass).toBe('PEGADINHA');
    expect(PROOF_RADAR_CLASSES).toContain(rawContent.radarClass);
    expect(rawContent.sourceType).not.toBeNull();
  });

  it('constrói um RuleBreakdown não-nulo com todos os campos preenchidos', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const breakdown: RuleBreakdown = {
      id: '0192f8a0-0000-7000-8000-000000000004',
      rawContentId: '0192f8a0-0000-7000-8000-000000000001',
      concept: 'Obrigação tributária',
      action: 'Pagar tributo ou penalidade',
      object: 'Prestação pecuniária',
      condition: 'Ocorrência do fato gerador',
      exception: null,
      essence: 'Vínculo jurídico entre Fisco e contribuinte',
      createdAt: now,
      updatedAt: now,
    };

    expect(breakdown.rawContentId).toBe('0192f8a0-0000-7000-8000-000000000001');
    expect(breakdown.condition).not.toBeNull();
  });
});
