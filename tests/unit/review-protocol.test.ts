import { getReviewProtocolMarks } from '../../src/modules/publication/review-protocol';

/**
 * `getReviewProtocolMarks` (COMP-027-016 / TASK-027-006) — AC-026-014: o Protocolo impresso
 * nunca calcula data nem rastreia conclusão, ao contrário do scheduler SM-2
 * (`src/modules/review/scheduler.ts`) — só os 6 rótulos textuais fixos.
 */

const EXPECTED_ORDER = ['R0', 'R24', 'R3', 'R7', 'R14', 'R30'] as const;

const EXPECTED_LABELS = [
  '[ ] Revisão R0 — data: ___',
  '[ ] Revisão R24 — data: ___',
  '[ ] Revisão R3 — data: ___',
  '[ ] Revisão R7 — data: ___',
  '[ ] Revisão R14 — data: ___',
  '[ ] Revisão R30 — data: ___',
];

describe('getReviewProtocolMarks — AC-026-014 (1): assinatura sem parâmetro de tempo', () => {
  it('a função declara arity 0 — prova a AUSÊNCIA de cálculo, não o texto do rótulo', () => {
    // Mutante-alvo PARCIAL: acrescentar um parâmetro OBRIGATÓRIO, ou opcional SEM valor
    // default (`now?: Date`), muda `Function.length` de 0 para 1 — este teste reprovaria.
    // Um parâmetro COM valor default (`now: Date = new Date()`) NÃO move a arity (JS exclui
    // parâmetro com default da contagem de `Function.length`; mutante testado, sobrevive
    // aqui) — é a comparação literal do rótulo (bloco seguinte) que fecha essa lacuna,
    // reprovando qualquer rótulo calculado a partir de `now`.
    expect(getReviewProtocolMarks.length).toBe(0);
  });
});

describe('getReviewProtocolMarks — AC-026-014 (2): comparação literal, nunca regex de "ausência de dígito"', () => {
  it('devolve os 6 Marcos, um a um, com o texto literal fixo esperado (snapshot exato)', () => {
    const marks = getReviewProtocolMarks();

    expect(marks).toHaveLength(6);
    marks.forEach((mark, index) => {
      // Comparação literal — nunca `expect(mark.label).not.toMatch(/\d/)`: os próprios
      // códigos R0/R24/R3/R7/R14/R30 têm dígito por construção, e essa regex reprovaria a
      // implementação CORRETA (lição ativa).
      expect(mark.label).toBe(EXPECTED_LABELS[index]);
    });

    // Mutante-alvo: `getReviewProtocolMarks` devolvendo uma data calculada
    // (`` `Revisão ${code} — feita em ${now.toISOString()}` ``) no lugar do rótulo fixo
    // reprova esta comparação literal.
  });
});

describe('getReviewProtocolMarks — AC-026-013: ordem fixa R0, R24, R3, R7, R14, R30', () => {
  it('os 6 `code`s vêm na ordem canônica exata', () => {
    const marks = getReviewProtocolMarks();

    expect(marks.map((mark) => mark.code)).toEqual(EXPECTED_ORDER);

    // Mutante-alvo (AC-026-013): reordenar 2 Marcos na fonte (ex.: trocar R3 e R7 de
    // posição) faz este `toEqual` reprovar — asserção de ORDEM, não só de conjunto.
  });

  it('devolve uma cópia nova a cada chamada — mutar o array devolvido não contamina a próxima leitura', () => {
    const first = getReviewProtocolMarks();
    first.reverse();

    const second = getReviewProtocolMarks();

    expect(second.map((mark) => mark.code)).toEqual(EXPECTED_ORDER);
  });
});
