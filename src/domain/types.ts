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
