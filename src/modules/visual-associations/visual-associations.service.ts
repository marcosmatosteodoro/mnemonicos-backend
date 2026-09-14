import type { Paginated } from '../../domain/types';
import type { Prisma } from '../../generated/prisma/client';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import type { ContentActor } from '../contents/contents.service';
import { detectImageSignature, mimeTypeForFormat } from './image-signature';
import type {
  CreateVisualAssociationBodyInput,
  ListVisualAssociationsQuery,
  UpdateVisualAssociationBodyInput,
} from './visual-associations.schema';

/**
 * Núcleo do acervo de associações visuais (COMP-023-005): criação
 * (`createVisualAssociation`), edição in-place (`updateVisualAssociation`) e remoção com
 * trava de vínculo ativo (`removeVisualAssociation`) — mais a guarda
 * `assertVisualAssociationWritable` (DEC-023-006), chamada por `updateVisualAssociation`
 * e `removeVisualAssociation` — a leitura em massa (`normalizeCategoryKey`/
 * `suggestCategories`, `listVisualAssociations`, `listVisualAssociationCategories`,
 * TASK-023-014/COMP-023-005) e a leitura do binário individual
 * (`getVisualAssociationBinary`, TASK-023-016).
 */

/**
 * `select` explícito: exclui `imageData` do payload de resposta de `create`/`update` —
 * o binário nunca trafega na resposta JSON de criação/edição, só via `GET .../:id/image`.
 */
