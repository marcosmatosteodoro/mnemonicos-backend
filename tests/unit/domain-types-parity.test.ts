import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  USER_ROLES,
  PROOF_RADAR_CLASSES,
  NORMATIVE_SOURCE_TYPES,
  PRODUCTION_STAGE_TYPES,
  PRODUCTION_EVENT_TRANSITIONS,
  type SessionUser,
} from '../../src/domain/types';

/**
 * Os tipos de domínio são mantidos em sincronia à mão entre os dois repositórios
 * (regra do CLAUDE.md do workspace). Este teste é a única rede: lê os dois
 * arquivos como texto e prova que o conjunto de papéis, a forma de
 * `SessionUser` e os enums de Conteúdo bruto (F2) são idênticos dos dois
 * lados (NFR-002-007 / AC-002-025; PROOF_RADAR_CLASSES / NORMATIVE_SOURCE_TYPES
 * — AC-005-030). Um valor a mais ou a menos de qualquer um deles deixa o teste
 * vermelho.
 *
 * Repos symlinkados no workspace: o arquivo do frontend é lido pelo caminho
 * relativo a partir daqui.
 */
const BACKEND_TYPES = resolve(__dirname, '../../src/domain/types.ts');
const FRONTEND_TYPES = resolve(__dirname, '../../../mnemonicos-frontend/src/types/domain.ts');
const SCHEMA_PRISMA = resolve(__dirname, '../../prisma/schema.prisma');

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

/**
 * Extrai o conjunto de valores de um `export const <NOME> = [...] as const;`
 * pela leitura textual do arquivo (sem AST) — mesmo mecanismo usado para
 * `USER_ROLES`, generalizado para os enums de F2 (`PROOF_RADAR_CLASSES` /
 * `NORMATIVE_SOURCE_TYPES`). Formato hard-coded: array de literais string em
 * uma ou mais linhas seguido de `as const;` — se um enum novo adotar outro
 * formato, este extrator precisa ser revisitado (risco declarado na TASK).
 */
function extractConstArray(source: string, constName: string): string[] {
  const pattern = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`);
  const match = pattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`declaração de ${constName} não encontrada`);
  }
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

/**
 * Extrai os valores de um `enum <Nome> { ... }` do schema.prisma, ignorando
 * comentários `//`. Fecha o par schema Prisma ⇆ `domain/types.ts` (eixo
 * intra-repo distinto do cross-repo acima): sem isso, um valor novo no enum
 * Prisma (F4-F9, NFR-009-001) não deixaria nada vermelho aqui.
 */
function extractPrismaEnum(source: string, enumName: string): string[] {
  const pattern = new RegExp(`enum ${enumName} \\{([\\s\\S]*?)\\}`);
  const match = pattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`enum ${enumName} não encontrado em schema.prisma`);
  }
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'));
}

function extractSessionUserFields(source: string): string[] {
  const match = /export interface SessionUser \{([\s\S]*?)\}/.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error('declaração de interface SessionUser não encontrada');
  }
  return [...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1] ?? '');
}

