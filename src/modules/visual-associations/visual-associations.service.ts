import type { Prisma } from '../../generated/prisma/client';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import type { ContentActor } from '../contents/contents.service';
import { detectImageSignature, mimeTypeForFormat } from './image-signature';
import type {
  CreateVisualAssociationBodyInput,
  UpdateVisualAssociationBodyInput,
} from './visual-associations.schema';

/**
 * Núcleo do acervo de associações visuais (COMP-023-005): criação
 * (`createVisualAssociation`) e edição in-place (`updateVisualAssociation`) — mais a
 * guarda `assertVisualAssociationWritable` (DEC-023-006), chamada aqui só por
 * `updateVisualAssociation`. Listagem/busca/remoção/entrega do binário ficam fora
 * deste arquivo.
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
 * cobre `visualAssociation` e `$transaction` — toda escrita roda numa transação
 * interativa (fail-secure, nenhuma linha meio-salva).
 */
type VisualAssociationClient = Pick<typeof prisma, 'visualAssociation' | '$transaction'>;

/**
 * Guarda pura (sem I/O, DEC-023-006): recebe a linha já lida. EDITOR só escreve a
 * própria associação; ADMIN irrestrito. NASCE nesta TASK — só `updateVisualAssociation`
 * chama aqui (`removeVisualAssociation`, TASK-023-010, é a 2ª chamadora — nunca herdada
 * desta). Erro de escrita é 403 (`ForbiddenError`), não 404: a existência da associação
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
