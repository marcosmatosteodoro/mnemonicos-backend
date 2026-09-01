import { closeTestDb, testPrisma } from './db';

/**
 * Prova de estrutura da migração `add_raw_content_and_rule_breakdown`
 * (TASK-006-001 / COMP-006-001) sobre o Postgres descartável `mnemonicos_test`,
 * onde `global-setup.ts` aplica todas as migrações versionadas.
 *
 * Não exercita regra de negócio: confere que o DDL aditivo chegou ao banco com a
 * nullability, os índices e as ações de FK da §5 do PLAN-006 / DEC-006-008, e que
 * `mnemonics` — inclusive `source` — não foi tocada (AC-005-032 / NFR-005-007).
 *
 * O conjunto de colunas de `mnemonics` abaixo foi capturado de
 * `information_schema.columns` contra o banco do commit-pai (antes desta
 * migração); qualquer coluna alterada, removida ou renomeada em `mnemonics`
 * quebra o caso (iv).
 */

type ColumnRow = {
  column_name: string;
  is_nullable: 'YES' | 'NO';
};

const MNEMONICS_COLUMNS_AT_PARENT = [
  'createdAt',
  'decoding',
  'hook',
  'id',
  'source',
  'technique',
  'topicId',
  'updatedAt',
].sort();

async function columnsOf(table: string): Promise<ColumnRow[]> {
  return testPrisma.$queryRaw<ColumnRow[]>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY column_name
  `;
}

async function indexDefsOf(table: string): Promise<string[]> {
  const rows = await testPrisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${table}
  `;
  return rows.map((r) => r.indexdef);
}

afterAll(async () => {
  await closeTestDb();
});

describe('migração add_raw_content_and_rule_breakdown — estrutura no banco', () => {
  it('(i) cria as tabelas raw_contents e rule_breakdowns', async () => {
    const rows = await testPrisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('raw_contents', 'rule_breakdowns')
    `;
    expect(rows.map((r) => r.table_name).sort()).toEqual(['raw_contents', 'rule_breakdowns']);
  });

  it('(ii-a) raw_contents: radarClass NOT NULL; fonte/carimbo/deletedAt NULLABLE', async () => {
    const byName = new Map(
      (await columnsOf('raw_contents')).map((c) => [c.column_name, c.is_nullable]),
    );

    expect(byName.get('radarClass')).toBe('NO');

    for (const nullable of [
      'sourceType',
      'sourceCitation',
      'sourceUrl',
      'lastEditedById',
      'lastEditedAt',
      'deletedAt',
    ]) {
      expect(byName.get(nullable)).toBe('YES');
    }
  });

  it('(ii-b) rule_breakdowns: concept/action/object/essence NOT NULL; condition/exception NULLABLE', async () => {
    const byName = new Map(
      (await columnsOf('rule_breakdowns')).map((c) => [c.column_name, c.is_nullable]),
    );

    for (const notNull of ['concept', 'action', 'object', 'essence']) {
      expect(byName.get(notNull)).toBe('NO');
    }
    for (const nullable of ['condition', 'exception']) {
      expect(byName.get(nullable)).toBe('YES');
    }
  });

  it('(ii-b) rule_breakdowns.rawContentId tem índice UNIQUE (FK 1:1)', async () => {
    const defs = await indexDefsOf('rule_breakdowns');
    expect(defs.some((d) => /CREATE UNIQUE INDEX/i.test(d) && d.includes('"rawContentId"'))).toBe(
      true,
    );
  });

  it('(iii) raw_contents tem índice sobre authorId, topicId e deletedAt', async () => {
    const defs = await indexDefsOf('raw_contents');
    for (const col of ['authorId', 'topicId', 'deletedAt']) {
      expect(defs.some((d) => d.includes(`("${col}")`))).toBe(true);
    }
  });

  it('(DEC-006-008) ações de FK: Restrict em topic/author, SetNull no carimbo, Cascade na quebra', async () => {
    const rows = await testPrisma.$queryRaw<
      Array<{ constraint_name: string; delete_rule: string }>
    >`
      SELECT constraint_name, delete_rule
      FROM information_schema.referential_constraints
      WHERE constraint_schema = 'public'
        AND constraint_name IN (
          'raw_contents_topicId_fkey',
          'raw_contents_authorId_fkey',
          'raw_contents_lastEditedById_fkey',
          'rule_breakdowns_rawContentId_fkey'
        )
    `;
    const rule = new Map(rows.map((r) => [r.constraint_name, r.delete_rule]));

    expect(rule.get('raw_contents_topicId_fkey')).toBe('RESTRICT');
    expect(rule.get('raw_contents_authorId_fkey')).toBe('RESTRICT');
    expect(rule.get('raw_contents_lastEditedById_fkey')).toBe('SET NULL');
    expect(rule.get('rule_breakdowns_rawContentId_fkey')).toBe('CASCADE');
  });

  it('(iv) mnemonics.source segue presente e NULLABLE, e o conjunto de colunas é o do commit-pai', async () => {
    const columns = await columnsOf('mnemonics');
    const source = columns.find((c) => c.column_name === 'source');

    expect(source).toBeDefined();
    expect(source?.is_nullable).toBe('YES');
    expect(columns.map((c) => c.column_name).sort()).toEqual(MNEMONICS_COLUMNS_AT_PARENT);
  });
});