describe('paridade de tipos de domínio backend ⇆ frontend (NFR-002-007 / AC-002-025 / AC-005-030)', () => {
  const backendSource = readTypesFile(BACKEND_TYPES);
  const frontendSource = readTypesFile(FRONTEND_TYPES);
  const schemaSource = readTypesFile(SCHEMA_PRISMA);

  it('expõe o mesmo conjunto de valores de USER_ROLES nos dois repositórios', () => {
    const backendRoles = extractConstArray(backendSource, 'USER_ROLES').sort();
    const frontendRoles = extractConstArray(frontendSource, 'USER_ROLES').sort();

    expect(backendRoles).toEqual(['ADMIN', 'EDITOR', 'STUDENT']);
    expect(frontendRoles).toEqual(['ADMIN', 'EDITOR', 'STUDENT']);
    expect(frontendRoles).toEqual(backendRoles);
    // o símbolo importado confere com a fonte que o teste leu como texto
    expect([...USER_ROLES].sort()).toEqual(backendRoles);
  });

  it('expõe o mesmo conjunto de valores de PROOF_RADAR_CLASSES nos dois repositórios (AC-005-030)', () => {
    const backendClasses = extractConstArray(backendSource, 'PROOF_RADAR_CLASSES').sort();
    const frontendClasses = extractConstArray(frontendSource, 'PROOF_RADAR_CLASSES').sort();

    expect(backendClasses).toEqual(['ALTA', 'DETALHE', 'EXCECAO', 'MEDIA', 'PEGADINHA']);
    expect(frontendClasses).toEqual(['ALTA', 'DETALHE', 'EXCECAO', 'MEDIA', 'PEGADINHA']);
    // paridade nos dois sentidos — mesmo tamanho e mesmos elementos: nenhuma
    // ponta com entrada a mais
    expect(frontendClasses).toEqual(backendClasses);
    // o símbolo importado confere com a fonte que o teste leu como texto
    expect([...PROOF_RADAR_CLASSES].sort()).toEqual(backendClasses);
  });

  it('expõe o mesmo conjunto de valores de NORMATIVE_SOURCE_TYPES nos dois repositórios (AC-005-030)', () => {
    const backendTypes = extractConstArray(backendSource, 'NORMATIVE_SOURCE_TYPES').sort();
    const frontendTypes = extractConstArray(frontendSource, 'NORMATIVE_SOURCE_TYPES').sort();

    expect(backendTypes).toEqual([
      'ATO_NORMATIVO',
      'CF',
      'CTN',
      'LEI',
      'LEI_COMPLEMENTAR',
      'SUMULA',
    ]);
    expect(frontendTypes).toEqual([
      'ATO_NORMATIVO',
      'CF',
      'CTN',
      'LEI',
      'LEI_COMPLEMENTAR',
      'SUMULA',
    ]);
    // paridade nos dois sentidos — mesmo tamanho e mesmos elementos: nenhuma
    // ponta com entrada a mais
    expect(frontendTypes).toEqual(backendTypes);
    // o símbolo importado confere com a fonte que o teste leu como texto
    expect([...NORMATIVE_SOURCE_TYPES].sort()).toEqual(backendTypes);
  });

  it('expõe PRODUCTION_STAGE_TYPES em paridade com o enum ProductionStageType do schema.prisma — sem 2º lado no frontend ainda (DEC-010-006, F10 acrescenta)', () => {
    const declaredStageTypes = extractConstArray(backendSource, 'PRODUCTION_STAGE_TYPES').sort();
    const schemaStageTypes = extractPrismaEnum(schemaSource, 'ProductionStageType').sort();

    expect(declaredStageTypes).toEqual(['CONTEUDO_BRUTO', 'QUEBRA_DA_REGRA']);
    // paridade real contra o schema Prisma — um valor novo em F4-F9 sem o
    // espelho em domain/types.ts deixa esta linha vermelha
    expect(declaredStageTypes).toEqual(schemaStageTypes);
    // o símbolo importado confere com a fonte que o teste leu como texto
    expect([...PRODUCTION_STAGE_TYPES].sort()).toEqual(declaredStageTypes);
  });

  it('expõe PRODUCTION_EVENT_TRANSITIONS em paridade com o enum ProductionEventTransition do schema.prisma — sem 2º lado no frontend ainda (DEC-010-006, F10 acrescenta)', () => {
    const declaredTransitions = extractConstArray(
      backendSource,
      'PRODUCTION_EVENT_TRANSITIONS',
    ).sort();
    const schemaTransitions = extractPrismaEnum(schemaSource, 'ProductionEventTransition').sort();

    expect(declaredTransitions).toEqual(['ABERTURA', 'CONCLUSAO', 'RETRABALHO']);
    // paridade real contra o schema Prisma — mesma razão do bloco acima
    expect(declaredTransitions).toEqual(schemaTransitions);
    // o símbolo importado confere com a fonte que o teste leu como texto
    expect([...PRODUCTION_EVENT_TRANSITIONS].sort()).toEqual(declaredTransitions);
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
