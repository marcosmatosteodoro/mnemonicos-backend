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

  it('mantém as chaves de segredo conhecidas na lista de paths redigidos', () => {
    expect(redactOptions.paths).toEqual(
      expect.arrayContaining(['JWT_SECRET', 'DATABASE_URL', 'SEED_ADMIN_PASSWORD', '*.password']),
    );
  });
});