const VISUAL_ASSOCIATION_DETAIL_SELECT = {
  id: true,
  authorId: true,
  category: true,
  cognitiveDescription: true,
  mimeType: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.VisualAssociationSelect;

type VisualAssociationDetailRow = Prisma.VisualAssociationGetPayload<{
  select: typeof VISUAL_ASSOCIATION_DETAIL_SELECT;
}>;

export interface VisualAssociationDetail {
  id: string;
  authorId: string;
  category: string;
  cognitiveDescription: string;
  mimeType: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Arquivo já parseado pelo `multer` (memory storage) — nunca `originalname`/`mimetype` do cliente (DEC-023-012). */
export interface UploadedImageFile {
  buffer: Buffer;
  sizeBytes: number;
}

/**
 * Cliente Prisma injetável (mesmo padrão de `RawContentClient`/`MnemonicStripClient`):
 * cobre `visualAssociation`, `$transaction` (toda escrita roda numa transação
 * interativa — fail-secure, nenhuma linha meio-salva) e `mnemonicFrame` (só
 * `removeVisualAssociation` o usa, para montar `reachableLinks`/`outOfReachCount`
 * quando a remoção é recusada por vínculo ativo, FR-022-022).
 */
type VisualAssociationClient = Pick<
  typeof prisma,
  'visualAssociation' | 'mnemonicFrame' | '$transaction'
>;

/**
 * Guarda pura (sem I/O, DEC-023-006): recebe a linha já lida. EDITOR só escreve a
 * própria associação; ADMIN irrestrito. Toda função exportada que escreve nesta
 * entidade chama esta guarda com prova comportamental PRÓPRIA (nunca herdada de
 * outra chamadora). Erro de escrita é 403 (`ForbiddenError`), não 404: a existência da associação
 * já é pública (leitura/busca/vínculo comuns a todo EDITOR/ADMIN, FR-022-023) — recusar
 * com 403 explícito não vaza nada que o ator já não soubesse (ao contrário do padrão de
 * `RawContent`/`assertRawContentReachable`, que mascara 403 como 404 para não revelar
 * existência a quem não alcança o pai).
 */
export function assertVisualAssociationWritable(
  association: Pick<VisualAssociationDetail, 'authorId'>,
  actor: ContentActor,
): void {
  if (actor.role !== 'ADMIN' && association.authorId !== actor.id) {
    throw new ForbiddenError('Você não tem permissão para alterar esta associação visual.');
  }
}

/** Cliente Prisma injetável exigido só por `assertVisualAssociationExists`. */
type VisualAssociationExistenceClient = Pick<typeof prisma, 'visualAssociation'>;

/**
 * Confirma que a associação visual existe — leitura comum a todo EDITOR/ADMIN
 * (FR-022-023, 2ª cláusula: leitura/busca/vínculo do acervo são comuns,
 * independente de quem criou a associação; só a ESCRITA sobre a associação em
 * si é restrita ao autor, guarda que é `assertVisualAssociationWritable`
 * acima — não esta). Chamada por `tira.service.ts` antes de vincular uma
 * associação a um Quadro (DEC-023-009: `tira.service.ts` importa deste
 * módulo, nunca o inverso). `NotFoundError` — mesma mensagem de
 * `updateVisualAssociation`/`removeVisualAssociation` para o id inexistente.
 */
export async function assertVisualAssociationExists(
  id: string,
  db: VisualAssociationExistenceClient = prisma,
): Promise<void> {
  const existing = await db.visualAssociation.findUnique({
    where: { id },
    select: { id: true },
  });
  if (existing === null) {
    throw new NotFoundError('Associação visual não encontrada.');
  }
}

/** Cliente Prisma injetável exigido só por `getVisualAssociationBinary`. */
type VisualAssociationBinaryClient = Pick<typeof prisma, 'visualAssociation'>;

const VISUAL_ASSOCIATION_BINARY_SELECT = {
  imageData: true,
  mimeType: true,
} as const satisfies Prisma.VisualAssociationSelect;

export interface VisualAssociationBinary {
  imageData: Buffer;
  mimeType: string;
}

/**
 * Leitura pura do binário (COMP-023-005, TASK-023-016) — `select` explícito, só
 * `imageData`/`mimeType`. Nenhuma checagem de autoria: a leitura/busca/vínculo do
 * acervo é comum a todo EDITOR/ADMIN (FR-022-023, 2ª cláusula) — A-023-001 [assumido]
 * do PLAN, a barreira é a sessão EDITOR/ADMIN válida na rota (NFR-022-005), não uma
 * restrição de alcance por autoria. `null` se o `id` não existir.
 */
export async function getVisualAssociationBinary(
  id: string,
  db: VisualAssociationBinaryClient = prisma,
): Promise<VisualAssociationBinary | null> {
  const row = await db.visualAssociation.findUnique({
    where: { id },
    select: VISUAL_ASSOCIATION_BINARY_SELECT,
  });
  if (row === null) {
    return null;
  }
  return {
    // `Bytes` do Prisma tipa como `Uint8Array<ArrayBuffer>`; `Buffer.from` respeita
    // offset/length (node-22.md §11) — nunca `.buffer` direto.
    imageData: Buffer.from(row.imageData),
    mimeType: row.mimeType,
  };
}

/**
 * Detecta o formato raster por assinatura de bytes (`image-signature.ts`, COMP-023-002)
 * e devolve o `mimeType` correspondente — nunca o `Content-Type` declarado pelo cliente
 * (NFR-022-001/DEC-023-012). `null` (formato não reconhecido, inclusive SVG textual)
 * vira `BadRequestError` sem persistir nada (FR-022-002).
 */
function detectedMimeTypeOrThrow(buffer: Buffer): string {
  const format = detectImageSignature(buffer);
  if (format === null) {
    throw new BadRequestError(
      'Arquivo enviado não corresponde a um formato de imagem aceito (PNG, JPEG ou WebP).',
    );
  }
  return mimeTypeForFormat(format);
}

/**
 * Cria uma associação visual (FR-022-001/002/003/004), dentro de `$transaction`:
 * `detectImageSignature` primeiro — formato não reconhecido lança `BadRequestError`
 * SEM persistir nada; formato válido → `create` da linha com `imageData`/`mimeType` no
 * MESMO INSERT. `authorId: actor.id` SEMPRE — nunca lido de `input` (o schema Zod nem
 * declara o campo, mas mesmo um `authorId`/`author` espúrio injetado no corpo é ignorado
 * por construção: o `data` é montado campo a campo, nunca por spread do body — DEC-023-012).
 */
export async function createVisualAssociation(
  input: CreateVisualAssociationBodyInput,
  file: UploadedImageFile,
  actor: ContentActor,
  db: VisualAssociationClient = prisma,
): Promise<VisualAssociationDetail> {
  return db.$transaction(async (tx) => {
    const mimeType = detectedMimeTypeOrThrow(file.buffer);

    const created: VisualAssociationDetailRow = await tx.visualAssociation.create({
      data: {
        authorId: actor.id,
        category: input.category,
        cognitiveDescription: input.cognitiveDescription,
        // `Buffer` é `Uint8Array<ArrayBufferLike>`; o campo `Bytes` do Prisma espera
        // `Uint8Array<ArrayBuffer>` — só o parâmetro genérico diverge (mesmo gotcha de
        // `visual-association-storage.ts`, node-22.md §11).
        imageData: file.buffer as unknown as Uint8Array<ArrayBuffer>,
        mimeType,
      },
      select: VISUAL_ASSOCIATION_DETAIL_SELECT,
    });
    return created;
  });
}

/**
 * Edita in-place uma associação visual existente (FR-022-006), dentro de `$transaction`:
 * 1. Lê a linha (`authorId`) — 404 (`NotFoundError`) se o id não existir.
 * 2. `assertVisualAssociationWritable` PRIMEIRO (autor ou ADMIN, senão 403) — antes de
 *    qualquer validação do arquivo novo ou da escrita em si.
 * 3. Sem arquivo novo: atualiza só os campos de texto enviados. Com arquivo novo:
 *    repete `detectImageSignature` e grava `imageData`/`mimeType` novos no MESMO UPDATE
 *    (substituição atômica — sem arquivo antigo para apagar à parte, DEC-023-002).
 *
 * Fail-secure: leitura, guarda, validação do arquivo e escrita rodam na MESMA
 * `$transaction` — falha em qualquer passo não deixa a linha meio-atualizada.
 */
export async function updateVisualAssociation(
  id: string,
  input: UpdateVisualAssociationBodyInput,
  file: UploadedImageFile | undefined,
  actor: ContentActor,
  db: VisualAssociationClient = prisma,
): Promise<VisualAssociationDetail> {
  return db.$transaction(async (tx) => {
    const existing = await tx.visualAssociation.findUnique({
      where: { id },
      select: { authorId: true },
    });
    if (existing === null) {
      throw new NotFoundError('Associação visual não encontrada.');
    }

    assertVisualAssociationWritable(existing, actor);

    const imageFields =
      file === undefined
        ? {}
        : {
            imageData: file.buffer as unknown as Uint8Array<ArrayBuffer>,
            mimeType: detectedMimeTypeOrThrow(file.buffer),
          };

    const updated: VisualAssociationDetailRow = await tx.visualAssociation.update({
      where: { id },
      data: {
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.cognitiveDescription === undefined
          ? {}
          : { cognitiveDescription: input.cognitiveDescription }),
        ...imageFields,
      },
      select: VISUAL_ASSOCIATION_DETAIL_SELECT,
    });
    return updated;
  });
}

/**
 * Detalhes dos vínculos quando a remoção é recusada por vínculo ativo (FR-022-022):
 * `reachableLinks` só os Quadros/Tiras cujo `RawContent` o `actor` alcança por autoria
 * (ADMIN vê todos); `outOfReachCount` é o resto, agregado, SEM identificar
 * `rawContentId`/`frameId` nenhum deles.
 */
export interface RemoveVisualAssociationConflictDetails {
  reachableLinks: Array<{ rawContentId: string; frameId: string }>;
  outOfReachCount: number;
}

/**
 * `select` do `MnemonicFrame` vinculado a uma associação, carregando a cadeia
 * Frame→Strip→RuleBreakdown→RawContent (só `authorId`/`deletedAt`, o suficiente para
 * decidir alcance por autoria e estado ativo/soft-deleted) — usado só por
 * `removeVisualAssociation` para montar `reachableLinks`/`outOfReachCount`.
 */
const REMOVE_LINKED_FRAME_SELECT = {
  id: true,
  strip: {
    select: {
      ruleBreakdown: {
        select: {
          rawContent: { select: { id: true, authorId: true, deletedAt: true } },
        },
      },
    },
  },
} as const satisfies Prisma.MnemonicFrameSelect;

type RemoveLinkedFrameRow = Prisma.MnemonicFrameGetPayload<{
  select: typeof REMOVE_LINKED_FRAME_SELECT;
}>;

/**
 * Remove uma associação visual do acervo (FR-022-007/FR-022-008), dentro de
 * `$transaction`:
 * 1. Trava a linha PAI com `SELECT ... FOR UPDATE` — 1º statement, ANTES de
 *    ler/decidir qualquer coisa. `FOR UPDATE` conflita com o `FOR KEY SHARE` que o
 *    próprio trigger de integridade referencial do Postgres toma sobre esta linha
 *    quando `linkVisualAssociationToFrame` grava um vínculo (`tira.service.ts`): (a)
 *    um vinculador em curso (ainda não commitado) faz este `SELECT` esperar — quando
 *    ele commita, o PRÓXIMO statement (`deleteMany`, passo 3) abre um snapshot NOVO
 *    sob READ COMMITTED, que já enxerga o vínculo recém-commitado; sem esta trava, o
 *    `deleteMany` sozinho também espera o lock do vinculador, mas resolve a condição
 *    do `where` contra o snapshot ORIGINAL do statement — tomado ANTES da espera —,
 *    então não vê o vínculo commitado durante a espera e apaga a linha por engano,
 *    anulando o vínculo em silêncio via `SetNull`; (b) um vinculador POSTERIOR a este
 *    lock fica bloqueado atrás dele e, se este `remove` commitar primeiro (apagando a
 *    linha), falha FECHADO na FK (`P2003`, mapeado por `linkVisualAssociationToFrame`
 *    em `tira.service.ts`) em vez de ter o vínculo anulado. `undefined` (nenhuma linha)
 *    → `NotFoundError`.
 * 2. `assertVisualAssociationWritable` (autor ou ADMIN, senão 403) — 2ª chamadora da
 *    guarda (DEC-023-006; TASK-023-008 entregou a 1ª, `updateVisualAssociation`, com
 *    prova comportamental própria — não herdada aqui, lição "[Segurança] Guarda
 *    reusada continua exigindo prova comportamental própria por novo método de
 *    escrita").
 * 3. Trava de vínculo ativo na ESCRITA: o `deleteMany` carrega a CONDIÇÃO no próprio
 *    `where`: `frames: { none: { strip: { ruleBreakdown: { rawContent: { deletedAt:
 *    null } } } } }` só casa (permite o delete) quando NENHUM `MnemonicFrame` vinculado
 *    tem cadeia até um `RawContent` ainda ativo (não soft-deleted, FR-022-019) — a
 *    decisão de bloquear é do PRÓPRIO banco, na MESMA operação que apagaria a linha.
 * 4. `result.count === 1` → sucesso, o binário some junto (é a mesma linha).
 *    `result.count === 0` → a linha existe e é escrita pelo `actor` (passos 1-2 já
 *    confirmaram); a única razão do `where` condicional não ter casado é 1+ vínculo
 *    ATIVO. SÓ ENTÃO uma leitura SEPARADA (fora da decisão de segurança, só para montar
 *    a mensagem) resolve `reachableLinks`/`outOfReachCount` (FR-022-022): para cada
 *    Quadro vinculado, o alcance por autoria do `actor` sobre o `RawContent` de origem é
 *    resolvido PRIMEIRO — só quadros fora do alcance somam em `outOfReachCount`, SEM
 *    inspecionar `deletedAt` (nunca revela se um vínculo fora do alcance está ativo ou
 *    soft-deleted, corolário de ordem do PLAN); só DEPOIS, dentre os alcançáveis, os
 *    ATIVOS entram em `reachableLinks` (soft-deleted alcançável não bloqueia a remoção,
 *    então não é listado como algo a desvincular).
 *
 * Fail-secure: o lock, a guarda e a trava condicional rodam na MESMA `$transaction` —
 * falha em qualquer passo não deixa a linha meio-removida.
 */
export async function removeVisualAssociation(
  id: string,
  actor: ContentActor,
  db: VisualAssociationClient = prisma,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; authorId: string }>>`
      SELECT id, "authorId" FROM visual_associations WHERE id = ${id} FOR UPDATE
    `;
    const existing = locked[0];
    if (existing === undefined) {
      throw new NotFoundError('Associação visual não encontrada.');
    }

    assertVisualAssociationWritable(existing, actor);

    const result = await tx.visualAssociation.deleteMany({
      where: {
        id,
        frames: {
          none: {
            strip: { ruleBreakdown: { rawContent: { deletedAt: null } } },
          },
        },
      },
    });
    if (result.count === 1) {
      return;
    }

    const linkedFrames: RemoveLinkedFrameRow[] = await tx.mnemonicFrame.findMany({
      where: { visualAssociationId: id },
      select: REMOVE_LINKED_FRAME_SELECT,
    });

    const reachableLinks: RemoveVisualAssociationConflictDetails['reachableLinks'] = [];
    let outOfReachCount = 0;
    for (const frame of linkedFrames) {
      const rawContent = frame.strip.ruleBreakdown.rawContent;
      const reachable = actor.role === 'ADMIN' || rawContent.authorId === actor.id;
      if (!reachable) {
        outOfReachCount += 1;
        continue;
      }
      if (rawContent.deletedAt === null) {
        reachableLinks.push({ rawContentId: rawContent.id, frameId: frame.id });
      }
    }

    const details: RemoveVisualAssociationConflictDetails = { reachableLinks, outOfReachCount };
    throw new ConflictError('Associação visual possui vínculos ativos.', details);
  });
}

