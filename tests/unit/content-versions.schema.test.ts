import { closeContentVersionSchema } from '../../src/modules/content-versions/content-versions.schema';

/**
 * `closeContentVersionSchema` (COMP-029-002 / TASK-029-002, DEC-029-006):
 * recusa data FUTURA (comparação de DATA, não de timestamp) e NÃO valida
 * monotonicidade entre Versões — 1º schema Zod do projeto dependente de
 * tempo, sem parâmetro de `now` injetável (o "hoje" é lido de
 * `new Date().toISOString().slice(0, 10)` no momento do `parse`), testável
 * por `jest.useFakeTimers().setSystemTime(...)`.
 */
describe('closeContentVersionSchema — recusa futura, sem monotonicidade (DEC-029-006)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-26T23:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('(a) data de AMANHÃ (2026-09-27) → ZodError', () => {
    const result = closeContentVersionSchema.safeParse({ legislativeClosureDate: '2026-09-27' });
    expect(result.success).toBe(false);
  });

  it('(b) data de HOJE (2026-09-26, MESMO dia — comparação de DATA, não de timestamp) → aceito', () => {
    const result = closeContentVersionSchema.safeParse({ legislativeClosureDate: '2026-09-26' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.legislativeClosureDate).toBe('2026-09-26');
    }
  });

  it('(c) data ANTERIOR à de uma Versão já fechada mais recente (ex. 2026-09-15) → aceito, SEM checagem de monotonicidade', () => {
    // Falsificável: se o schema validasse monotonicidade contra uma leitura
    // de Versão anterior, este caso teria de recusar — ele não lê nenhuma
    // Versão anterior (nenhum parâmetro além do body é aceito pelo schema).
    const result = closeContentVersionSchema.safeParse({ legislativeClosureDate: '2026-09-01' });
    expect(result.success).toBe(true);
  });
});
