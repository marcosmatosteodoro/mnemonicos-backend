/**
 * Composição de layout do PDF (COMP-025-002): quebra de texto livre em linhas que cabem
 * numa largura máxima, sem I/O e sem import da biblioteca de geração de PDF — mesmo
 * espírito de `buildInitialFrames` (`tira.service.ts`) e `decideStageTransition`
 * (`production-events.service.ts`), funções puras já existentes no acervo. A medição real
 * de largura (`font.widthOfTextAtSize`) é responsabilidade do chamador (`pdf-composer.ts`,
 * TASK-025-007) — esta função só recebe `measureWidth` injetado.
 */

/**
 * Quebra `text` em linhas que não ultrapassam `maxWidthPt`, medindo cada palavra por
 * `measureWidth` (já inclui a largura do espaço que a separa da próxima — o chamador não
 * soma espaço à parte). Greedy: acumula palavras na linha corrente enquanto couberem;
 * palavra isolada maior que `maxWidthPt` nunca é partida por caractere — ocupa a própria
 * linha (a primeira palavra de uma linha sempre entra, mesmo excedendo o limite).
 */
export function wrapTextToLines(
  text: string,
  maxWidthPt: number,
  measureWidth: (word: string) => number,
): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  const words = trimmed.split(/\s+/);
  const lines: string[] = [];

  let currentLineWords: string[] = [];
  let currentLineWidth = 0;

  for (const word of words) {
    const wordWidth = measureWidth(word);

    if (currentLineWords.length === 0) {
      currentLineWords = [word];
      currentLineWidth = wordWidth;
      continue;
    }

    if (currentLineWidth + wordWidth <= maxWidthPt) {
      currentLineWords.push(word);
      currentLineWidth += wordWidth;
      continue;
    }

    lines.push(currentLineWords.join(' '));
    currentLineWords = [word];
    currentLineWidth = wordWidth;
  }

  if (currentLineWords.length > 0) lines.push(currentLineWords.join(' '));

  return lines;
}