/**
 * Trim + case-fold (NFR-022-007) — pura, sem I/O. Usada para agrupar sugestões
 * (`suggestCategories`) e para comparar o filtro `category` da query contra o texto
 * armazenado (`listVisualAssociations`, via `mode: 'insensitive'` do Prisma após
 * `trim()` do valor de entrada, DEC-023-008) — nunca altera o texto armazenado.
 */
export function normalizeCategoryKey(category: string): string {
  return category.trim().toLowerCase();
}

/**
 * Sugestão de categoria (FR-022-025) — pura, sem I/O: filtra `existingCategories` cuja
 * `normalizeCategoryKey` INCLUI `normalizeCategoryKey(query)`, devolvendo a GRAFIA
 * ORIGINAL (nunca a normalizada) das categorias combinadas, sem duplicatas (grafia
 * exata repetida na entrada não se repete na saída).
 *
 * `query` normalizado vazio (string vazia ou só espaço) → lista vazia, SEMPRE: a
 * sugestão só existe em resposta a texto digitado (FR-022-025, "ao digitar"); devolver
 * todas as categorias sem nenhuma intenção do EDITOR seria imprevisível. A fronteira
 * HTTP real (`suggestCategoriesQuerySchema`) já barra `q` vazio antes de chegar aqui —
 * este ramo só é alcançável pelo teste unitário da função pura.
 */
