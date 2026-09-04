import type { Paginated } from '../../src/domain/types';

/**
 * `Paginated<T>` consolidado em `domain/types.ts` (TASK-006-002) — antes vivia
 * local a `disciplines.service.ts`, e o módulo `contents` traria a 3ª cópia do
 * mesmo envelope. Este teste prova o **símbolo importado** com um valor
 * concreto não-nulo; a forma de `GET /disciplines` continua coberta em
 * `tests/integration/disciplines.integration.test.ts`.
 */
describe('Paginated<T> — domain/types.ts', () => {
  it('tipa e carrega um envelope de página não-vazio', () => {
    const page: Paginated<{ id: string }> = {
      data: [{ id: 'x' }, { id: 'y' }],
      page: 1,
      perPage: 20,
      total: 2,
    };

    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(2);
    expect(page.data.map((item) => item.id)).toEqual(['x', 'y']);
  });
});
