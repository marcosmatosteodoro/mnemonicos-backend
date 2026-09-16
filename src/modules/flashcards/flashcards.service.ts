import type { Prisma } from '../../generated/prisma/client';
import { ForbiddenError, NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import { assertRawContentReachable, type ContentActor } from '../contents/contents.service';
import { recordProductionStageEvent } from '../production-events/production-events.service';
import type { CreateFlashcardInput, UpdateFlashcardInput } from './flashcards.schema';

/**
 * Ciclo de vida de `ProductionFlashcard` (COMP-027-011 / TASK-027-004):
 * `createFlashcard`, `listFlashcards`, `updateFlashcard`, `removeFlashcard` —
 * DELETE físico da linha, nunca do `RawContent` titular (FR-026-018). Opera
 * SEMPRE sobre o model `ProductionFlashcard` — nunca o model `Flashcard`
 * legado (`schema.prisma:222-243`, ligado a `Topic`/`Mnemonic`/`CardState`/
 * `Review`, dormente desde F2, DEC-027-003). Guarda composta em TODA função,
 * na ordem declarada (PLAN §6 DEC-027-005, molde `contrasts.service.ts`):
 *
 *   1. `assertRawContentReachable` (importado de `contents.service.ts`) —
 *      SEMPRE a 1ª checagem, escopo de autoria do `RawContent` PAI
 *      (DEC-027-005: a leitura de Flashcard reusa o MESMO alcance por
 *      autoria de `RawContent`, nunca a leitura irrestrita de
 *      `VisualAssociation` — TRISK-027-004).
 *   2. Em `updateFlashcard`/`removeFlashcard`: lê o Flashcard por
 *      `{ id: flashcardId, rawContentId }` (guarda de pertencimento — um
 *      `flashcardId` que não pertence ao `rawContentId` da URL é
 *      `NotFoundError`) — SÓ DEPOIS da guarda de alcance (1).
 *   3. Em `updateFlashcard`/`removeFlashcard`: `actor.role === 'ADMIN' ||
 *      row.authorId === actor.id`, senão `ForbiddenError` (molde de
 *      `assertVisualAssociationWritable`, F5) — SÓ DEPOIS de ler a linha (2)
 *      e ANTES de qualquer `update`/`delete`.
 *
 * `authorId` gravado SEMPRE de `actor.id`, nunca do `input` (o schema Zod nem
 * declara o campo) — mesmo padrão de `createVisualAssociation`, DEC-023-012.
 * Create/update/remove rodam em `$transaction` com `recordProductionStageEvent`
 * (`stageType: 'MATERIAL_REFORCO'`) na 1ª mutação humana do Flashcard — a
 * MESMA função decide ABERTURA/CONCLUSAO/RETRABALHO (DEC-010-005), nenhum
 * código novo decide isso aqui.
 */

const FLASHCARD_DETAIL_SELECT = {
  id: true,
  rawContentId: true,
  authorId: true,
  question: true,
  answer: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ProductionFlashcardSelect;

export interface FlashcardDetail {
  id: string;
  rawContentId: string;
  authorId: string;
  question: string;
  answer: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cliente Prisma injetável (mesmo padrão de `ContrastClient`): cobre
 * `productionFlashcard` e `$transaction` — toda escrita roda numa transação
 * interativa (fail-secure, NFR-026-005). Ganha `'rawContent'` porque
 * `assertRawContentReachable` (importado de `contents.service.ts`) o exige
 * no tipo do `db` que recebe.
 */
type ProductionFlashcardClient = Pick<
  typeof prisma,
  'productionFlashcard' | 'rawContent' | '$transaction'
>;

/**
 * Cria um Flashcard vinculado a um `RawContent` titular (FR-026-014/015).
 */
export async function createFlashcard(
  rawContentId: string,
  input: CreateFlashcardInput,
  actor: ContentActor,
  db: ProductionFlashcardClient = prisma,
): Promise<FlashcardDetail> {
  return db.$transaction(async (tx) => {
    await assertRawContentReachable(rawContentId, actor, tx);

    const now = new Date();

    const created = await tx.productionFlashcard.create({
      data: {
        rawContentId,
        authorId: actor.id,
        question: input.question,
        answer: input.answer,
      },
      select: FLASHCARD_DETAIL_SELECT,
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
 * Lista os Flashcards do `RawContent` titular, ordenados por `createdAt asc`
 * (FR-026-017/020). Leitura comum a EDITOR/ADMIN dentro do alcance do
 * `RawContent` pai (DEC-027-005): nenhum filtro adicional por `authorId` do
 * Flashcard — um EDITOR que alcança seu próprio `RawContent` vê TODOS os
 * Flashcards nele, mesmo os criados por um ADMIN.
 *
 * Sem teto/paginação nesta fatia (TRISK-027-002, PLAN-027 §8) — decisão de
 * introduzir teto de volume fica com quem fechar RISK-025-007 (dono do risco
 * de página sem limite neste produto).
 */
export async function listFlashcards(
  rawContentId: string,
  actor: ContentActor,
  db: ProductionFlashcardClient = prisma,
): Promise<FlashcardDetail[]> {
  await assertRawContentReachable(rawContentId, actor, db);

  return db.productionFlashcard.findMany({
    where: { rawContentId },
    orderBy: { createdAt: 'asc' },
    select: FLASHCARD_DETAIL_SELECT,
  });
}

/**
 * Edita um Flashcard existente (FR-026-016): autor ou ADMIN, nunca outro
 * EDITOR que só alcance o `RawContent` pai.
 */
export async function updateFlashcard(
  rawContentId: string,
  flashcardId: string,
  input: UpdateFlashcardInput,
  actor: ContentActor,
  db: ProductionFlashcardClient = prisma,
): Promise<FlashcardDetail> {
  return db.$transaction(async (tx) => {
    await assertRawContentReachable(rawContentId, actor, tx);

    const existing = await tx.productionFlashcard.findUnique({
      where: { id: flashcardId, rawContentId },
      select: { authorId: true },
    });
    if (existing === null) {
      throw new NotFoundError('Flashcard não encontrado.');
    }

    if (actor.role !== 'ADMIN' && existing.authorId !== actor.id) {
      throw new ForbiddenError('Você não tem permissão para alterar este flashcard.');
    }

    const now = new Date();

    const updated = await tx.productionFlashcard.update({
      where: { id: flashcardId },
      data: {
        question: input.question,
        answer: input.answer,
      },
      select: FLASHCARD_DETAIL_SELECT,
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
 * Remove um Flashcard (FR-026-018) — DELETE físico da LINHA DO FLASHCARD,
 * nunca do `RawContent` titular. Autor ou ADMIN, mesma guarda de
 * `updateFlashcard`.
 */
export async function removeFlashcard(
  rawContentId: string,
  flashcardId: string,
  actor: ContentActor,
  db: ProductionFlashcardClient = prisma,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await assertRawContentReachable(rawContentId, actor, tx);

    const existing = await tx.productionFlashcard.findUnique({
      where: { id: flashcardId, rawContentId },
      select: { authorId: true },
    });
    if (existing === null) {
      throw new NotFoundError('Flashcard não encontrado.');
    }

    if (actor.role !== 'ADMIN' && existing.authorId !== actor.id) {
      throw new ForbiddenError('Você não tem permissão para remover este flashcard.');
    }

    await tx.productionFlashcard.delete({ where: { id: flashcardId } });

    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'MATERIAL_REFORCO',
      actorId: actor.id,
      now: new Date(),
    });
  });
}