export function suggestCategories(existingCategories: readonly string[], query: string): string[] {
  const normalizedQuery = normalizeCategoryKey(query);
  if (normalizedQuery === '') {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const category of existingCategories) {
    if (!normalizeCategoryKey(category).includes(normalizedQuery)) {
      continue;
    }
    if (seen.has(category)) {
      continue;
    }
    seen.add(category);
    result.push(category);
  }
  return result;
}

export interface VisualAssociationSummary {
  id: string;
  category: string;
  /** Exclui vínculos cujo `RawContent` de origem foi soft-deleted (FR-022-019). */
  linkCount: number;
  createdAt: Date;
}

/**
 * MESMA cadeia de exclusão de soft-delete usada por `removeVisualAssociation`
 * (`frames.strip.ruleBreakdown.rawContent.deletedAt`, acima) e por
 * `linkVisualAssociationToFrame`/`wasReuse` (`tira.service.ts`) — nunca reimplementada
 * divergente (FR-022-019, TRISK-023-005).
 */
const ACTIVE_LINKED_FRAME_WHERE: Prisma.MnemonicFrameWhereInput = {
  strip: { ruleBreakdown: { rawContent: { deletedAt: null } } },
};

/**
 * `select` explícito, excluindo `imageData`: cada linha da listagem pode ter até 5 MB
 * no binário; arrastar isso por padrão numa consulta paginada é o custo que este
 * `select` evita por construção. `linkCount` é a contagem FILTRADA da relação `frames`
 * (`_count.select.frames.where`, suportado nativamente pelo Prisma como parte do MESMO
 * `SELECT` — não é um round-trip por linha; medido em teste, TRISK-023-005).
 */
