import type { Paginated, ProofRadarClass, UserRole } from '../../domain/types';
import type { Prisma } from '../../generated/prisma/client';
import { NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import type {
  CreateRawContentInput,
  ListRawContentsQuery,
  SaveRuleBreakdownInput,
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
 * remoção passa pelo **mesmo** par `scopeWhere` + `ACTIVE_RAW_CONTENT_WHERE`.
 * Quem NÃO alcança o pai (id inexistente OU fora do alcance do ator) recebe
 * sempre a mesma mensagem ("Conteúdo bruto não encontrado.") — nunca 403 —
 * para não dar a quem pede um oráculo que distinga "não existe" de "existe,
 * mas não é seu". A mensagem de remoção ("Conteúdo bruto foi removido.") só
 * chega a quem alcança o pai (dono ou ADMIN) sobre um item soft-deleted: ela
 * nomeia um fato sobre um dado que o ator já tem o direito de ver, não vaza
 * autoria de terceiro.
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

/**
 * Guarda o alcance do `RawContent` pai para a Quebra da regra (COMP-006-003 /
 * TASK-006-009) — reusa `ACTIVE_RAW_CONTENT_WHERE` e `scopeWhere` (T006/T008),
 * não reimplementa o predicado de alcance nem o filtro `deletedAt: null`.
 *
 * **Guards avaliados em ordem declarada, obrigatória** (lição [Testes] "Árvore
 * de decisão com precedência: um caso por PAR de ramos que coincide"):
 * `inexistente → fora do alcance → soft-deleted`. A guarda de alcance nunca
 * fica atrás da guarda de soft-delete: se ficasse, um EDITOR que possui o id
 * de um `RawContent` de outro autor distinguiria "não encontrado" (id
 * aleatório ou item ativo de outro autor) de "foi removido" (item de outro
 * autor soft-deleted) — um oráculo de autoria via mensagem (A01). Por isso
 * `inexistente` e `fora do alcance` são resolvidos **antes** de olhar
 * `deletedAt`, e os dois compartilham a **mesma** mensagem ("Conteúdo bruto
 * não encontrado."). Só quem alcança o pai (dono ou ADMIN) chega ao guard de
 * soft-delete e pode ver "Conteúdo bruto foi removido." — o par
 * `soft-deleted ∧ fora do alcance` (`RawContent` de outro autor, já removido)
 * resolve para **"não encontrado"**, nunca "removido": o ator nunca alcançou
 * o dado para ter o direito de saber que ele foi removido.
 */
async function assertRawContentReachable(
  rawContentId: string,
  actor: ContentActor,
  db: RawContentClient,
): Promise<void> {
  const parent = await db.rawContent.findUnique({
    where: { id: rawContentId },
    select: { authorId: true, deletedAt: true },
  });

  if (parent === null) {
    throw new NotFoundError('Conteúdo bruto não encontrado.');
  }

  const scope = scopeWhere(actor);
  if (scope.authorId !== undefined && parent.authorId !== scope.authorId) {
    throw new NotFoundError('Conteúdo bruto não encontrado.');
  }

  if (parent.deletedAt !== ACTIVE_RAW_CONTENT_WHERE.deletedAt) {
    throw new NotFoundError('Conteúdo bruto foi removido.');
  }
}

const RULE_BREAKDOWN_SELECT = {
  concept: true,
  action: true,
  object: true,
  condition: true,
  exception: true,
  essence: true,
} as const satisfies Prisma.RuleBreakdownSelect;

export interface RuleBreakdownDetail {
  concept: string;
  action: string;
  object: string;
  condition: string | null;
  exception: string | null;
  essence: string;
}

/** Cliente Prisma injetável do par `getRuleBreakdown`/`saveRuleBreakdown`. */
type RuleBreakdownClient = Pick<typeof prisma, 'rawContent' | 'ruleBreakdown'>;

/**
 * Devolve a Quebra da regra do `rawContentId` (FR-005-016, AC-005-021,
 * AC-005-031, AC-005-037): recusa via `assertRawContentReachable` quando o pai
 * não existe, está soft-deleted ou está fora do alcance do ator; 404 também
 * quando o pai é alcançável mas ainda não tem Quebra salva (nenhum
 * `saveRuleBreakdown` anterior).
 */
export async function getRuleBreakdown(
  rawContentId: string,
  actor: ContentActor,
  db: RuleBreakdownClient = prisma,
): Promise<RuleBreakdownDetail> {
  await assertRawContentReachable(rawContentId, actor, db);

  const row = await db.ruleBreakdown.findUnique({
    where: { rawContentId },
    select: RULE_BREAKDOWN_SELECT,
  });

  if (row === null) throw new NotFoundError('Quebra da regra não encontrada.');

  return row;
}

/**
 * Upsert **1:1** por `rawContentId` (`@unique` do schema — T001; FR-005-014,
 * FR-005-015, AC-005-019, AC-005-020, AC-005-024): a 1ª gravação cria, as
 * seguintes atualizam a **mesma** linha — nunca uma segunda. Mesma recusa de
 * pai de `getRuleBreakdown` (`assertRawContentReachable`), incluindo a
 * **negação de escrita** quando o `RawContent` é de outro autor (IDOR de
 * escrita — decisão 4.232): a guarda roda **antes** do `upsert`, então nenhum
 * byte chega a `rule_breakdowns` quando o ator não alcança o pai.
 *
 * Sob concorrência (2 chamadas simultâneas para o mesmo `rawContentId` sem
 * Quebra prévia), o `@unique` + `upsert` nativo do Postgres (`INSERT … ON
 * CONFLICT … DO UPDATE`) resolve atomicamente: no máximo 1 linha resulta,
 * nunca 2 — o service não faz `findFirst` + `create` (check-then-act), que
 * deixaria uma janela de corrida entre a checagem e a escrita.
 */
export async function saveRuleBreakdown(
  rawContentId: string,
  input: SaveRuleBreakdownInput,
  actor: ContentActor,
  db: RuleBreakdownClient = prisma,
): Promise<RuleBreakdownDetail> {
  await assertRawContentReachable(rawContentId, actor, db);

  const fields = {
    concept: input.concept,
    action: input.action,
    object: input.object,
    condition: input.condition ?? null,
    exception: input.exception ?? null,
    essence: input.essence,
  };

  return db.ruleBreakdown.upsert({
    where: { rawContentId },
    create: { rawContentId, ...fields },
    update: fields,
    select: RULE_BREAKDOWN_SELECT,
  });
}
