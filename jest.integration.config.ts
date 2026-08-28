import type { Config } from 'jest';

/**
 * Runner da camada de integração — roda contra o Postgres real do
 * `docker-compose.yml`, no banco descartável `mnemonicos_test`.
 *
 * Espelha `jest.config.ts` no que o resolver precisa (`preset`, `transform`,
 * `moduleNameMapper` — este último idêntico, é o workaround para os imports `.js`
 * do client gerado pelo Prisma). O que muda:
 *
 *  - roda **só** os `*.integration.test.ts` (o runner unitário os ignora via
 *    `testPathIgnorePatterns`);
 *  - `setupFiles` carrega o env com URL de banco real (`setup-env.integration.ts`);
 *  - `globalSetup`/`globalTeardown` criam, migram e desconectam o `mnemonicos_test`;
 *  - `maxWorkers: 1` — o banco de teste é compartilhado, os arquivos rodam em série.
 *
 * Não faz `import` de `jest.config.ts`: sob `module: nodenext` o resolver do Jest
 * não acha o arquivo irmão sem extensão, e duplicar estas quatro chaves estáveis
 * custa menos que o hack de extensão.
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setup-env.integration.ts'],
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: '<rootDir>/tests/integration/global-setup.ts',
  globalTeardown: '<rootDir>/tests/integration/global-teardown.ts',
  maxWorkers: 1,
  clearMocks: true,
  // O client gerado pelo Prisma importa irmãos com extensão .js (convenção ESM),
  // mas os arquivos em disco são .ts — o resolver do Jest precisa da tradução.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: true }],
  },
};

export default config;
