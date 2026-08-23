import { prisma } from '../../lib/prisma';
import type { ListDisciplinesQuery } from './disciplines.schema';

export interface Paginated<T> {
  data: T[];
  page: number;
  perPage: number;
  total: number;
}

export interface DisciplineSummary {
  id: string;
  name: string;
  slug: string;
  topicsCount: number;
}

export async function listDisciplines(
  query: ListDisciplinesQuery,
): Promise<Paginated<DisciplineSummary>> {
  const { page, perPage, search } = query;

  // `mode: 'insensitive'` já vai parametrizado pelo Prisma — nada de SQL montado à mão.
  const where = search ? { name: { contains: search, mode: 'insensitive' as const } } : {};

  const [rows, total] = await Promise.all([
    prisma.discipline.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        name: true,
        slug: true,
        _count: { select: { topics: true } },
      },
    }),
    prisma.discipline.count({ where }),
  ]);

  return {
    data: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      topicsCount: row._count.topics,
    })),
    page,
    perPage,
    total,
  };
}
