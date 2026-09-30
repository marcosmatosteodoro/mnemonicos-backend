import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Rede de paridade cross-repo das interfaces do Conteúdo bruto / Quebra da
 * regra. Análoga a `domain-types-parity.test.ts`, mas para as interfaces de
 * `contents.service.ts` (backend) × `src/types/domain.ts` (frontend): lê os
 * dois arquivos como texto e prova que os NOMES e a FORMA dos campos são
 * idênticos dos dois lados — não um fixture que se autoconfirma a partir de
 * um dos lados (um fixture montado a partir do próprio tipo do frontend não
 * acusaria uma interface renomeada ou um campo fantasma no outro lado).
 *
 * Nomes canônicos (backend vence — a fonte real do dado):
 *   - `RawContentSummary`: `rawText`/`hasRuleBreakdown` (o texto nunca é
 *     truncado nesta fatia).
 *   - `RuleBreakdown`: só os campos de conteúdo — `RuleBreakdownDetail`
 *     (backend) nunca devolve `id`/`rawContentId`/`createdAt`/`updatedAt`.
 *   - `RawContent`: sem `deletedAt` — `RAW_CONTENT_DETAIL_SELECT` nunca o
 *     projeta.
 * `condition`/`exception` aceitando `null` é comportamento de parse, fixado
 * em `contents.schema.test.ts` — comparação de forma de interface não alcança.
 *
 * Repos symlinkados no workspace (mesmo padrão de `domain-types-parity.test.ts`):
 * o arquivo do frontend é lido pelo caminho relativo a partir daqui.
 */
const BACKEND_SERVICE = resolve(__dirname, '../../src/modules/contents/contents.service.ts');
const BACKEND_DOMAIN_TYPES = resolve(__dirname, '../../src/domain/types.ts');
const BACKEND_CONTRASTS_SERVICE = resolve(
  __dirname,
  '../../src/modules/contrasts/contrasts.service.ts',
);
const BACKEND_FLASHCARDS_SERVICE = resolve(
  __dirname,
  '../../src/modules/flashcards/flashcards.service.ts',
);
const BACKEND_CONTENT_VERSIONS_SERVICE = resolve(
  __dirname,
  '../../src/modules/content-versions/content-versions.service.ts',
);
const FRONTEND_TYPES = resolve(__dirname, '../../../mnemonicos-frontend/src/types/domain.ts');

function readSourceFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `arquivo não encontrado: ${path}\n` +
        'checkout irmão mnemonicos-frontend ausente — este teste de paridade ' +
        'exige os dois repos no workspace.',
    );
  }
  return readFileSync(path, 'utf8');
}

/**
 * Extrai os nomes de campo de uma interface TypeScript pela leitura textual
 * do arquivo (sem AST) — mesmo mecanismo de `extractSessionUserFields` em
 * `domain-types-parity.test.ts`, generalizado para qualquer interface.
 * Assume corpo sem chave `{`/`}` aninhada (as interfaces comparadas aqui são
 * flat — nenhum campo com tipo objeto inline).
 */
