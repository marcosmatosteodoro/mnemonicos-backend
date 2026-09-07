import { reassignPositions } from '../../src/modules/tira/tira.service';

/**
 * Prova UNITÁRIA (stub, sem banco real) do guard fail-secure de
 * `applyPositions` (achado médio do `security-engineer`, retry da
 * TASK-012-006): se `mnemonicFrame.updateMany` devolver `count !== 1` — o
 * `frameId` deixou de casar o WHERE (`id` + `stripId`) entre a leitura do
 * conjunto e a escrita, ex.: corrida concorrente removendo o Quadro no meio
 * do caminho —, `applyPositions` deve LANÇAR em vez de seguir em frente
 * silenciosamente (o Prisma não lança sozinho num `updateMany` que não casa
 * nenhuma linha, só devolve `count: 0`).
 *
 * `reassignPositions` é o único ponto exportado que invoca `applyPositions`
 * (função interna, não exportada) — o stub força `count: 0` na 1ª chamada da
 * Fase 1 (offset), então a asserção prova o guard sem precisar exercitar as 2
 * fases completas.
 *
 * Mutante-alvo: remover o bloco `if (result.count !== 1) throw ...` de
 * `applyPositions` (`tira.service.ts`) faz este teste falhar (a promise
 * resolveria em vez de rejeitar) — prova que o mutante morre.
 */
describe('applyPositions (via reassignPositions) — guard fail-secure de count !== 1', () => {
  it('lança quando updateMany devolve count: 0 (frameId não casou stripId)', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    // Stub estrutural do client injetável de `reassignPositions` (tipo
    // interno não exportado, `MnemonicFrameWriteClient` — extraído via
    // `Parameters<typeof reassignPositions>[0]` para não depender de um
    // export só para teste): só `mnemonicFrame.updateMany` importa aqui.
    const stubClient = { mnemonicFrame: { updateMany } } as unknown as Parameters<
      typeof reassignPositions
    >[0];

    await expect(reassignPositions(stubClient, 'strip-1', ['frame-a', 'frame-b'])).rejects.toThrow(
      /reindexação falhou/,
    );

    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