const VISUAL_ASSOCIATION_SUMMARY_SELECT = {
  id: true,
  category: true,
  createdAt: true,
  _count: { select: { frames: { where: ACTIVE_LINKED_FRAME_WHERE } } },
} as const satisfies Prisma.VisualAssociationSelect;

type VisualAssociationSummaryRow = Prisma.VisualAssociationGetPayload<{
  select: typeof VISUAL_ASSOCIATION_SUMMARY_SELECT;
}>;

function toVisualAssociationSummary(row: VisualAssociationSummaryRow): VisualAssociationSummary {
  return {
    id: row.id,
    category: row.category,
    linkCount: row._count.frames,
    createdAt: row.createdAt,
  };
}

/**
 * Escapa os metacaracteres do padrão `LIKE`/`ILIKE` do Postgres (`\`, `%`, `_`) num
 * valor vindo do CLIENTE antes de montar um filtro `mode: 'insensitive'` do Prisma —
 * sem isso, `{ category: { equals: category.trim(), mode: 'insensitive' } }` compila
 * para `"category" ILIKE $1` e o valor de entrada é interpretado como PADRÃO, não como
 * igualdade literal (`?category=%` devolveria o acervo inteiro; `?category=Trib%`
 * casaria parcialmente). Um único `replace` com regex global sobre os 3 caracteres —
 * cada ocorrência do valor ORIGINAL é substituída uma vez só (o `replace` não reprocessa
 * o texto já inserido), então a ordem dos 3 caracteres na classe não importa.
 */
