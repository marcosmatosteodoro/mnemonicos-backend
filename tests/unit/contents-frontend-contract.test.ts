import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Rede de paridade cross-repo das interfaces do Conteúdo bruto / Quebra da
 * regra (EMENDA pós gate 1-7, Wave 3 — TASK-006-010). Análoga a
 * `domain-types-parity.test.ts`, mas para as interfaces de `contents.service.ts`
 * (backend) × `src/types/domain.ts` (frontend): lê os dois arquivos como texto
 * e prova que os NOMES e a FORMA dos campos são idênticos dos dois lados — não
 * um fixture que se autoconfirma a partir de um dos lados (`api.test.ts`
 * montava o fixture a partir do próprio tipo do frontend, e não teria
 * acusado nenhuma das 4 divergências abaixo).
 *
 * As 4 divergências que este teste fecha (achado do code-reviewer, retry
 * Wave 3):
 *   1. `RawContentSummary`: `rawText`/`hasRuleBreakdown` (backend) vs.
 *      `rawTextExcerpt`/`hasBreakdown` (frontend, pré-retry) — alinhado ao
 *      nome do backend (o texto nunca foi truncado).
 *   2. `RuleBreakdown` do frontend prometia `id`/`rawContentId`/`createdAt`/
 *      `updatedAt` que `RuleBreakdownDetail` (backend) nunca devolve —
 *      removidos do frontend.
 *   3. `condition`/`exception`: fronteira do schema (Zod) passou a aceitar
 *      `null` (fixado em `contents.schema.test.ts`, não aqui — comparação de
 *      forma de interface não alcança comportamento de parse).
 *   4. `RawContent.deletedAt`: nunca projetado por `RAW_CONTENT_DETAIL_SELECT`
 *      — removido do tipo do frontend.
 *
 * Repos symlinkados no workspace (mesmo padrão de `domain-types-parity.test.ts`):
 * o arquivo do frontend é lido pelo caminho relativo a partir daqui.
 */
const BACKEND_SERVICE = resolve(__dirname, '../../src/modules/contents/contents.service.ts');
const FRONTEND_TYPES = resolve(__dirname, '../../../mnemonicos-frontend/src/types/domain.ts');

function readSourceFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `arquivo não encontrado: ${path}\n` +
        'checkout irmão mnemonicos-frontend ausente — este teste de paridade ' +
        'exige os dois repos no workspace.',
    );
  }
  return readFileSync(path, 'utf8');
}

/**
 * Extrai os nomes de campo de uma interface TypeScript pela leitura textual
 * do arquivo (sem AST) — mesmo mecanismo de `extractSessionUserFields` em
 * `domain-types-parity.test.ts`, generalizado para qualquer interface.
 * Assume corpo sem chave `{`/`}` aninhada (as interfaces comparadas aqui são
 * flat — nenhum campo com tipo objeto inline).
 */
function extractInterfaceFields(source: string, interfaceName: string): string[] {
  const pattern = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`);
  const match = pattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`declaração de interface ${interfaceName} não encontrada`);
  }
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*'))
    .map((line) => /^(\w+)\??\s*:/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

describe('paridade cross-repo — RawContentSummary/RuleBreakdown/RawContent (EMENDA pós gate 1-7, Wave 3)', () => {
  const backendSource = readSourceFile(BACKEND_SERVICE);
  const frontendSource = readSourceFile(FRONTEND_TYPES);

  it('RawContentSummary: mesmo conjunto de campos nos dois repositórios (rawText/hasRuleBreakdown, não rawTextExcerpt/hasBreakdown)', () => {
    const backendFields = extractInterfaceFields(backendSource, 'RawContentSummary').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'RawContentSummary').sort();

    expect(backendFields).toEqual(
      [
        'id',
        'rawText',
        'disciplineName',
        'topicName',
        'radarClass',
        'sourceCitation',
        'hasRuleBreakdown',
      ].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: reverter o frontend para `rawTextExcerpt`/`hasBreakdown` (ou o
    // backend para outro nome) faz esta comparação reprovar.
    expect(frontendFields).not.toContain('rawTextExcerpt');
    expect(frontendFields).not.toContain('hasBreakdown');
  });

  it('RuleBreakdown/RuleBreakdownDetail: só os 6 campos de conteúdo — sem id/rawContentId/createdAt/updatedAt fantasma no frontend', () => {
    const backendFields = extractInterfaceFields(backendSource, 'RuleBreakdownDetail').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'RuleBreakdown').sort();

    expect(backendFields).toEqual(
      ['concept', 'action', 'object', 'condition', 'exception', 'essence'].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: reintroduzir qualquer um dos 4 campos fantasma no frontend
    // (sem o backend também passar a projetá-los) faz esta comparação reprovar.
    for (const phantom of ['id', 'rawContentId', 'createdAt', 'updatedAt']) {
      expect(frontendFields).not.toContain(phantom);
    }
  });

  it('RawContentDetail/RawContent: mesmo conjunto de campos — deletedAt ausente dos dois lados (nunca projetado pelo select)', () => {
    const backendFields = extractInterfaceFields(backendSource, 'RawContentDetail').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'RawContent').sort();

    expect(backendFields).toEqual(frontendFields);
    // Mutante: reintroduzir `deletedAt` só no frontend (sem o backend passar
    // a projetá-lo no `select`) faz esta comparação reprovar.
    expect(frontendFields).not.toContain('deletedAt');
  });
});
