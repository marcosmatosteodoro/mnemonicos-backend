import { buildInitialFrames } from '../../src/modules/tira/tira.service';

/**
 * `buildInitialFrames` (TASK-012-005 / COMP-012-004) — regra pura de geração
 * inicial da Tira mnemônica: 1 Quadro por Bloco não-vazio da Quebra, ordem
 * canônica CONCEITO → AÇÃO → OBJETO → CONDIÇÃO → EXCEÇÃO, posições 1..N sem
 * lacuna (AC-011-001, AC-011-002). Sem I/O — mesmo espírito de
 * `decideStageTransition`.
 */
describe('buildInitialFrames — geração a partir dos Blocos não-vazios (AC-011-001)', () => {
  it('5 Blocos preenchidos → 5 Quadros, ordem canônica, posições 1..5 sem lacuna', () => {
    const breakdown = {
      concept: 'Vínculo jurídico entre Fisco e contribuinte.',
      action: 'Cobrar o tributo devido.',
      object: 'A obrigação tributária.',
      condition: 'Quando há substituição tributária.',
      exception: 'Salvo isenção legal expressa.',
    };

    const frames = buildInitialFrames(breakdown);

    // Falsificável: trocar a ordem de 2 blocos reprova esta sequência.
    expect(frames.map((frame) => frame.originBlock)).toEqual([
      'concept',
      'action',
      'object',
      'condition',
      'exception',
    ]);
    expect(frames.map((frame) => frame.position)).toEqual([1, 2, 3, 4, 5]);
    expect(frames.map((frame) => frame.text)).toEqual([
      breakdown.concept,
      breakdown.action,
      breakdown.object,
      breakdown.condition,
      breakdown.exception,
    ]);
  });
});

describe('buildInitialFrames — Blocos opcionais vazios não geram Quadro (AC-011-002)', () => {
  it('CONDIÇÃO e EXCEÇÃO como null → exatamente 3 Quadros (concept/action/object), posições 1..3 sem lacuna', () => {
    const breakdown = {
      concept: 'Conceito.',
      action: 'Ação.',
      object: 'Objeto.',
      condition: null,
      exception: null,
    };

    const frames = buildInitialFrames(breakdown);

    // Falsificável: incluir um Bloco vazio como Quadro reprova o tamanho do array.
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.originBlock)).toEqual(['concept', 'action', 'object']);
    expect(frames.map((frame) => frame.position)).toEqual([1, 2, 3]);
  });

  it('CONDIÇÃO e EXCEÇÃO como string vazia ("") também não geram Quadro', () => {
    const breakdown = {
      concept: 'Conceito.',
      action: 'Ação.',
      object: 'Objeto.',
      condition: '',
      exception: '',
    };

    const frames = buildInitialFrames(breakdown);

    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.originBlock)).toEqual(['concept', 'action', 'object']);
  });
});