function extractInterfaceFields(source: string, interfaceName: string): string[] {
  const pattern = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`);
  const match = pattern.exec(source);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`declaração de interface ${interfaceName} não encontrada`);
  }
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*'))
    .map((line) => /^(\w+)\??\s*:/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

describe('paridade cross-repo — RawContentSummary/RuleBreakdown/RawContent', () => {
  const backendSource = readSourceFile(BACKEND_SERVICE);
  const frontendSource = readSourceFile(FRONTEND_TYPES);

  it('RawContentSummary: mesmo conjunto de campos nos dois repositórios (rawText/hasRuleBreakdown, não rawTextExcerpt/hasBreakdown)', () => {
    const backendFields = extractInterfaceFields(backendSource, 'RawContentSummary').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'RawContentSummary').sort();

    expect(backendFields).toEqual(
      [
        'id',
        'rawText',
        'disciplineName',
        'topicName',
        'radarClass',
        'sourceCitation',
        'hasRuleBreakdown',
      ].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: reverter o frontend para `rawTextExcerpt`/`hasBreakdown` (ou o
    // backend para outro nome) faz esta comparação reprovar.
    expect(frontendFields).not.toContain('rawTextExcerpt');
    expect(frontendFields).not.toContain('hasBreakdown');
  });

  it('RuleBreakdown/RuleBreakdownDetail: só os 6 campos de conteúdo — sem id/rawContentId/createdAt/updatedAt fantasma no frontend', () => {
    const backendFields = extractInterfaceFields(backendSource, 'RuleBreakdownDetail').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'RuleBreakdown').sort();

    expect(backendFields).toEqual(
      ['concept', 'action', 'object', 'condition', 'exception', 'essence'].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: reintroduzir qualquer um dos 4 campos fantasma no frontend
    // (sem o backend também passar a projetá-los) faz esta comparação reprovar.
    for (const phantom of ['id', 'rawContentId', 'createdAt', 'updatedAt']) {
      expect(frontendFields).not.toContain(phantom);
    }
  });

  it('RawContentDetail/RawContent: mesmo conjunto de campos — deletedAt ausente dos dois lados (nunca projetado pelo select); pegadinhaText presente nos dois (TASK-027-005)', () => {
    const backendFields = extractInterfaceFields(backendSource, 'RawContentDetail').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'RawContent').sort();

    expect(backendFields).toEqual(frontendFields);
    // Mutante: reintroduzir `deletedAt` só no frontend (sem o backend passar
    // a projetá-lo no `select`) faz esta comparação reprovar.
    expect(frontendFields).not.toContain('deletedAt');
    // Mutante inverso (TASK-027-005): comparar só os dois arrays entre si não
    // pega o caso em que ambos perderam `pegadinhaText` ao mesmo tempo — a
    // asserção literal abaixo exige que o campo conste da comparação de fato.
    expect(backendFields).toContain('pegadinhaText');
    expect(frontendFields).toContain('pegadinhaText');
  });
});

describe('paridade cross-repo — Contrast (TASK-027-003)', () => {
  // `domain/types.ts::Contrast` é o espelho do model Prisma nos dois repos
  // (PLAN-027 §5) — mas o CONTRATO DE REDE (o que a rota HTTP de fato devolve)
  // é `ContrastDetail` (contrasts.service.ts:48-56, projetado por
  // `CONTRAST_DETAIL_SELECT`, linhas 38-46). Por isso este bloco compara os
  // DOIS: `Contrast` (espelho do model) contra o frontend, e `ContrastDetail`
  // (payload HTTP) contra o frontend — mesma forma dos 3 blocos acima, que
  // sempre comparam o tipo de PAYLOAD do backend (`RawContentSummary`/
  // `RuleBreakdownDetail`/`RawContentDetail`, todos de `contents.service.ts`)
  // contra o frontend.
  const backendDomainSource = readSourceFile(BACKEND_DOMAIN_TYPES);
  const backendContrastsServiceSource = readSourceFile(BACKEND_CONTRASTS_SERVICE);
  const frontendSource = readSourceFile(FRONTEND_TYPES);

  it('Contrast: exatamente id/rawContentId/authorId/confusableText/distinctionText/createdAt/updatedAt, nos dois lados', () => {
    const backendFields = extractInterfaceFields(backendDomainSource, 'Contrast').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'Contrast').sort();

    expect(backendFields).toEqual(
      [
        'id',
        'rawContentId',
        'authorId',
        'confusableText',
        'distinctionText',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: renomear `confusableText`/`distinctionText` só de um lado (ex.:
    // `confusable`/`distinction`) faz esta comparação reprovar.
    expect(frontendFields).not.toContain('confusable');
    expect(frontendFields).not.toContain('distinction');
  });

  it('ContrastDetail (payload HTTP real, contrasts.service.ts): mesmo conjunto de campos que o Contrast do frontend', () => {
    const backendPayloadFields = extractInterfaceFields(
      backendContrastsServiceSource,
      'ContrastDetail',
    ).sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'Contrast').sort();

    expect(backendPayloadFields).toEqual(frontendFields);
    // Esta comparação cobre a DECLARAÇÃO da interface `ContrastDetail`, nunca
    // a projeção real de `CONTRAST_DETAIL_SELECT` — mutar o `select` (remover
    // ou acrescentar campo) sem tocar a interface deixa este teste verde
    // (comprovado por execução, gate 7 rodada 2, Wave 2 de PLAN-027). Prova de
    // forma do corpo HTTP de sucesso é pendência separada (ver INDEX do slug).
    expect(backendPayloadFields).toEqual(
      [
        'id',
        'rawContentId',
        'authorId',
        'confusableText',
        'distinctionText',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });
});

describe('paridade cross-repo — ProductionFlashcard (TASK-027-004)', () => {
  // `domain/types.ts::ProductionFlashcard` é o espelho do model Prisma nos
  // dois repos (PLAN-027 §5) — mas o CONTRATO DE REDE (o que a rota HTTP de
  // fato devolve) é `FlashcardDetail` (flashcards.service.ts, projetado por
  // `FLASHCARD_DETAIL_SELECT`), mesma forma do bloco `Contrast` acima. Por
  // isso este bloco compara os DOIS: o espelho do model contra o frontend, e
  // o payload HTTP contra o frontend.
  const backendDomainSource = readSourceFile(BACKEND_DOMAIN_TYPES);
  const backendFlashcardsServiceSource = readSourceFile(BACKEND_FLASHCARDS_SERVICE);
  const frontendSource = readSourceFile(FRONTEND_TYPES);

  it('ProductionFlashcard: exatamente id/rawContentId/authorId/question/answer/createdAt/updatedAt, nos dois lados — nunca "Flashcard" (DEC-027-003)', () => {
    const backendFields = extractInterfaceFields(backendDomainSource, 'ProductionFlashcard').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ProductionFlashcard').sort();

    expect(backendFields).toEqual(
      ['id', 'rawContentId', 'authorId', 'question', 'answer', 'createdAt', 'updatedAt'].sort(),
    );
    expect(frontendFields).toEqual(backendFields);

    // Mutante: confundir `ProductionFlashcard` com o Flashcard legado (campos
    // `front`/`back`/`mnemonicId`/`topicId`, interface `Flashcard` já
    // existente no frontend, F2) faz esta comparação reprovar — os dois
    // conceitos usam o mesmo substantivo de produto mas nomes/campos
    // distintos (DEC-027-003).
    expect(frontendFields).not.toContain('front');
    expect(frontendFields).not.toContain('back');
    expect(frontendFields).not.toContain('mnemonicId');
  });

  it('FlashcardDetail (payload HTTP real, flashcards.service.ts): mesmo conjunto de campos que o ProductionFlashcard do frontend', () => {
    const backendPayloadFields = extractInterfaceFields(
      backendFlashcardsServiceSource,
      'FlashcardDetail',
    ).sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ProductionFlashcard').sort();

    expect(backendPayloadFields).toEqual(frontendFields);
    // Esta comparação cobre a DECLARAÇÃO da interface `FlashcardDetail`, nunca
    // a projeção real de `FLASHCARD_DETAIL_SELECT` — mesma pendência já
    // registrada para `ContrastDetail` (ver bloco acima / INDEX do slug).
    expect(backendPayloadFields).toEqual(
      ['id', 'rawContentId', 'authorId', 'question', 'answer', 'createdAt', 'updatedAt'].sort(),
    );
  });
});

describe('paridade cross-repo — ContentVersion (TASK-029-004)', () => {
  const backendDomainSource = readSourceFile(BACKEND_DOMAIN_TYPES);
  const backendContentVersionsServiceSource = readSourceFile(BACKEND_CONTENT_VERSIONS_SERVICE);
  const frontendSource = readSourceFile(FRONTEND_TYPES);

  it('ContentVersion: exatamente id/rawContentId/number/legislativeClosureDate/authorId/closedAt/approvedById/approvedAt/validApprovalForExport, nos dois lados — sem contentSnapshot fantasma no frontend (DEC-029-003)', () => {
    const backendFields = extractInterfaceFields(backendDomainSource, 'ContentVersion').sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ContentVersion').sort();

    expect(backendFields).toEqual(
      [
        'id',
        'rawContentId',
        'number',
        'legislativeClosureDate',
        'authorId',
        'closedAt',
        'approvedById',
        'approvedAt',
        'validApprovalForExport',
      ].sort(),
    );
    expect(frontendFields).toEqual(backendFields);
    // Mutante: reintroduzir `contentSnapshot` só no frontend (sem o backend
    // também passar a expor o dado interno de verificação, DEC-029-003) faz
    // esta comparação reprovar.
    expect(frontendFields).not.toContain('contentSnapshot');
  });

  it('ContentVersionDetail (payload HTTP real, content-versions.service.ts): mesmo conjunto de campos que o ContentVersion do frontend', () => {
    const backendPayloadFields = extractInterfaceFields(
      backendContentVersionsServiceSource,
      'ContentVersionDetail',
    ).sort();
    const frontendFields = extractInterfaceFields(frontendSource, 'ContentVersion').sort();

    expect(backendPayloadFields).toEqual(frontendFields);
    // Esta comparação cobre a DECLARAÇÃO da interface `ContentVersionDetail`,
    // nunca a projeção real de `CONTENT_VERSION_DETAIL_SELECT` — mesma
    // pendência já registrada para `ContrastDetail`/`FlashcardDetail` (ver
    // blocos acima / INDEX do slug).
    expect(backendPayloadFields).toEqual(
      [
        'id',
        'rawContentId',
        'number',
        'legislativeClosureDate',
        'authorId',
        'closedAt',
        'approvedById',
        'approvedAt',
        'validApprovalForExport',
      ].sort(),
    );
  });
});
