import { resolveAlterationSignal } from '../../src/modules/content-versions/content-versions.service';
import type { VersionedContentFields } from '../../src/modules/content-versions/versioned-content-diff';

/**
 * Prova UNITÁRIA (TASK-031-002, COMP-031-003/DEC-031-007) do sinal combinado
 * de alteração pós-fechamento: dublê de `db`
 * (`{ productionStageEvent: { findFirst: jest.fn() } }`) — o MESMO objeto que
 * `resolveAlterationSignal` recebe como `db`, então a asserção de ausência de
 * chamada (caso a) é válida por construção (lição ativa "[Testes] Espião de
 * ausência num client Prisma que não é o mesmo objeto recebido pelo código
 * sob teste nunca falsifica").
 *
 * Mutantes-alvo:
 *  - remover o `if (hasVersionedContentChanged(...)) return true;` faz o
 *    caso (a) falhar (retornaria `false` ou chamaria `findFirst`);
 *  - trocar `orderBy: { sequence: 'desc' }` por `occurredAt` faz o caso (e)
 *    falhar (AC-009-008: desempate determinístico);
 *  - trocar `>` por `>=`/`<` na comparação final faz os casos (c)/(d) falhar.
 */
const BASE_FIELDS: VersionedContentFields = {
  rawText: 'texto',
  radarClass: 'ALTA',
  sourceType: null,
  sourceCitation: null,
  sourceUrl: null,
  concept: 'conceito',
  action: 'ação',
  object: 'objeto',
  condition: null,
  exception: null,
  essence: 'essência',
};

/**
 * Dublê estrutural do `db` injetável (mesmo padrão de
 * `tira.service.apply-positions.test.ts`): só `productionStageEvent.findFirst`
 * importa — o cast estrutural evita depender do tipo interno `Pick<typeof
 * prisma, 'productionStageEvent'>` só para o teste.
 */
function buildDb(findFirstResult: { occurredAt: Date } | null) {
  const findFirst = jest.fn().mockResolvedValue(findFirstResult);
  const db = { productionStageEvent: { findFirst } } as unknown as Parameters<
    typeof resolveAlterationSignal
  >[3];
  return { db, findFirst };
}

describe('resolveAlterationSignal (TASK-031-002)', () => {
  it('(a) current divergente do contentSnapshot → true, sem consultar productionStageEvent (short-circuit)', async () => {
    const { db, findFirst } = buildDb(null);
    const current: VersionedContentFields = { ...BASE_FIELDS, rawText: 'texto mudou' };
    const version = { contentSnapshot: BASE_FIELDS, closedAt: new Date('2026-01-01T00:00:00Z') };

    const result = await resolveAlterationSignal('raw-1', current, version, db);

    expect(result).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('(b) current igual ao snapshot, findFirst resolve null (nenhum evento de Tira) → false', async () => {
    const { db } = buildDb(null);
    const version = { contentSnapshot: BASE_FIELDS, closedAt: new Date('2026-01-01T00:00:00Z') };

    const result = await resolveAlterationSignal('raw-1', BASE_FIELDS, version, db);

    expect(result).toBe(false);
  });

  it('(c) current igual ao snapshot, findFirst resolve evento DEPOIS de closedAt → true', async () => {
    const closedAt = new Date('2026-01-01T00:00:00Z');
    const { db } = buildDb({ occurredAt: new Date('2026-01-02T00:00:00Z') });
    const version = { contentSnapshot: BASE_FIELDS, closedAt };

    const result = await resolveAlterationSignal('raw-1', BASE_FIELDS, version, db);

    expect(result).toBe(true);
  });

  it('(d) current igual ao snapshot, findFirst resolve evento ANTES ou IGUAL a closedAt → false', async () => {
    const closedAt = new Date('2026-01-01T00:00:00Z');

    const before = buildDb({ occurredAt: new Date('2025-12-31T00:00:00Z') });
    const equal = buildDb({ occurredAt: closedAt });
    const version = { contentSnapshot: BASE_FIELDS, closedAt };

    await expect(resolveAlterationSignal('raw-1', BASE_FIELDS, version, before.db)).resolves.toBe(
      false,
    );
    await expect(resolveAlterationSignal('raw-1', BASE_FIELDS, version, equal.db)).resolves.toBe(
      false,
    );
  });

  it('(e) a chamada de findFirst usa where rawContentId + stageType TIRA_MNEMONICA e orderBy sequence desc', async () => {
    const { db, findFirst } = buildDb(null);
    const version = { contentSnapshot: BASE_FIELDS, closedAt: new Date('2026-01-01T00:00:00Z') };

    await resolveAlterationSignal('raw-42', BASE_FIELDS, version, db);

    expect(findFirst).toHaveBeenCalledWith({
      where: { rawContentId: 'raw-42', stageType: 'TIRA_MNEMONICA' },
      orderBy: { sequence: 'desc' },
      select: { occurredAt: true },
    });
  });
});
