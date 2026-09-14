import {
  normalizeCategoryKey,
  suggestCategories,
} from '../../src/modules/visual-associations/visual-associations.service';

/**
 * `normalizeCategoryKey`/`suggestCategories` (COMP-023-005 / TASK-023-014) — funções
 * PURAS, sem I/O (perfil §7): `normalizeCategoryKey` é `trim()` + `toLowerCase()`
 * (NFR-022-007); `suggestCategories` filtra por combinação normalizada, devolvendo a
 * grafia original (FR-022-025). Molde de estilo: `production-events.rule.test.ts`
 * (`decideStageTransition`).
 */

describe('normalizeCategoryKey', () => {
  it('trim + case-fold: espaço nas bordas e capitalização não distinguem a chave', () => {
    expect(normalizeCategoryKey(' Tributário ')).toBe(normalizeCategoryKey('tributário'));
    expect(normalizeCategoryKey(' Tributário ')).toBe('tributário');
  });

  it('não altera o texto original — só devolve a chave normalizada, nunca muta a entrada', () => {
    const original = ' Tributário ';
    normalizeCategoryKey(original);
    expect(original).toBe(' Tributário ');
  });

  it('espaçamento interno irregular não é colapsado (gap residual aceito por DEC-023-008)', () => {
    expect(normalizeCategoryKey('tributário  civil')).toBe('tributário  civil');
  });
});

describe('suggestCategories', () => {
  it('FR-022-025: filtra por combinação normalizada, devolvendo a grafia ORIGINAL (nunca a normalizada)', () => {
    expect(suggestCategories(['Tributário', 'Trabalhista'], 'trib')).toEqual(['Tributário']);
  });

  it('combinação é case/trim-insensitive nos dois lados (categoria e query)', () => {
    expect(suggestCategories(['Tributário'], '  TRIB  ')).toEqual(['Tributário']);
    expect(suggestCategories([' tributário '], 'Trib')).toEqual([' tributário ']);
  });

  it('query sem nenhuma combinação → lista vazia', () => {
    expect(suggestCategories(['Tributário', 'Trabalhista'], 'penal')).toEqual([]);
  });

  it('query vazia (string vazia) → lista vazia, NUNCA todas as categorias (decisão do Tech Lead na consolidação)', () => {
    expect(suggestCategories(['Tributário', 'Trabalhista'], '')).toEqual([]);
  });

  it('query só espaço (normaliza para vazia) → lista vazia, mesma regra da query vazia', () => {
    expect(suggestCategories(['Tributário', 'Trabalhista'], '   ')).toEqual([]);
  });

  it('sem duplicatas: grafia exata repetida na entrada aparece uma única vez na saída', () => {
    expect(suggestCategories(['Tributário', 'Tributário', 'Trabalhista'], 'trib')).toEqual([
      'Tributário',
    ]);
  });

  it('lista de categorias vazia → lista vazia, mesmo com query não-vazia', () => {
    expect(suggestCategories([], 'trib')).toEqual([]);
  });

  it('preserva a ordem de PRIMEIRA ocorrência das categorias combinadas', () => {
    expect(suggestCategories(['Trabalhista', 'Tributário', 'Direito Tributário'], 'trib')).toEqual([
      'Tributário',
      'Direito Tributário',
    ]);
  });
});
