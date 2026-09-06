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
] as const;

export type ProductionStageType = (typeof PRODUCTION_STAGE_TYPES)[number];

export const PRODUCTION_EVENT_TRANSITIONS = ['ABERTURA', 'CONCLUSAO', 'RETRABALHO'] as const;

export type ProductionEventTransition = (typeof PRODUCTION_EVENT_TRANSITIONS)[number];

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