function escapeLikeMetacharacters(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Lista o acervo paginado com filtro por categoria normalizada (FR-022-010/011,
 * DEC-023-008/DEC-023-010) — mesmo padrão de paginação de `listRawContents`
 * (`contents.service.ts:310-330`): `page`/`perPage` no `where` idêntico tanto no
 * `findMany` quanto no `count`, ordenação `createdAt desc` determinística.
 *
 * `category` da query: `trim()` + `mode: 'insensitive'` do Prisma contra o texto
 * ARMAZENADO (nunca alterado) — o mesmo agrupamento de `normalizeCategoryKey`, expresso
 * como predicado SQL em vez de comparação em memória. `mode: 'insensitive'` compila
 * para `ILIKE`, então o valor de entrada passa por `escapeLikeMetacharacters` antes de
 * entrar no filtro (ver docblock da função).
 *
 * Round-trips fixados em teste (gate 10 / TRISK-023-005): `findMany` (com o `_count`
 * filtrado embutido no mesmo `SELECT`) + `count`, sempre 2 — não cresce com o nº de
 * associações listadas nem com o nº de vínculos de cada uma.
 */
export async function listVisualAssociations(
  query: ListVisualAssociationsQuery,
  db: VisualAssociationClient = prisma,
): Promise<Paginated<VisualAssociationSummary>> {
  const { page, perPage, category } = query;
  const where: Prisma.VisualAssociationWhereInput =
    category === undefined
      ? {}
      : { category: { equals: escapeLikeMetacharacters(category.trim()), mode: 'insensitive' } };

  const [rows, total] = await Promise.all([
    db.visualAssociation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: VISUAL_ASSOCIATION_SUMMARY_SELECT,
    }),
    db.visualAssociation.count({ where }),
  ]);

  return {
    data: rows.map(toVisualAssociationSummary),
    page,
    perPage,
    total,
  };
}

/**
 * Categorias distintas do acervo que combinam com `q` (FR-022-025), grafia original
 * preservada. `DISTINCT category` (1 round-trip, TRISK-023-004: custo cresce com o nº
 * de categorias distintas do acervo — aceitável no volume inicial, ferramenta interna)
 * seguido de `suggestCategories` em memória — não paginado (o resultado é uma lista de
 * sugestão curta, não o acervo inteiro).
 */
export async function listVisualAssociationCategories(
  query: { q: string },
  db: VisualAssociationClient = prisma,
): Promise<string[]> {
  const rows = await db.visualAssociation.findMany({
    distinct: ['category'],
    select: { category: true },
  });
  return suggestCategories(
    rows.map((row) => row.category),
    query.q,
  );
}
