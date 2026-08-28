/**
 * URL do Postgres usado pelos testes de integração. Aponta para um banco
 * descartável (`mnemonicos_test`) no mesmo servidor do `docker-compose.yml`.
 *
 * Lida do ambiente (`TEST_DATABASE_URL`) para o CI poder trocar host/porta sem
 * editar arquivo; o default cobre a máquina do dev. Este módulo é a fonte única
 * do valor — `setup-env.integration.ts` e o `global-setup` rodam em contextos
 * separados e não compartilham `process.env` definido em `setupFiles`.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5432/mnemonicos_test?schema=public';
