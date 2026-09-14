import { wrapTextToLines } from '../../src/modules/publication/pdf-layout';

describe('wrapTextToLines', () => {
  it('não quebra texto que cabe inteiro na largura máxima', () => {
    const lines = wrapTextToLines('abc def', 1000, () => 10);

    expect(lines).toEqual(['abc def']);
  });

  it('mantém palavra isolada maior que a largura máxima em linha própria, sem partir a palavra', () => {
    const text = 'oi palavragigante tchau';
    const measureWidth = (word: string): number => (word === 'palavragigante' ? 500 : 20);

    const lines = wrapTextToLines(text, 100, measureWidth);

    expect(lines).toEqual(['oi', 'palavragigante', 'tchau']);
    // a palavra gigante chega inteira numa das linhas — reconstrução por concatenação
    // prova que não houve corte por caractere.
    expect(lines.join(' ')).toBe(text);
  });

  it('quebra exatamente nas fronteiras em que a linha corrente ultrapassaria a largura máxima', () => {
    // fixture determinística: measureWidth(w) = comprimento * 10 + 10 (já inclui o
    // espaço). Cálculo à mão: um=30, dois=50, tres=50, quatro=70 — nenhum par cabe
    // junto em 45pt, então cada palavra cai na própria linha.
    const measureWidth = (word: string): number => word.length * 10 + 10;

    const lines = wrapTextToLines('um dois tres quatro', 45, measureWidth);

    expect(lines).toEqual(['um', 'dois', 'tres', 'quatro']);
  });

  it('devolve array vazio para texto vazio (formato decidido nesta task)', () => {
    const lines = wrapTextToLines('', 1000, () => 0);

    expect(lines).toEqual([]);
  });
});
