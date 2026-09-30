import type { Prisma } from '../../src/generated/prisma/client';
import { PublicationVariant, type PublicationEvent } from '../../src/generated/prisma/client';

/**
 * Prova só de TIPO (sem asserção em runtime, sem banco) de que o client Prisma
 * gerado por `prisma generate` a partir do schema editado nesta TASK conhece
 * `PublicationVariant`/`PublicationEvent` (TASK-025-001) — falha na compilação
 * se o schema não tiver sido regenerado, ou se `variant` mudar de nome.
 */
const variant: PublicationVariant = PublicationVariant.TIRA;

const shape: {
  rawContentId: string;
  variant: PublicationVariant;
  occurredAt: Date;
  pageCount: number | null;
} = {
  rawContentId: '0192f8a0-0000-7000-8000-000000000000',
  variant,
  occurredAt: new Date(),
  pageCount: 12,
};

const event: PublicationEvent = {
  id: '0192f8a0-0000-7000-8000-000000000001',
  ...shape,
};

/**
 * F10 (DEC-035-011): `pageCount` é opcional em `PublicationEventCreateInput` — o
 * `create` de `exportPublication` grava sem o campo (compatibilidade) tanto quanto
 * com um número ou `null` explícitos (contagem fail-safe, FR-034-019).
 */
const createInputWithoutPageCount: Prisma.PublicationEventCreateInput = {
  rawContentId: '0192f8a0-0000-7000-8000-000000000002',
  variant,
  occurredAt: new Date(),
};
const createInputWithNullPageCount: Prisma.PublicationEventCreateInput = {
  ...createInputWithoutPageCount,
  pageCount: null,
};

// Referenciados só para o compilador não descartar as declarações acima como
// não usadas — este arquivo nunca roda em runtime (não casa `**/*.test.ts`).
void event;
void createInputWithoutPageCount;
void createInputWithNullPageCount;
