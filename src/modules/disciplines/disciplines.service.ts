import type { Paginated } from '../../domain/types';
import { prisma } from '../../lib/prisma';
import type { ListDisciplinesQuery } from './disciplines.schema';

export interface DisciplineSummary {
  id: string;
  name: string;
  slug: string;
  topicsCount: number;
  topics: { id: string; name: string; slug: string }[];
}

/**
 * Cliente Prisma que `listDisciplines` usa. O default é o singleton de
 * produção; um teste pode injetar um client com `log: [{ level: 'query' }]`
 * para fixar a contagem de idas ao banco (mesmo padrão de
 * `resolveAccessSession` em `auth.service.ts`).
 */
type DisciplineReader = Pick<typeof prisma, 'discipline'>;

export async function listDisciplines(
  query: ListDisciplinesQuery,
  db: DisciplineReader = prisma,
): Promise<Paginated<DisciplineSummary>> {
  const { page, perPage, search } = query;

  // `mode: 'insensitive'` já vai parametrizado pelo Prisma — nada de SQL montado à mão.
  const where = search ? { name: { contains: search, mode: 'insensitive' as const } } : {};

  const [rows, total] = await Promise.all([
    db.discipline.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * perPage,
      take: perPage,
      // `topics` é relação de lista (1-N de volume variável): medido contra o
      // Postgres real (TASK-006-002, ressalva da lição [Performance]), a
      // estratégia `join` fixa em 1 round-trip por chamada (LATERAL JOIN +
      // JSONB_AGG), contra 2 fixos de `query` (disciplines + topics via IN) —
      // nenhuma das duas escala com N. `join` venceu por ter menos round-trips.
      relationLoadStrategy: 'join',
      select: {
        id: true,
        name: true,
        slug: true,
        _count: { select: { topics: true } },
        topics: { select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } },
      },
    }),
    db.discipline.count({ where }),
  ]);

  return {
    data: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      topicsCount: row._count.topics,
      topics: row.topics,
    })),
    page,
    perPage,
    total,
  };
}
