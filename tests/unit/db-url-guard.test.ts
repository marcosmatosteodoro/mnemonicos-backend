import { assertDisposableTestDatabase } from '../integration/db-url';

/**
 * Guarda fail-closed de `tests/integration/db-url.ts` (perfil §7: infra de teste
 * que faz DDL/`TRUNCATE` valida o alvo no módulo que resolve a conexão e lança
 * na carga, não num `expect()` de caso). `global-setup` faz `CREATE DATABASE` e
 * cada `beforeEach` faz `TRUNCATE ... CASCADE` do banco-alvo — a recusa precisa
 * acontecer antes da primeira conexão. Aqui a função é exercida direto; a chamada
 * de verdade roda na carga do módulo com `TEST_DATABASE_URL`.
 */
describe('assertDisposableTestDatabase', () => {
  it('aceita mnemonicos_test em 127.0.0.1', () => {
    expect(() =>
      assertDisposableTestDatabase(
        'postgresql://postgres:postgres@127.0.0.1:5432/mnemonicos_test?schema=public',
      ),
    ).not.toThrow();
  });

  it('aceita localhost como loopback', () => {
    expect(() =>
      assertDisposableTestDatabase('postgresql://postgres:postgres@localhost:5432/mnemonicos_test'),
    ).not.toThrow();
  });

  it('aceita ::1 como loopback', () => {
    expect(() =>
      assertDisposableTestDatabase('postgresql://postgres:postgres@[::1]:5432/mnemonicos_test'),
    ).not.toThrow();
  });

  it('lança quando o banco-alvo não é mnemonicos_test', () => {
    expect(() =>
      assertDisposableTestDatabase(
        'postgresql://postgres:postgres@127.0.0.1:5432/mnemonicos?schema=public',
      ),
    ).toThrow(/esperado "mnemonicos_test"/);
  });

  it('lança quando o host não é loopback', () => {
    expect(() =>
      assertDisposableTestDatabase(
        'postgresql://postgres:postgres@db.prod.internal:5432/mnemonicos_test',
      ),
    ).toThrow(/não é loopback/);
  });

  it('lança quando a string não é uma URL válida', () => {
    expect(() => assertDisposableTestDatabase('nao-e-uma-url')).toThrow(/URL válida/);
  });

  it('não ecoa a credencial na mensagem de recusa', () => {
    let message = '';
    try {
      assertDisposableTestDatabase('postgresql://admin:s3nh4-secreta@10.0.0.5:5432/producao');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/não é loopback/);
    expect(message).not.toContain('s3nh4-secreta');
  });
});
