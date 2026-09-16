import type { Prisma } from '../../generated/prisma/client';
import { ForbiddenError, NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import { assertRawContentReachable, type ContentActor } from '../contents/contents.service';
import { recordProductionStageEvent } from '../production-events/production-events.service';
import type { CreateContrastInput, UpdateContrastInput } from './contrasts.schema';

/**
 * Ciclo de vida de Contraste (COMP-027-002 / TASK-027-003): `createContrast`,
 * `listContrasts`, `updateContrast`, `removeContrast` — DELETE físico da
 * linha, nunca do `RawContent` titular (FR-026-006). Guarda composta em TODA
 * função, na ordem declarada (PLAN §6 DEC-027-005, molde
 * `tira.service.ts`/`visual-associations.service.ts`):
 *
 *   1. `assertRawContentReachable` (importado de `contents.service.ts`) —
 *      SEMPRE a 1ª checagem, escopo de autoria do `RawContent` PAI
 *      (DEC-027-005: a leitura de Contraste reusa o MESMO alcance por
 *      autoria de `RawContent`, nunca a leitura irrestrita de
 *      `VisualAssociation` — TRISK-027-004).
 *   2. Em `updateContrast`/`removeContrast`: lê o Contraste por
 *      `{ id: contrastId, rawContentId }` (guarda de pertencimento — um
 *      `contrastId` que não pertence ao `rawContentId` da URL é
 *      `NotFoundError`, mesmo raciocínio de `updateMnemonicFrameText`/
 *      `frameId` em `tira.service.ts`) — SÓ DEPOIS da guarda de alcance (1).
 *   3. Em `updateContrast`/`removeContrast`: `actor.role === 'ADMIN' ||
 *      row.authorId === actor.id`, senão `ForbiddenError` (molde de
 *      `assertVisualAssociationWritable`, F5) — SÓ DEPOIS de ler a linha (2)
 *      e ANTES de qualquer `update`/`delete`.
 *
 * `authorId` gravado SEMPRE de `actor.id`, nunca do `input` (o schema Zod nem
 * declara o campo) — mesmo padrão de `createVisualAssociation`, DEC-023-012.
 * Create/update/remove rodam em `$transaction` com `recordProductionStageEvent`
 * (`stageType: 'MATERIAL_REFORCO'`) na 1ª mutação humana do Contraste — a
 * MESMA função decide ABERTURA/CONCLUSAO/RETRABALHO (DEC-010-005), nenhum
 * código novo decide isso aqui.
 */

const CONTRAST_DETAIL_SELECT = {
  id: true,
  rawContentId: true,
  authorId: true,
  confusableText: true,
  distinctionText: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ContrastSelect;

export interface ContrastDetail {
  id: string;
  rawContentId: string;
  authorId: string;
  confusableText: string;
  distinctionText: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cliente Prisma injetável (mesmo padrão de `RawContentClient`/
 * `VisualAssociationClient`): cobre `contrast` e `$transaction` — toda escrita
 * roda numa transação interativa (fail-secure, NFR-026-005). Ganha
 * `'rawContent'` porque `assertRawContentReachable` (importado de
 * `contents.service.ts`) o exige no tipo do `db` que recebe.
 */
type ContrastClient = Pick<typeof prisma, 'contrast' | 'rawContent' | '$transaction'>;

/**
 * Cria um Contraste vinculado a um `RawContent` titular (FR-026-001/002).
 */
export async function createContrast(
  rawContentId: string,
  input: CreateContrastInput,
  actor: ContentActor,
  db: ContrastClient = prisma,
): Promise<ContrastDetail> {
  return db.$transaction(async (tx) => {
    await assertRawContentReachable(rawContentId, actor, tx);

    const now = new Date();

    const created = await tx.contrast.create({
      data: {
        rawContentId,
        authorId: actor.id,
        confusableText: input.confusableText,
        distinctionText: input.distinctionText,
      },
      select: CONTRAST_DETAIL_SELECT,
    });

    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'MATERIAL_REFORCO',
      actorId: actor.id,
      now,
    });

    return created;
  });
}

/**
 * Lista os Contrastes do `RawContent` titular, ordenados por `createdAt asc`
 * (FR-026-005). Leitura comum a EDITOR/ADMIN dentro do alcance do
 * `RawContent` pai (DEC-027-005): nenhum filtro adicional por `authorId` do
 * Contraste — um EDITOR que alcança seu próprio `RawContent` vê TODOS os
 * Contrastes nele, mesmo os criados por um ADMIN.
 */
export async function listContrasts(
  rawContentId: string,
  actor: ContentActor,
  db: ContrastClient = prisma,
): Promise<ContrastDetail[]> {
  await assertRawContentReachable(rawContentId, actor, db);

  return db.contrast.findMany({
    where: { rawContentId },
    orderBy: { createdAt: 'asc' },
    select: CONTRAST_DETAIL_SELECT,
  });
}

/**
 * Edita um Contraste existente (FR-026-006): autor ou ADMIN, nunca outro
 * EDITOR que só alcance o `RawContent` pai.
 */
export async function updateContrast(
  rawContentId: string,
  contrastId: string,
  input: UpdateContrastInput,
  actor: ContentActor,
  db: ContrastClient = prisma,
): Promise<ContrastDetail> {
  return db.$transaction(async (tx) => {
    await assertRawContentReachable(rawContentId, actor, tx);

    const existing = await tx.contrast.findUnique({
      where: { id: contrastId, rawContentId },
      select: { authorId: true },
    });
    if (existing === null) {
      throw new NotFoundError('Contraste não encontrado.');
    }

    if (actor.role !== 'ADMIN' && existing.authorId !== actor.id) {
      throw new ForbiddenError('Você não tem permissão para alterar este contraste.');
    }

    const now = new Date();

    const updated = await tx.contrast.update({
      where: { id: contrastId },
      data: {
        confusableText: input.confusableText,
        distinctionText: input.distinctionText,
      },
      select: CONTRAST_DETAIL_SELECT,
    });

    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'MATERIAL_REFORCO',
      actorId: actor.id,
      now,
    });

    return updated;
  });
}

/**
 * Remove um Contraste (FR-026-006/007) — DELETE físico da LINHA DO CONTRASTE,
 * nunca do `RawContent` titular. Autor ou ADMIN, mesma guarda de
 * `updateContrast`.
 */
export async function removeContrast(
  rawContentId: string,
  contrastId: string,
  actor: ContentActor,
  db: ContrastClient = prisma,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await assertRawContentReachable(rawContentId, actor, tx);

    const existing = await tx.contrast.findUnique({
      where: { id: contrastId, rawContentId },
      select: { authorId: true },
    });
    if (existing === null) {
      throw new NotFoundError('Contraste não encontrado.');
    }

    if (actor.role !== 'ADMIN' && existing.authorId !== actor.id) {
      throw new ForbiddenError('Você não tem permissão para remover este contraste.');
    }

    await tx.contrast.delete({ where: { id: contrastId } });

    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'MATERIAL_REFORCO',
      actorId: actor.id,
      now: new Date(),
    });
  });
}
