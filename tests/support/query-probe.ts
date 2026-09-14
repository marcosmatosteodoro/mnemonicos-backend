import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client';
import { TEST_DATABASE_URL } from '../integration/db-url';

/**
 * Sonda de round-trips (lição [Performance] ativa, "`include`/`select` aninhado de
 * relação não é 1 statement por padrão") — abre um `PrismaClient` PRÓPRIO com log de
 * evento `query` habilitado, roda `run` contra ele e devolve o SQL de cada statement
 * emitido. Usada para fixar em teste a contagem de round-trips ao Postgres real, não
 * presumida.
 */
export async function withQueryProbe(
  run: (probe: PrismaClient) => Promise<unknown>,
): Promise<string[]> {
  const probe = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 1 }),
    log: [{ emit: 'event', level: 'query' }],
  });
  const queries: string[] = [];
  probe.$on('query', (event) => queries.push(event.query));

  try {
    await run(probe);
  } finally {
    await probe.$disconnect();
  }

  return queries;
}
