import { Prisma, closeTestDb, resetDb, testPrisma } from './db';

/**
 * Teste-fumaça do próprio harness de integração (COMP-003-025). Não exercita
 * regra de negócio — prova que a infra entrega o que as TASKs 006+ vão assumir:
 * conexão real com o `mnemonicos_test`, `resetDb()` isolando os casos, e o schema
 * da migração `add_session_and_user_disabled` (TASK-003-002) de fato aplicado —
 * incluindo o `@unique` de `Session.accessTokenHash`, cujo teste foi adiado para cá.
 */
describe('harness de integração com banco', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('conecta no banco de teste `mnemonicos_test`, não no de desenvolvimento', async () => {
    const [row] = await testPrisma.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database() AS current_database
    `;

    expect(row?.current_database).toBe('mnemonicos_test');
  });

  it('resetDb() deixa as tabelas de dados vazias', async () => {
    const users = await testPrisma.user.count();
    const sessions = await testPrisma.session.count();

    expect(users).toBe(0);
    expect(sessions).toBe(0);
  });

  it('registra um usuário — a linha existe dentro do caso', async () => {
    await testPrisma.user.create({
      data: {
        email: 'harness@example.com',
        name: 'Harness',
        passwordHash: 'hash-ficticio-de-teste',
      },
    });

    expect(await testPrisma.user.count()).toBe(1);
  });

  it('não enxerga o usuário do caso anterior — o resetDb() do beforeEach truncou', async () => {
    expect(await testPrisma.user.count()).toBe(0);
  });

  it('rejeita duas sessões com o mesmo accessTokenHash (o @unique da migração de TASK-003-002 está no banco)', async () => {
    const user = await testPrisma.user.create({
      data: {
        email: 'sessao@example.com',
        name: 'Dona da Sessão',
        passwordHash: 'hash-ficticio-de-teste',
      },
    });

    const base = {
      userId: user.id,
      familyId: 'familia-1',
      accessExpiresAt: new Date(Date.now() + 15 * 60_000),
      refreshExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    };

    await testPrisma.session.create({
      data: {
        ...base,
        accessTokenHash: 'access-hash-repetido',
        refreshTokenHash: 'refresh-hash-1',
      },
    });

    const duplicate = testPrisma.session.create({
      data: {
        ...base,
        accessTokenHash: 'access-hash-repetido',
        refreshTokenHash: 'refresh-hash-2',
      },
    });

    await expect(duplicate).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(duplicate).rejects.toMatchObject({ code: 'P2002' });
  });
});
