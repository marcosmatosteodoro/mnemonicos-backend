import type { UserRole } from '../../domain/types';
import type { Prisma } from '../../generated/prisma/client';
import { NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import type { CreateRawContentInput, UpdateRawContentInput } from './contents.schema';

/**
 * Núcleo do ciclo de vida do Conteúdo bruto (COMP-006-003 / TASK-006-006):
 * criar, reabrir, editar e remover (reversível). `listRawContents`
 * (TASK-006-008) e a Quebra da regra (TASK-006-009) reusam o helper de alcance
 * e o filtro `deletedAt: null` exportados daqui — não os recriam.
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
