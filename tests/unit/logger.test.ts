import { pino } from 'pino';

import { redactOptions } from '../../src/lib/logger';

/**
 * O `logger` compartilhado roda em `level: 'silent'` durante os testes, então aqui
 * montamos uma instância pino com a MESMA configuração de redação (`redactOptions`
 * importada de produção) apontando para um coletor em memória.
 */
function captureLogger() {
  const lines: string[] = [];
  const sink = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  const log = pino({ level: 'info', redact: redactOptions }, sink);

  return { log, lines };
}

describe('logger — redação de segredos', () => {
  it('redige SEED_ADMIN_PASSWORD em qualquer registro estruturado', () => {
    const { log, lines } = captureLogger();
    const secret = 'senha-de-bootstrap-super-secreta';

    log.info({ SEED_ADMIN_PASSWORD: secret }, 'boot do seed');

    const line = lines[0];
    if (line === undefined) throw new Error('esperava um registro de log');
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.SEED_ADMIN_PASSWORD).toBe('[redigido]');
    expect(line).not.toContain(secret);
  });

  it('redige segredos de configuração aninhados um nível sob uma chave de contexto', () => {
    const { log, lines } = captureLogger();
    const jwtSecret = 'jwt-secret-ficticio-com-mais-de-32-caracteres';
    const databaseUrl = 'postgresql://user:senha@host:5432/db';
    const seedPassword = 'senha-de-seed-ficticia';

    log.info(
      {
        env: {
          JWT_SECRET: jwtSecret,
          DATABASE_URL: databaseUrl,
          SEED_ADMIN_PASSWORD: seedPassword,
        },
      },
      'dump de env',
    );

    const line = lines[0];
    if (line === undefined) throw new Error('esperava um registro de log');
    const record = JSON.parse(line) as { env: Record<string, unknown> };
    expect(record.env.JWT_SECRET).toBe('[redigido]');
    expect(record.env.DATABASE_URL).toBe('[redigido]');
    expect(record.env.SEED_ADMIN_PASSWORD).toBe('[redigido]');
    expect(line).not.toContain(jwtSecret);
    expect(line).not.toContain(databaseUrl);
    expect(line).not.toContain(seedPassword);
  });

  it('redige os hashes de sessão aninhados um nível sob uma chave de contexto', () => {
    const { log, lines } = captureLogger();
    const accessTokenHash = 'hash-ficticio-do-access-token';
    const refreshTokenHash = 'hash-ficticio-do-refresh-token';

    log.info({ session: { accessTokenHash, refreshTokenHash } }, 'rotação de sessão');

    const line = lines[0];
    if (line === undefined) throw new Error('esperava um registro de log');
    const record = JSON.parse(line) as { session: Record<string, unknown> };
    expect(record.session.accessTokenHash).toBe('[redigido]');
    expect(record.session.refreshTokenHash).toBe('[redigido]');
    expect(line).not.toContain(accessTokenHash);
    expect(line).not.toContain(refreshTokenHash);
  });
});
