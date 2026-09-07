import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Rede de paridade cross-repo das interfaces da Tira mnemônica / Quadro
 * (COMP-012-008). Análoga a `domain-types-parity.test.ts` e ao molde direto
 * `contents-frontend-contract.test.ts`, mas para as interfaces de
 * `tira.service.ts` (backend) × `src/types/domain.ts` (frontend): lê os dois
 * arquivos como texto e prova que os NOMES e a FORMA dos campos são
 * idênticos dos dois lados — não um fixture que se autoconfirma a partir de
 * um dos lados (um fixture montado a partir do próprio tipo do frontend não
 * acusaria uma interface renomeada ou um campo fantasma no outro lado).
 *
 * Nomes canônicos (backend vence — a fonte real do dado):
 *   - `MnemonicFrameDetail`/`MnemonicFrame`: `id`/`text`/`position`/`originBlock`.
 *   - `MnemonicStripDetail`/`MnemonicStrip`: `id`/`frames`.
 *
 * Limite conhecido (RISK-006-006, INDEX.md): este teste compara
 * DECLARAÇÃO×DECLARAÇÃO, não `select` do Prisma × interface — uma chave nova
 * no `select` sem a mesma chave na interface do frontend não é acusada aqui.
 *
 * Repos symlinkados no workspace (mesmo padrão de `domain-types-parity.test.ts`):
 * o arquivo do frontend é lido pelo caminho relativo a partir daqui.
 */
const BACKEND_SERVICE = resolve(__dirname, '../../src/modules/tira/tira.service.ts');
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

describe('paridade cross-repo — MnemonicFrame/MnemonicStrip', () => {
  const backendSource = readSourceFile(BACKEND_SERVICE);
  const frontendSource = readSourceFile(FRONTEND_TYPES);

  it('MnemonicFrameDetail/MnemonicFrame: mesmo conjunto de campos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'MnemonicFrameDetail').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'MnemonicFrame').sort();

    expect(backendFields).toEqual(['id', 'text', 'position', 'originBlock'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `originBlock` só do frontend (ex.: `sourceBlock`) faz
    // esta comparação reprovar.
    expect(frontendFields).not.toContain('sourceBlock');
  });

  it('MnemonicStripDetail/MnemonicStrip: mesmo conjunto de campos nos dois repositórios', () => {
    const backendFields = extractInterfaceFields(backendSource, 'MnemonicStripDetail').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'MnemonicStrip').sort();

    expect(backendFields).toEqual(['id', 'frames'].sort());
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `frames` só do backend (ex.: `mnemonicFrames`) faz
    // esta comparação reprovar.
    expect(backendFields).not.toContain('mnemonicFrames');
  });
});
