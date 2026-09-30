import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prova ESTRUTURAL (leitura textual do código-fonte, nunca da resposta em
 * runtime — item b, decisão 4.161): nenhuma das leituras em lote do Painel
 * estratégico (TASK-035-005) usa `include` — só `select` aninhado
 * (`RAW_CONTENT_SUMMARY_SELECT`/molde de `contents.service.ts`). A garantia de
 * 1 statement por `findMany`, mesmo com `select` aninhado de relação, vem do
 * preview feature `relationJoins` (`prisma/schema.prisma:13`), ligado
 * globalmente — provada por medição real em `query-count por função`
 * (`withQueryProbe`, `strategic-panel.service.integration.test.ts`), nunca
 * pela ausência de `include` aqui.
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
