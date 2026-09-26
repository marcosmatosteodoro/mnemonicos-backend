import { testPrisma } from '../integration/db';

/**
 * Fixtures compartilhadas de Contraste/`ProductionFlashcard` (COMP-027-002/011/018) —
 * helper único (perfil node-22.md §7, "Fixtures compartilhadas"), mesma casa de
 * `production-events-fixtures.ts`/`visual-association-fixtures.ts`: usado por
 * `publication.service.integration.test.ts`.
 */

/**
 * Grava um Contraste direto via `testPrisma` — fixture de setup, fora do service sob
 * teste. `createdAt` sobrepõe o `@default(now())` do schema — usado pelas provas de ORDEM
 * de `publication.service.integration.test.ts` (AC-026-012) para inverter deliberadamente
 * a ordem de CRIAÇÃO da ordem física de inserção.
 */
export async function seedContrast(
  rawContentId: string,
  authorId: string,
  overrides: { confusableText?: string; distinctionText?: string; createdAt?: Date } = {},
) {
  return testPrisma.contrast.create({
    data: {
      rawContentId,
      authorId,
      confusableText: overrides.confusableText ?? 'Prescrição tributária.',
      distinctionText:
        overrides.distinctionText ??
        'Decadência atinge o direito de lançar; prescrição, o de cobrar.',
      ...(overrides.createdAt && { createdAt: overrides.createdAt }),
    },
  });
}

/** Grava um `ProductionFlashcard` direto via `testPrisma` — mesmo papel de `seedContrast`
 * acima, para Flashcard. */
export async function seedFlashcard(
  rawContentId: string,
  authorId: string,
  overrides: { question?: string; answer?: string; createdAt?: Date } = {},
) {
  return testPrisma.productionFlashcard.create({
    data: {
      rawContentId,
      authorId,
      question: overrides.question ?? 'Qual o prazo decadencial do lançamento tributário?',
      answer: overrides.answer ?? '5 anos, contados na forma do art. 173 do CTN.',
      ...(overrides.createdAt && { createdAt: overrides.createdAt }),
    },
  });
}
