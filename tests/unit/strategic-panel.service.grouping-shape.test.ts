import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prova ESTRUTURAL (achado do gate 10 da Wave 3, performance-engineer): nenhuma
 * coleção redistribuída por Conteúdo (eventos de etapa, Publicações Tira) usa
 * `.filter` dentro do laço `contents.map` de `buildStrategicPanel` — o agrupamento por
 * `rawContentId` roda uma vez, antes do laço, num `Map` (O(N+E)), nunca O(N·E).
 */
const STRATEGIC_PANEL_SERVICE = resolve(
  __dirname,
  '../../src/modules/strategic-panel/strategic-panel.service.ts',
);

/** Extrai o corpo do `contents.map((content) => { ... })` por balanceamento de chaves. */
function extractContentsMapBody(source: string): string {
  const marker = 'contents.map((content) => {';
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error('marcador `contents.map((content) => {` não encontrado no arquivo');
  }
  const bodyStart = start + marker.length;
  let depth = 1;
  let index = bodyStart;
  while (depth > 0) {
    if (index >= source.length) {
      throw new Error('chave de fechamento de `contents.map` não encontrada');
    }
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    index += 1;
  }
  return source.slice(bodyStart, index - 1);
}

describe('strategic-panel.service — sem redistribuição O(N·E) dentro de contents.map (estrutural)', () => {
  it('grep de `.filter(` no corpo do laço → 0 ocorrências', () => {
    const source = readFileSync(STRATEGIC_PANEL_SERVICE, 'utf8');
    const body = extractContentsMapBody(source);

    // Mutante: reintroduzir `stageEvents.filter(...)`/`tiraPublications.filter(...)`
    // (ou qualquer `.filter` por Conteúdo) dentro do laço faz esta asserção reprovar.
    expect(body.match(/\.filter\(/g) ?? []).toHaveLength(0);
  });

  it('calibração: o arquivo inteiro segue tendo `.filter(` fora do laço (approvedVersions)', () => {
    const source = readFileSync(STRATEGIC_PANEL_SERVICE, 'utf8');

    // Calibra o extrator contra 775172a: o arquivo ainda usa `.filter` para
    // isolar as Versões aprovadas (fora do laço `contents.map`) — se essa
    // ocorrência sumisse, o extrator acima poderia estar testando o corpo
    // errado sem que nenhuma asserção acusasse.
    const wholeFileMatches = (source.match(/\.filter\(/g) ?? []).length;
    expect(wholeFileMatches).toBeGreaterThanOrEqual(1);
  });
});
