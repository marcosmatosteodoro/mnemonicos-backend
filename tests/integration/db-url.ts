/**
 * URL do Postgres usado pelos testes de integração. Aponta para um banco
 * descartável (`mnemonicos_test`) no mesmo servidor do `docker-compose.yml`.
 *
 * Lida do ambiente (`TEST_DATABASE_URL`) para o CI poder trocar host/porta sem
 * editar arquivo; o default cobre a máquina do dev. Este módulo é a fonte única
 * do valor — `setup-env.integration.ts` e o `global-setup` rodam em contextos
 * separados e não compartilham `process.env` definido em `setupFiles`.
 *
 * Guarda fail-closed na **carga do módulo** (perfil §7: infra de teste que faz
 * DDL/`TRUNCATE` valida o alvo no módulo que resolve a conexão e lança na carga,
 * nunca num `expect()` que só roda depois do primeiro `beforeEach`). `global-setup`
 * faz `CREATE DATABASE` e cada `beforeEach` faz `TRUNCATE ... CASCADE` de todas as
 * tabelas do banco-alvo — se `TEST_DATABASE_URL` apontasse para outro banco ou um
 * host remoto, esse DDL rodaria contra ele. A recusa acontece aqui, antes da
 * primeira conexão. A asserção `current_database()` no smoke test fica como 2ª
 * linha de defesa. As mensagens citam a variável e o alvo esperado, nunca a
 * credencial.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5432/mnemonicos_test?schema=public';

const EXPECTED_DB_PATH = '/mnemonicos_test';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Lança se `rawUrl` não for o banco descartável `mnemonicos_test` num host
 * loopback. Exportada para prova direta (`tests/unit/db-url-guard.test.ts`); a
 * chamada de verdade é na carga do módulo, logo abaixo.
 */
export function assertDisposableTestDatabase(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL não é uma URL válida — esperado ' +
        'postgresql://<user>:<senha>@127.0.0.1:5432/mnemonicos_test',
    );
  }

  // IPv6 chega entre colchetes em `URL.hostname` (`[::1]`); normaliza para comparar.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `TEST_DATABASE_URL aponta para o host "${host}", que não é loopback. Os testes ` +
        'de integração criam e truncam tabelas — recusado fora de 127.0.0.1/localhost/::1.',
    );
  }

  if (parsed.pathname !== EXPECTED_DB_PATH) {
    const target = parsed.pathname.replace(/^\//, '') || '(vazio)';
    throw new Error(
      `TEST_DATABASE_URL aponta para o banco "${target}", esperado "mnemonicos_test". Os ` +
        'testes de integração truncam todas as tabelas do banco-alvo.',
    );
  }
}

assertDisposableTestDatabase(TEST_DATABASE_URL);
