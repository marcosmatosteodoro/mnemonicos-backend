import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prova ESTRUTURAL (leitura textual do código-fonte, nunca da resposta em
 * runtime — item b, decisão 4.161): nenhuma das 4 leituras em lote do Painel
 * estratégico (TASK-035-005) usa `include` — só `select` aninhado
 * (`RAW_CONTENT_SUMMARY_SELECT`/molde de `contents.service.ts`), que nunca
 * carrega uma relação inteira quando só um campo dela é consumido (lição
 * [Performance] "include/select aninhado de relação não é 1 statement por
 * padrão" não se aplica aqui só porque nenhuma chamada usa `include`).
 */
const STRATEGIC_PANEL_SERVICE = resolve(
  __dirname,
  '../../src/modules/strategic-panel/strategic-panel.service.ts',
);

describe('strategic-panel.service — nenhuma leitura usa include (estrutural)', () => {
  it('grep -c "include:" no arquivo inteiro → 0 ocorrências', () => {
    const source = readFileSync(STRATEGIC_PANEL_SERVICE, 'utf8');
    const includeMatches = source.match(/include:/g) ?? [];

    // Mutante: qualquer `findMany` trocado para `include` (mesmo aninhado,
    // mesmo comentado — a fonte inteira entra na varredura) faz esta
    // asserção reprovar.
    expect(includeMatches).toHaveLength(0);
  });
});
