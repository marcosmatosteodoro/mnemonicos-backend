import { assertRawContentReachable } from '../../src/modules/contents/contents.service';

/**
 * Prova de visibilidade (TASK-012-002 / COMP-012-005 / DEC-012-007):
 * `assertRawContentReachable` era função privada de `contents.service.ts` —
 * este teste importa o símbolo de fora do módulo e confirma que ele resolve
 * em runtime. Reverter o `export` faz o import falhar em tempo de compilação
 * (TS2305, "has no exported member") e este teste nem chega a rodar — a
 * lógica interna do guard (ordem de guardas, mensagens) não muda aqui e
 * continua coberta por `contents.service.integration.test.ts`.
 */
describe('contents.service.ts — exports (TASK-012-002)', () => {
  it('exporta assertRawContentReachable como função importável de outro módulo', () => {
    expect(typeof assertRawContentReachable).toBe('function');
  });
});
