import { changePasswordSchema, loginSchema } from '../../src/modules/auth/auth.schema';

describe('loginSchema', () => {
  it('normaliza o e-mail — apara espaços e baixa a caixa antes de validar o formato', () => {
    const parsed = loginSchema.parse({ email: '  Editor@Example.COM  ', password: 'x' });

    expect(parsed.email).toBe('editor@example.com');
  });

  it('recusa e-mail sem formato válido', () => {
    const result = loginSchema.safeParse({ email: 'nao-e-email', password: 'x' });

    expect(result.success).toBe(false);
  });

  it('recusa senha vazia', () => {
    const result = loginSchema.safeParse({ email: 'editor@example.com', password: '' });

    expect(result.success).toBe(false);
  });

  it('recusa senha acima de 200 caracteres — teto que protege o KDF de amplificação de DoS', () => {
    const under = loginSchema.safeParse({ email: 'e@example.com', password: 'a'.repeat(200) });
    const over = loginSchema.safeParse({ email: 'e@example.com', password: 'a'.repeat(201) });

    expect(under.success).toBe(true);
    expect(over.success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('recusa senha atual vazia', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: '',
      newPassword: 'uma-senha-bem-longa',
    });

    expect(result.success).toBe(false);
  });

  it('exige ao menos 12 caracteres na nova senha (FR-002-022)', () => {
    const eleven = changePasswordSchema.safeParse({
      currentPassword: 'atual',
      newPassword: 'a'.repeat(11),
    });
    const twelve = changePasswordSchema.safeParse({
      currentPassword: 'atual',
      newPassword: 'a'.repeat(12),
    });

    expect(eleven.success).toBe(false);
    expect(twelve.success).toBe(true);
  });

  it('recusa nova senha acima de 200 caracteres', () => {
    const over = changePasswordSchema.safeParse({
      currentPassword: 'atual',
      newPassword: 'a'.repeat(201),
    });

    expect(over.success).toBe(false);
  });
});
