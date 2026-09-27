/**
 * Uniões do domínio, espelhando os enums do schema.prisma.
 *
 * Ficam aqui, e não importadas do client gerado, para que a lógica pura
 * (agendamento, validação) seja compilável e testável sem depender de codegen.
 */

export const MNEMONIC_TECHNIQUES = [
  'ACRONYM',
  'ACROSTIC',
  'STORY',
  'MEMORY_PALACE',
  'KEYWORD',
  'RHYME',
  'NUMBER_PEG',
] as const;

export type MnemonicTechnique = (typeof MNEMONIC_TECHNIQUES)[number];

export const REVIEW_RATINGS = ['AGAIN', 'HARD', 'GOOD', 'EASY'] as const;

export type ReviewRating = (typeof REVIEW_RATINGS)[number];

export const USER_ROLES = ['STUDENT', 'EDITOR', 'ADMIN'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Usuário exposto numa sessão autenticada — corpo de resposta de
 * `POST /auth/login`, `GET /auth/me` e `POST /users`. Espelhado em
 * `mnemonicos-frontend/src/types/domain.ts`: mudança de um lado entra no mesmo
 * diff que o outro, ou o contrato quebra em runtime sem o typecheck acusar.
 */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

/**
 * Envelope de paginação compartilhado por toda listagem do backend; puro, sem
 * I/O.
 */
export interface Paginated<T> {
  data: T[];
  page: number;
  perPage: number;
  total: number;
}

/**
 * Classe do radar de prova e tipo de fonte normativa do Conteúdo bruto (F2).
 * Fonte canônica: `mnemonicos-backend/prisma/schema.prisma` (enums
 * `ProofRadarClass` / `NormativeSourceType`). O teste de divergência
 * cross-repo é `mnemonicos-backend/tests/unit/domain-types-parity.test.ts`
 * (estendido a estes dois enums em TASK-006-007).
 */
export const PROOF_RADAR_CLASSES = ['ALTA', 'MEDIA', 'DETALHE', 'EXCECAO', 'PEGADINHA'] as const;

export type ProofRadarClass = (typeof PROOF_RADAR_CLASSES)[number];

export const NORMATIVE_SOURCE_TYPES = [
  'CF',
  'CTN',
  'LEI',
  'LEI_COMPLEMENTAR',
  'SUMULA',
  'ATO_NORMATIVO',
] as const;

export type NormativeSourceType = (typeof NORMATIVE_SOURCE_TYPES)[number];

/**
 * Tipo de etapa e tipo de transição do evento de etapa de produção (F3,
 * SPEC-009). Fonte canônica: `mnemonicos-backend/prisma/schema.prisma` (enums
 * `ProductionStageType` / `ProductionEventTransition`). O teste de
 * autoconsistência é `mnemonicos-backend/tests/unit/domain-types-parity.test.ts`
 * (TASK-010-001) — **diferente** dos pares acima, este **não** tem espelho em
 * `mnemonicos-frontend/src/types/domain.ts` nesta fatia (DEC-010-006, YAGNI:
 * sem consumidor de tela/rota até F10).
 */
export const PRODUCTION_STAGE_TYPES = [
  'CONTEUDO_BRUTO',
  'QUEBRA_DA_REGRA',
  'TIRA_MNEMONICA',
  'ASSOCIACAO_VISUAL',
  'PUBLICACAO_PDF',
  'MATERIAL_REFORCO',
  'VERSAO_EDITORIAL',
  'APROVACAO_VERSAO',
] as const;

export type ProductionStageType = (typeof PRODUCTION_STAGE_TYPES)[number];

export const PRODUCTION_EVENT_TRANSITIONS = ['ABERTURA', 'CONCLUSAO', 'RETRABALHO'] as const;

export type ProductionEventTransition = (typeof PRODUCTION_EVENT_TRANSITIONS)[number];

/**
 * Variante do artefato exportado pelo pipeline de publicação em PDF (F6,
 * SPEC-024). Fonte canônica: `mnemonicos-backend/prisma/schema.prisma` (enum
 * `PublicationVariant`). Espelhado em
 * `mnemonicos-frontend/src/types/domain.ts` (só `type` + mapa de rótulos,
 * COMP-025-009) — o teste de divergência cross-repo é
 * `mnemonicos-backend/tests/unit/domain-types-parity.test.ts`.
 */
export const PUBLICATION_VARIANTS = ['TIRA', 'RESUMO'] as const;

export type PublicationVariant = (typeof PUBLICATION_VARIANTS)[number];

/**
 * Conteúdo bruto de produção — espelha o model `RawContent` de
 * `prisma/schema.prisma`. Espelhado em
 * `mnemonicos-frontend/src/types/domain.ts`: mudança de um lado entra no
 * mesmo diff que o outro, ou o contrato quebra em runtime sem o typecheck
 * acusar.
 */
export interface RawContent {
  id: string;
  topicId: string;
  authorId: string;
  rawText: string;
  radarClass: ProofRadarClass;
  sourceType: NormativeSourceType | null;
  sourceCitation: string | null;
  sourceUrl: string | null;
  lastEditedById: string | null;
  lastEditedAt: Date | null;
  deletedAt: Date | null;
  /** Pegadinha elaborada (COMP-027-007, TASK-027-005, DEC-027-002); null = sem Pegadinha registrada. */
  pegadinhaText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Quebra da regra — 1:1 com `RawContent` (`rawContentId` único), espelha o
 * model `RuleBreakdown` do mesmo schema. Espelhada em
 * `mnemonicos-frontend/src/types/domain.ts`.
 */
export interface RuleBreakdown {
  id: string;
  rawContentId: string;
  concept: string;
  action: string;
  object: string;
  condition: string | null;
  exception: string | null;
  essence: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Contraste entre o Conteúdo bruto titular e um instituto/regra confundível
 * (F7, SPEC-026) — espelha o model `Contrast` de `prisma/schema.prisma`.
 * Espelhado em `mnemonicos-frontend/src/types/domain.ts`: mudança de um lado
 * entra no mesmo diff que o outro, ou o contrato quebra em runtime sem o
 * typecheck acusar — rede de paridade cross-repo:
 * `mnemonicos-backend/tests/unit/contents-frontend-contract.test.ts`.
 */
export interface Contrast {
  id: string;
  rawContentId: string;
  authorId: string;
  confusableText: string;
  distinctionText: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Par pergunta/resposta autorado pelo EDITOR (F7, SPEC-026) — espelha o model
 * `ProductionFlashcard` de `prisma/schema.prisma`. Nome `ProductionFlashcard`,
 * nunca `Flashcard`: já existe `model Flashcard` (legado, SRS/CardState/
 * Review, dormente desde F2) e os dois nomes colidiriam (DEC-027-003).
 * Espelhado em `mnemonicos-frontend/src/types/domain.ts`: mudança de um lado
 * entra no mesmo diff que o outro, ou o contrato quebra em runtime sem o
 * typecheck acusar — rede de paridade cross-repo:
 * `mnemonicos-backend/tests/unit/contents-frontend-contract.test.ts`.
 */
export interface ProductionFlashcard {
  id: string;
  rawContentId: string;
  authorId: string;
  question: string;
  answer: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Versão editorial fechada de um Conteúdo bruto (F8, SPEC-028) — espelha o
 * model `ContentVersion` de `prisma/schema.prisma`, só os 6 dados imutáveis
 * expostos para leitura (`id`/`rawContentId`/`number`/`legislativeClosureDate`/
 * `authorId`/`closedAt`). **Sem** `contentSnapshot` (dado interno de verificação, nunca
 * exposto à UI, DEC-029-003). Espelhado em
 * `mnemonicos-frontend/src/types/domain.ts`: mudança de um lado entra no
 * mesmo diff que o outro, ou o contrato quebra em runtime sem o typecheck
 * acusar — rede de paridade cross-repo:
 * `mnemonicos-backend/tests/unit/contents-frontend-contract.test.ts`.
 */
export interface ContentVersion {
  id: string;
  rawContentId: string;
  number: number;
  legislativeClosureDate: Date;
  authorId: string;
  closedAt: Date;
}
