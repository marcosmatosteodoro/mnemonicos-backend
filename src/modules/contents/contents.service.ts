import type { Paginated, ProofRadarClass, UserRole } from '../../domain/types';
import type { Prisma } from '../../generated/prisma/client';
import { NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import type {
  CreateRawContentInput,
  ListRawContentsQuery,
  UpdateRawContentInput,
} from './contents.schema';

/**
 * Núcleo do ciclo de vida do Conteúdo bruto (COMP-006-003 / TASK-006-006):
 * criar, reabrir, editar e remover (reversível), mais a listagem paginada
 * (`listRawContents`, TASK-006-008). A Quebra da regra (TASK-006-009) reusa o
 * helper de alcance e o filtro `deletedAt: null` exportados daqui — não os
 * recria.
 *
 * Alcance por papel (lição [Segurança] "enumerar por DADO, não por rota"):
 * EDITOR só alcança o que registrou; ADMIN é irrestrito. Toda leitura/edição/
 * remoção passa pelo **mesmo** par `scopeWhere` + `ACTIVE_RAW_CONTENT_WHERE`, e
 * as três causas de recusa (id inexistente, soft-deleted, fora do alcance)
 * convergem para o **mesmo** `AppError` 404 — nunca 403 — para não dar a quem
 * pede um oráculo que distinga "não existe" de "existe, mas não é seu".
 */

export interface ContentActor {
  id: string;
  role: UserRole;
}

/** Alcance por papel: EDITOR restrito à própria autoria; ADMIN irrestrito. */
export function scopeWhere(actor: ContentActor): Prisma.RawContentWhereInput {
  return actor.role === 'ADMIN' ? {} : { authorId: actor.id };
}

/**
 * Filtro de remoção reversível (DEC-006-001), centralizado: todo caminho de
 * leitura/edição/remoção o inclui. Um caminho que não o use vaza conteúdo
 * removido (TRISK-006-003).
 */
export const ACTIVE_RAW_CONTENT_WHERE = { deletedAt: null } as const;

const RAW_CONTENT_DETAIL_SELECT = {
  id: true,
  topicId: true,
  authorId: true,
  rawText: true,
  radarClass: true,
  sourceType: true,
  sourceCitation: true,
  sourceUrl: true,
  lastEditedById: true,
  lastEditedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RawContentSelect;

export interface RawContentDetail {
  id: string;
  topicId: string;
  authorId: string;
  rawText: string;
  radarClass: CreateRawContentInput['radarClass'];
  sourceType: NonNullable<CreateRawContentInput['sourceType']> | null;
  sourceCitation: string | null;
  sourceUrl: string | null;
  lastEditedById: string | null;
  lastEditedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Cliente Prisma injetável (mesmo padrão de `disciplines.service.ts`/`DisciplineReader`). */
type RawContentClient = Pick<typeof prisma, 'rawContent'>;

/**
 * Cria o Conteúdo bruto com `authorId = actorId` — **nunca** do `input`
 * (`CreateRawContentInput` nem declara o campo; o schema o exclui na fronteira).
 */
export async function createRawContent(
  input: CreateRawContentInput,
  actorId: string,
  db: RawContentClient = prisma,
): Promise<RawContentDetail> {
  return db.rawContent.create({
    data: {
      topicId: input.topicId,
      rawText: input.rawText,
      radarClass: input.radarClass,
      sourceType: input.sourceType,
      sourceCitation: input.sourceCitation,
      sourceUrl: input.sourceUrl,
      authorId: actorId,
    },
    select: RAW_CONTENT_DETAIL_SELECT,
  });
}

/**
 * Devolve o Conteúdo bruto quando ativo e no alcance do ator; 404 caso
 * contrário (id inexistente, soft-deleted, ou fora do alcance — AC-005-008,
 * AC-005-014, AC-005-037). Um único `findFirst` com `select` explícito: 1
 * round-trip, sem `include` de relação não consumida (lição [Performance]).
 */
export async function getRawContent(
  id: string,
  actor: ContentActor,
  db: RawContentClient = prisma,
): Promise<RawContentDetail> {
  const row = await db.rawContent.findFirst({
    where: { id, ...ACTIVE_RAW_CONTENT_WHERE, ...scopeWhere(actor) },
    select: RAW_CONTENT_DETAIL_SELECT,
  });

  if (row === null) throw new NotFoundError('Conteúdo bruto não encontrado.');

  return row;
}

/**
 * Persiste os novos valores mantendo `authorId` intocado (FR-005-013) e carimba
 * quem/quando alterou por último (`lastEditedById`/`lastEditedAt` = o ator
 * atual, mesmo quando é um ADMIN editando item de outro EDITOR — AC-005-036).
 *
 * A guarda (id inexistente, soft-deleted, fora do alcance) e a escrita são o
 * **mesmo** statement (`updateMany` com o predicado de escopo no `where`),
 * nunca um `findFirst` de guarda seguido de `update` por `id` isolado: dois
 * statements deixariam uma janela entre a checagem e a escrita onde uma
 * revogação de alcance concorrente seria ignorada. `count === 0` cobre as
 * três causas de recusa (a distinção "não existe" vs "não é seu" permanece
 * indistinguível — a garantia de A01 continua de pé).
 */
export async function updateRawContent(
  id: string,
  input: UpdateRawContentInput,
  actor: ContentActor,
  db: RawContentClient = prisma,
): Promise<RawContentDetail> {
  const result = await db.rawContent.updateMany({
    where: { id, ...ACTIVE_RAW_CONTENT_WHERE, ...scopeWhere(actor) },
    data: {
      topicId: input.topicId,
      rawText: input.rawText,
      radarClass: input.radarClass,
      sourceType: input.sourceType,
      sourceCitation: input.sourceCitation,
      sourceUrl: input.sourceUrl,
      lastEditedById: actor.id,
      lastEditedAt: new Date(),
    },
  });

  if (result.count === 0) throw new NotFoundError('Conteúdo bruto não encontrado.');

  return db.rawContent.findUniqueOrThrow({ where: { id }, select: RAW_CONTENT_DETAIL_SELECT });
}

/**
 * Remoção reversível (DEC-006-001): marca `deletedAt`, nunca `DELETE` físico —
 * a `RuleBreakdown` vinculada permanece na linha (fica inalcançável através do
 * pai, TASK-006-009). Não toca `authorId`/`lastEditedById`: o soft-delete não é
 * uma edição de autoria (AC-005-036).
 *
 * Guarda e escrita no **mesmo** `updateMany` (mesma razão de `updateRawContent`
 * acima): sob concorrência, dois soft-deletes simultâneos não podem os dois
 * passar pela guarda e um re-carimbar `deletedAt` (a chamada não é
 * reidempotente — `count === 0` na segunda vez, nunca um novo carimbo).
 * `count === 0` cobre (a) id inexistente, (b) já soft-deleted, (c) fora do
 * alcance.
 */
export async function softDeleteRawContent(
  id: string,
  actor: ContentActor,
  db: RawContentClient = prisma,
): Promise<void> {
  const result = await db.rawContent.updateMany({
    where: { id, ...ACTIVE_RAW_CONTENT_WHERE, ...scopeWhere(actor) },
    data: { deletedAt: new Date() },
  });

  if (result.count === 0) throw new NotFoundError('Conteúdo bruto não encontrado.');
}

/**
 * Resumo exibido na listagem (COMP-006-003 / TASK-006-008) — **local ao
 * módulo** (resolução 5 do manifesto): não entra em `domain/types.ts`. `id`
 * entra apesar de não constar do texto do item do manifesto porque a via de
 * acesso à Quebra da regra por item (TASK-006-012/013, FR-005-022) navega por
 * `/content/<id>/breakdown` — sem `id` a listagem não seria navegável.
 */
export interface RawContentSummary {
  id: string;
  rawText: string;
  disciplineName: string;
  topicName: string;
  radarClass: ProofRadarClass;
  sourceCitation: string | null;
  hasRuleBreakdown: boolean;
}

/**
 * `select` explícito do join `RawContent → Topic → Discipline` (lição
 * [Performance]): nenhuma relação crua (`topic`, `author`, `breakdown`)
 * alcança o objeto devolvido — a projeção de existência da Quebra usa
 * `breakdown: { select: { id: true } }`, nunca `include`, para não carregar a
 * `RuleBreakdown` inteira só para saber se ela existe.
 */
const RAW_CONTENT_SUMMARY_SELECT = {
  id: true,
  rawText: true,
  radarClass: true,
  sourceCitation: true,
  topic: { select: { name: true, discipline: { select: { name: true } } } },
  breakdown: { select: { id: true } },
} as const satisfies Prisma.RawContentSelect;

type RawContentSummaryRow = Prisma.RawContentGetPayload<{
  select: typeof RAW_CONTENT_SUMMARY_SELECT;
}>;

function toRawContentSummary(row: RawContentSummaryRow): RawContentSummary {
  return {
    id: row.id,
    rawText: row.rawText,
    disciplineName: row.topic.discipline.name,
    topicName: row.topic.name,
    radarClass: row.radarClass,
    sourceCitation: row.sourceCitation,
    hasRuleBreakdown: row.breakdown !== null,
  };
}

/**
 * Lista os Conteúdos brutos ativos no alcance do ator (FR-005-005, FR-005-024
 * — AC-005-001, AC-005-018, AC-005-035). Reusa o **mesmo** par `scopeWhere` +
 * `ACTIVE_RAW_CONTENT_WHERE` do ciclo de vida (TASK-006-006) tanto no
 * `findMany` quanto no `count` — o predicado de escopo de `total` nunca
 * diverge do de `data` (paginação errada + vazamento da contagem de
 * removidos, se divergisse). Ordenação `createdAt desc` determinística.
 *
 * Round-trips fixados em teste (gate 10): `findMany` (join `Topic →
 * Discipline` + projeção de existência de `breakdown`, `relationJoins` como
 * DEFAULT global do Prisma 7 para relação para-um) e `count`, sempre 2 — não
 * cresce com o nº de itens.
 */
export async function listRawContents(
  query: ListRawContentsQuery,
  actor: ContentActor,
  db: RawContentClient = prisma,
): Promise<Paginated<RawContentSummary>> {
  const { page, perPage } = query;
  const where: Prisma.RawContentWhereInput = {
    ...ACTIVE_RAW_CONTENT_WHERE,
    ...scopeWhere(actor),
  };

  const [rows, total] = await Promise.all([
    db.rawContent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: RAW_CONTENT_SUMMARY_SELECT,
    }),
    db.rawContent.count({ where }),
  ]);

  return {
    data: rows.map(toRawContentSummary),
    page,
    perPage,
    total,
  };
}
