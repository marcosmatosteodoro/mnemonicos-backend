import { z } from 'zod';

/**
 * Entrada da rota de login. O e-mail é normalizado (trim + minúsculas) antes de
 * validar o formato, para que ` User@Example.com ` e `user@example.com` resolvam
 * a mesma conta. O `.max(200)` na senha limita o corpo que chega ao KDF caro
 * (Argon2id, 19 MiB) — sem ele, um corpo grande vira amplificação de DoS
 * (gate 8 da Wave 2). As mensagens são pt-BR e não apontam qual campo faltou
 * além do necessário.
 */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Informe um e-mail válido.')),
  password: z
    .string()
    .min(1, 'Informe a senha.')
    .max(200, 'A senha excede o tamanho máximo permitido.'),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Entrada da troca da própria senha. `newPassword` carrega a política de 12
 * caracteres (FR-002-022) e o mesmo teto de 200 que protege o KDF. `currentPassword`
 * só precisa ser não-vazia — quem confere se ela está certa é o serviço.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual.'),
  newPassword: z
    .string()
    .min(12, 'A nova senha deve ter ao menos 12 caracteres.')
    .max(200, 'A nova senha excede o tamanho máximo permitido.'),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
