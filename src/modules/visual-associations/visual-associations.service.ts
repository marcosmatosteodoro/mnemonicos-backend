import type { Prisma } from '../../generated/prisma/client';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import type { ContentActor } from '../contents/contents.service';
import { detectImageSignature, mimeTypeForFormat } from './image-signature';
import type {
  CreateVisualAssociationBodyInput,
  UpdateVisualAssociationBodyInput,
} from './visual-associations.schema';

/**
 * Núcleo do acervo de associações visuais (COMP-023-005): criação
 * (`createVisualAssociation`), edição in-place (`updateVisualAssociation`) e remoção com
 * trava de vínculo ativo (`removeVisualAssociation`) — mais a guarda
 * `assertVisualAssociationWritable` (DEC-023-006), chamada por `updateVisualAssociation`
 * e `removeVisualAssociation`. Listagem/busca/entrega do binário ficam fora deste
 * arquivo.
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
