import { PublicationVariant, type PublicationEvent } from '../../src/generated/prisma/client';

/**
 * Prova só de TIPO (sem asserção em runtime, sem banco) de que o client Prisma
 * gerado por `prisma generate` a partir do schema editado nesta TASK conhece
 * `PublicationVariant`/`PublicationEvent` (TASK-025-001) — falha na compilação
 * se o schema não tiver sido regenerado, ou se `variant` mudar de nome.
 */
const variant: PublicationVariant = PublicationVariant.TIRA;

const shape: { rawContentId: string; variant: PublicationVariant; occurredAt: Date } = {
  rawContentId: '0192f8a0-0000-7000-8000-000000000000',
  variant,
  occurredAt: new Date(),
};

const event: PublicationEvent = {
  id: '0192f8a0-0000-7000-8000-000000000001',
  ...shape,
};

// Referenciados só para o compilador não descartar as declarações acima como
// não usadas — este arquivo nunca roda em runtime (não casa `**/*.test.ts`).
void event;
