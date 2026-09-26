/**
 * Protocolo impresso de revisão (COMP-027-016): os 6 Marcos fixos do método TAP
 * (R0, R24, R3, R7, R14, R30), na ordem canônica — texto estático, sem I/O e sem
 * parâmetro de tempo. Nunca calcula data nem rastreia conclusão (A-026-002/FR-026-022):
 * os 6 Marcos fixos não reusam o scheduler SM-2 (`src/modules/review/scheduler.ts`), que é
 * uma variante com ease factor dinâmico — incompatível por design com um protocolo
 * impresso de preenchimento manual.
 */

export interface ReviewProtocolMark {
  code: 'R0' | 'R24' | 'R3' | 'R7' | 'R14' | 'R30';
  label: string;
}

/**
 * `[ ]` no lugar do glifo de caixa de seleção (`☐`, U+2610) do exemplo literal de
 * AC-026-013/PLAN-027 §3: a fonte padrão embutida pelo motor de composição
 * (`StandardFonts.Helvetica`, `pdf-composer.ts`) só codifica WinAnsi/cp1252 — `page.drawText`
 * lança para qualquer code point fora dela (mesma restrição já documentada em
 * `pdf-composer.ts` para o texto do usuário, TRISK-025-007). `[ ]` preserva o mesmo papel
 * (caixa para marcação manual) dentro do alfabeto renderizável.
 */
const REVIEW_PROTOCOL_MARKS: readonly ReviewProtocolMark[] = [
  { code: 'R0', label: '[ ] Revisão R0 — data: ___' },
  { code: 'R24', label: '[ ] Revisão R24 — data: ___' },
  { code: 'R3', label: '[ ] Revisão R3 — data: ___' },
  { code: 'R7', label: '[ ] Revisão R7 — data: ___' },
  { code: 'R14', label: '[ ] Revisão R14 — data: ___' },
  { code: 'R30', label: '[ ] Revisão R30 — data: ___' },
];

/** Devolve os 6 Marcos fixos, sempre na mesma ordem (AC-026-013) — nova cópia a cada
 * chamada (o array interno nunca é exposto por referência a quem chama). */
export function getReviewProtocolMarks(): ReviewProtocolMark[] {
  return REVIEW_PROTOCOL_MARKS.map((mark) => ({ ...mark }));
}
