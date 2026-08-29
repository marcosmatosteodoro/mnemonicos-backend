import { z } from 'zod';

import { listDisciplinesQuerySchema } from '../disciplines/disciplines.schema';

/**
 * Schemas Zod da gestão de contas internas (COMP-003-013). Mensagens em pt-BR
 * (§3 do perfil). A saída do parse é consumida pelo tipo `z.infer` — o `data` do
 * Prisma é montado campo a campo a partir dela, nunca o `req.body` cru (§6.1).
 */

/**
 * Criação de conta interna por ADMIN (FR-002-014 / FR-002-022 / A-002-015).
 *
 * - `email`: normalizado (trim + minúsculas) **antes** de validar o formato, para
 *   que ` User@Example.com ` e `user@example.com` sejam a mesma conta — mesma
 *   ordem de `loginSchema`.
 * - `role`: só `EDITOR` ou `ADMIN`. `STUDENT` é recusado na fronteira (FR-002-022 /
 *   A-002-015 — o papel do estudante segue dormente, sem caminho que o crie).
 * - `password`: piso de 12 (política de senha interna) e teto de 200 — o teto
 *   limita o corpo que chega ao Argon2id (19 MiB), senão um corpo grande vira
 *   amplificação de DoS (lição do KDF, Wave 2/3).
 */
export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Informe um e-mail válido.')),
  name: z.string().trim().min(1, 'Informe o nome.'),
  role: z.enum(['EDITOR', 'ADMIN'], {
    error: 'O papel deve ser EDITOR ou ADMIN.',
  }),
  password: z
    .string()
    .min(12, 'A senha deve ter ao menos 12 caracteres.')
    .max(200, 'A senha excede o tamanho máximo permitido.'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * Reset de senha de uma conta por ADMIN (FR-002-020 / FR-002-022). Mesma política
 * de 12 caracteres e o mesmo teto de 200 da criação — a recusa de senha curta
 * vale na criação **e** no reset.
 */
export const resetPasswordSchema = z.object({
  password: z
    .string()
    .min(12, 'A senha deve ter ao menos 12 caracteres.')
    .max(200, 'A senha excede o tamanho máximo permitido.'),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** `:id` das rotas de conta — precisa ser um UUID para sequer chegar ao serviço. */
export const userIdParamSchema = z.object({
  id: z.uuid('Identificador de conta inválido.'),
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;

/**
 * Paginação da listagem de contas — reusa o schema de `disciplines` (§9 do
 * perfil: regra repetida de paginação é `.extend()` do base, não cópia). O
 * `search` herdado filtra por nome/e-mail no serviço.
 */
export const listUsersQuerySchema = listDisciplinesQuerySchema.extend({});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
