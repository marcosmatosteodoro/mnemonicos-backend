import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { USER_ROLES, type SessionUser } from '../../src/domain/types';

/**
 * Os tipos de domínio são mantidos em sincronia à mão entre os dois repositórios
 * (regra do CLAUDE.md do workspace). Este teste é a única rede: lê os dois
 * arquivos como texto e prova que o conjunto de papéis e a forma de
 * `SessionUser` são idênticos dos dois lados (NFR-002-007 / AC-002-025). Um
 * valor de papel ou um campo a mais de um lado deixa o teste vermelho.
 *
 * Repos symlinkados no workspace: o arquivo do frontend é lido pelo caminho
 * relativo a partir daqui.
 */
const BACKEND_TYPES = resolve(__dirname, '../../src/domain/types.ts');
const FRONTEND_TYPES = resolve(__dirname, '../../../mnemonicos-frontend/src/types/domain.ts');

function readTypesFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `arquivo de tipos não encontrado: ${path}\n` +
        'checkout irmão mnemonicos-frontend ausente — este teste de paridade ' +
        'exige os dois repos no workspace.',
    );
  }
  return readFileSync(path, 'utf8');
}

function extractUserRoles(source: string): string[] {
  const match = /export const USER_ROLES = \[([\s\S]*?)\] as const;/.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error('declaração de USER_ROLES não encontrada');
  }
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

function extractSessionUserFields(source: string): string[] {
  const match = /export interface SessionUser \{([\s\S]*?)\}/.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error('declaração de interface SessionUser não encontrada');
  }
  return [...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1] ?? '');
}

describe('paridade de tipos de domínio backend ⇆ frontend (NFR-002-007 / AC-002-025)', () => {
  const backendSource = readTypesFile(BACKEND_TYPES);
  const frontendSource = readTypesFile(FRONTEND_TYPES);

  it('expõe o mesmo conjunto de valores de USER_ROLES nos dois repositórios', () => {
    const backendRoles = extractUserRoles(backendSource).sort();
    const frontendRoles = extractUserRoles(frontendSource).sort();

    expect(backendRoles).toEqual(['ADMIN', 'EDITOR', 'STUDENT']);
    expect(frontendRoles).toEqual(['ADMIN', 'EDITOR', 'STUDENT']);
    expect(frontendRoles).toEqual(backendRoles);
    // o símbolo importado confere com a fonte que o teste leu como texto
    expect([...USER_ROLES].sort()).toEqual(backendRoles);
  });

  it('declara a interface SessionUser com o mesmo conjunto de campos nos dois repositórios', () => {
    const backendFields = extractSessionUserFields(backendSource).sort();
    const frontendFields = extractSessionUserFields(frontendSource).sort();

    expect(backendFields).toEqual(['email', 'id', 'name', 'role']);
    expect(frontendFields).toEqual(['email', 'id', 'name', 'role']);
    expect(frontendFields).toEqual(backendFields);
  });

  it('constrói um SessionUser não-nulo com os quatro campos do contrato', () => {
    const user: SessionUser = {
      id: '0192f8a0-0000-7000-8000-000000000000',
      name: 'Editora de Conteúdo',
      email: 'editor@example.com',
      role: 'EDITOR',
    };

    expect(Object.keys(user).sort()).toEqual(['email', 'id', 'name', 'role']);
    expect(USER_ROLES).toContain(user.role);
  });
});
