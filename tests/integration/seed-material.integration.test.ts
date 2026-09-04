import { seedAdmin } from '../../prisma/seed-admin';
import { seedDevEditor } from '../../prisma/seed-dev-editor';
import { seedMaterial } from '../../prisma/seed-material';
import { PROOF_RADAR_CLASSES } from '../../src/domain/types';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * Carga de exemplo de Direito Tributário / Obrigação Tributária (AC-005-027,
 * NFR-005-003) sobre o Postgres real. Roda **as funções puras**
 * (`seedAdmin` com credenciais explícitas → `seedMaterial(client, { authorId
 * })`), nunca `main()`: o harness de integração omite `SEED_ADMIN_*` de
 * propósito (`tests/setup-env.ts`), então `main()` sob o harness não criaria
 * ADMIN e `seedMaterial` ficaria sem `authorId` — padrão espelhado de
 * `seed-admin.integration.test.ts`.
 */

const ADMIN_EMAIL = 'admin.material@example.com';
const ADMIN_PASSWORD = 'bootstrap-secret-1234';

const EXPECTED_TOPICS = [
  'Obrigação Tributária Principal e Acessória',
  'Fato Gerador',
  'Sujeito Ativo e Passivo',
  'Solidariedade Tributária',
  'Responsabilidade Tributária',
  'Domicílio Tributário',
];

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});

async function seedAdminAndMaterial(): Promise<{ id: string; email: string }> {
  const outcome = await seedAdmin(testPrisma, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (outcome.status !== 'created') {
    throw new Error(`seedAdmin não criou o ADMIN esperado pelo teste: ${outcome.status}`);
  }

  const admin = await testPrisma.user.findUniqueOrThrow({ where: { email: outcome.email } });
  await seedMaterial(testPrisma, { authorId: admin.id });

  return admin;
}

describe('seedMaterial — AC-005-027: carga de exemplo de Obrigação Tributária', () => {
  it('(i) semeia >=1 RawContent com radarClass válido, fonte estruturada e RuleBreakdown completa', async () => {
    const admin = await seedAdminAndMaterial();

    const rawContents = await testPrisma.rawContent.findMany({
      where: { authorId: admin.id },
      include: { breakdown: true },
    });

    expect(rawContents.length).toBeGreaterThanOrEqual(1);

    for (const rawContent of rawContents) {
      expect(PROOF_RADAR_CLASSES).toContain(rawContent.radarClass);
      expect(rawContent.sourceType).not.toBeNull();
      expect(rawContent.sourceCitation?.length ?? 0).toBeGreaterThan(0);

      expect(rawContent.breakdown).not.toBeNull();
      expect(rawContent.breakdown?.concept.length ?? 0).toBeGreaterThan(0);
      expect(rawContent.breakdown?.action.length ?? 0).toBeGreaterThan(0);
      expect(rawContent.breakdown?.object.length ?? 0).toBeGreaterThan(0);
      expect(rawContent.breakdown?.essence.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('(ii) a disciplina semeada é "Direito Tributário" e os temas == a lista nomeada literal', async () => {
    await seedAdminAndMaterial();

    const discipline = await testPrisma.discipline.findUniqueOrThrow({
      where: { slug: 'direito-tributario' },
      include: { topics: true },
    });

    expect(discipline.name).toBe('Direito Tributário');
    expect(discipline.topics.map((topic) => topic.name).sort()).toEqual(
      [...EXPECTED_TOPICS].sort(),
    );
  });

  it('(iii) é possível registrar um RawContent em cada um dos 6 temas semeados', async () => {
    const admin = await seedAdminAndMaterial();

    const topics = await testPrisma.topic.findMany({
      where: { discipline: { slug: 'direito-tributario' } },
    });

    expect(topics).toHaveLength(EXPECTED_TOPICS.length);

    for (const topic of topics) {
      const created = await testPrisma.rawContent.create({
        data: {
          topicId: topic.id,
          authorId: admin.id,
          rawText: `Registro de prova para o tema "${topic.name}"`,
          radarClass: 'MEDIA',
          sourceType: 'CTN',
          sourceCitation: 'CTN, art. 1º (prova de registro)',
        },
      });

      expect(created.topicId).toBe(topic.id);
    }
  });

  it('(iv) nenhum material de Direito Administrativo/Constitucional remanesce após seedMaterial', async () => {
    await seedAdminAndMaterial();

    const legacyDisciplines = await testPrisma.discipline.count({
      where: { name: { in: ['Direito Administrativo', 'Direito Constitucional'] } },
    });
    expect(legacyDisciplines).toBe(0);

    const legacyTopics = await testPrisma.topic.count({
      where: { discipline: { name: { in: ['Direito Administrativo', 'Direito Constitucional'] } } },
    });
    expect(legacyTopics).toBe(0);

    expect(await testPrisma.mnemonic.count()).toBe(0);
  });

  it('invariante §1.3 — nenhum RawContent semeado fica sem radarClass', async () => {
    await seedAdminAndMaterial();

    const rows = await testPrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM raw_contents WHERE "radarClass" IS NULL
    `;

    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });
});

describe('seedDevEditor — sujeito de dev do gate 9 das telas', () => {
  it('credenciais presentes: cria exatamente 1 EDITOR com o e-mail dado', async () => {
    const outcome = await seedDevEditor(testPrisma, {
      email: 'editor.dev@example.com',
      password: 'editor-dev-secret-1234',
    });

    expect(outcome).toEqual({ status: 'created', email: 'editor.dev@example.com' });

    const editors = await testPrisma.user.findMany({ where: { role: 'EDITOR' } });
    expect(editors).toHaveLength(1);
    expect(editors[0]?.email).toBe('editor.dev@example.com');
  });

  it('chamado sem argumentos / credencial ausente: nenhum EDITOR criado e não lança', async () => {
    const outcome = await seedDevEditor(testPrisma, { email: undefined, password: undefined });

    expect(outcome).toEqual({ status: 'not-configured' });
    expect(await testPrisma.user.count({ where: { role: 'EDITOR' } })).toBe(0);
  });
});
