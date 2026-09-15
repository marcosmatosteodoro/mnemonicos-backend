import { randomUUID } from 'node:crypto';

import { env } from '../../src/config/env';
import { GenerationTimeoutError, NothingToExportError, NotFoundError } from '../../src/http/errors';
import { logger } from '../../src/lib/logger';
import { openMnemonicStrip } from '../../src/modules/tira/tira.service';
// Namespace (não named import): espiar `buildSummaryPdf`/`buildStripPdf` exige o objeto
// de módulo para `jest.spyOn` — mesmo padrão de `tira.service.integration.test.ts`
// (`productionEventsService`), já que `publication.service.ts` consome por named import
// (CommonJS: named import vira acesso de propriedade a cada chamada).
import * as pdfComposer from '../../src/modules/publication/pdf-composer';
import type { StripFrameForPdf } from '../../src/modules/publication/pdf-composer';
import { exportPublication } from '../../src/modules/publication/publication.service';
import * as visualAssociationsService from '../../src/modules/visual-associations/visual-associations.service';
import { buildValidPngNxN } from '../support/png-fixtures';
import {
  createRawContent,
  createTopic,
  createUser,
  seedRuleBreakdown,
} from '../support/production-events-fixtures';
import {
  actorOf,
  createVisualAssociation as seedVisualAssociation,
  PNG_FIXTURE_BUFFER,
  WEBP_FIXTURE_BUFFER,
} from '../support/visual-association-fixtures';
import { closeTestDb, resetDb, testPrisma } from './db';

/**
 * `publication.service.ts` — `exportPublication` (COMP-025-005 / TASK-025-008) sobre o
 * Postgres real (molde `tira.service.integration.test.ts`): guarda nova de alcance
 * (DEC-025-007), leitura de baixo nível da Quebra/Tira, composição sob teto de duração
 * (DEC-025-002), gravação transacional do evento genérico + log dedicado (DEC-025-005),
 * fail-secure. Reusa as fixtures compartilhadas de `production-events-fixtures.ts` e
 * `visual-association-fixtures.ts` (`actorOf`, `PNG_FIXTURE_BUFFER`,
 * `WEBP_FIXTURE_BUFFER`) — não recria fixture equivalente.
 */

/** Captura o erro de uma chamada que deve rejeitar — evita duplicar a chamada real. */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('esperava rejeição, mas a chamada resolveu');
}

async function countEventsFor(rawContentId: string): Promise<{
  productionStageEvents: number;
  publicationEvents: number;
}> {
  const [productionStageEvents, publicationEvents] = await Promise.all([
    testPrisma.productionStageEvent.count({ where: { rawContentId, stageType: 'PUBLICACAO_PDF' } }),
    testPrisma.publicationEvent.count({ where: { rawContentId } }),
  ]);
  return { productionStageEvents, publicationEvents };
}

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await closeTestDb();
});

describe('exportPublication — recusa sem Quebra da regra salva, em qualquer Variante (AC-024-001, FR-024-002)', () => {
  it.each(['RESUMO', 'TIRA'] as const)(
    'Variante %s: NotFoundError "Quebra da regra não encontrada."; nenhum Buffer, nenhum evento gravado',
    async (variant) => {
      const editor = await createUser('EDITOR');
      const topicId = await createTopic();
      const rawContent = await createRawContent(editor.id, topicId);

      const err = await captureError(() =>
        exportPublication(rawContent.id, { variant }, actorOf(editor), testPrisma),
      );
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe('Quebra da regra não encontrada.');

      const counts = await countEventsFor(rawContent.id);
      expect(counts).toEqual({ productionStageEvents: 0, publicationEvents: 0 });
    },
  );
});

describe('exportPublication — Variante TIRA gera a Tira automaticamente quando ainda não aberta (AC-024-004, FR-024-006)', () => {
  it('Quebra salva, Tira ainda não aberta: exportPublication gera a Tira e devolve um Buffer não-vazio, sem recusar', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    const stripCountBefore = await testPrisma.mnemonicStrip.count();
    expect(stripCountBefore).toBe(0);

    const result = await exportPublication(
      rawContent.id,
      { variant: 'TIRA' },
      actorOf(editor),
      testPrisma,
    );

    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.filename).toBe(`${rawContent.id}-tira-rascunho.pdf`);

    const stripCountAfter = await testPrisma.mnemonicStrip.count();
    expect(stripCountAfter).toBe(1);
  });

  it('cabeamento de suppressOpeningEvent:true — a auto-geração NÃO emite ABERTURA; a 1ª reabertura SEGUINTE (histórico vazio) emite; remover a flag em produção deixa este teste vermelho', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    await exportPublication(rawContent.id, { variant: 'TIRA' }, actorOf(editor), testPrisma);

    // (a) `exportPublication` gerou a Tira automaticamente — com `suppressOpeningEvent:
    // true` cabeado de fato, 0 eventos TIRA_MNEMONICA existem ainda (a ABERTURA fica
    // pendente para a 1ª interação humana subsequente, FR-024-013/DEC-025-003). Se a
    // flag fosse removida da chamada em `publication.service.ts`, `openMnemonicStrip`
    // emitiria ABERTURA na própria criação e este count já seria 1 aqui.
    const openingEventsAfterExport = await testPrisma.productionStageEvent.count({
      where: { rawContentId: rawContent.id, stageType: 'TIRA_MNEMONICA' },
    });
    expect(openingEventsAfterExport).toBe(0);

    // (b) 1ª interação humana subsequente (simulada por uma reabertura SEM a flag,
    // mesmo caminho de `tira.routes.ts`) — histórico vazio confirma ABERTURA agora
    // (COMP-025-007). Prova que a supressão em (a) não é permanente nem foi um no-op:
    // o evento estava genuinamente pendente, não perdido.
    await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    const openingEventsAfterReopen = await testPrisma.productionStageEvent.count({
      where: { rawContentId: rawContent.id, stageType: 'TIRA_MNEMONICA' },
    });
    expect(openingEventsAfterReopen).toBe(1);
  });
});

describe('exportPublication — Variante TIRA mapeia binário real para StripFrameForPdf.image (AC-024-003, Passo 4)', () => {
  it('Quadro PNG chega a buildStripPdf com image:{buffer,format:"PNG"}; Quadro WEBP e Quadro sem vínculo chegam com image:null; getVisualAssociationBinary só é chamada para os 2 vinculados', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const strip = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(strip.frames.length).toBeGreaterThanOrEqual(3);

    const pngAssociation = await seedVisualAssociation(editor.id, {
      imageData: PNG_FIXTURE_BUFFER,
      mimeType: 'image/png',
    });
    const webpAssociation = await seedVisualAssociation(editor.id, {
      imageData: WEBP_FIXTURE_BUFFER,
      mimeType: 'image/webp',
    });
    await testPrisma.mnemonicFrame.update({
      where: { id: strip.frames[0]!.id },
      data: { visualAssociationId: pngAssociation.id },
    });
    await testPrisma.mnemonicFrame.update({
      where: { id: strip.frames[1]!.id },
      data: { visualAssociationId: webpAssociation.id },
    });
    // strip.frames[2] permanece sem vínculo.

    let capturedFrames: StripFrameForPdf[] | undefined;
    jest.spyOn(pdfComposer, 'buildStripPdf').mockImplementation((frames) => {
      capturedFrames = [...frames];
      return Promise.resolve(Buffer.from('pdf-fake'));
    });
    const getBinarySpy = jest.spyOn(visualAssociationsService, 'getVisualAssociationBinary');

    const result = await exportPublication(
      rawContent.id,
      { variant: 'TIRA' },
      actorOf(editor),
      testPrisma,
    );
    expect(result.buffer.toString()).toBe('pdf-fake');

    expect(capturedFrames).toBeDefined();
    const frames = capturedFrames!;
    expect(frames[0]?.image?.format).toBe('PNG');
    expect(Buffer.compare(frames[0]!.image!.buffer, PNG_FIXTURE_BUFFER)).toBe(0);
    expect(frames[1]?.image).toBeNull();
    expect(frames[2]?.image).toBeNull();

    // Mutante-alvo (AC-024-003): remover a checagem `format === 'WEBP'` deixaria o
    // buffer WEBP passar adiante — este teste reprovaria em `frames[1]?.image`.
    expect(getBinarySpy).toHaveBeenCalledTimes(2);
  });
});

describe('exportPublication — Variante TIRA loga (nunca lança) a recusa de imagem de buildStripPdf (achado de segurança, TASK-025-007, Passo 4)', () => {
  it('logger.warn é chamado exatamente 1 vez por Quadro recusado, com rawContentId/frameIndex/format/reason; sem buffer nem texto do Quadro no payload', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const strip = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);

    // `PNG_FIXTURE_BUFFER` tem assinatura PNG válida mas estrutura truncada (sem
    // IDAT/IEND) — `readImageDimensions` recusa por 'decode-failed' (mesmo mecanismo já
    // provado em `pdf-composer.integration.test.ts`/TASK-025-007), sem precisar mockar o
    // motor de composição.
    const association = await seedVisualAssociation(editor.id, {
      imageData: PNG_FIXTURE_BUFFER,
      mimeType: 'image/png',
    });
    await testPrisma.mnemonicFrame.update({
      where: { id: strip.frames[0]!.id },
      data: { visualAssociationId: association.id },
    });

    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await exportPublication(
      rawContent.id,
      { variant: 'TIRA' },
      actorOf(editor),
      testPrisma,
    );
    expect(result.buffer.length).toBeGreaterThan(0);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = warnSpy.mock.calls[0]!;
    expect(message).toBe('Imagem de Quadro descartada da exportação');
    expect(payload).toEqual({
      rawContentId: rawContent.id,
      frameIndex: 0,
      format: 'PNG',
      reason: 'decode-failed',
    });

    const serializedPayload = JSON.stringify(payload);
    expect(serializedPayload).not.toContain(strip.frames[0]!.text);
    expect(serializedPayload.toLowerCase()).not.toContain('buffer');
  });
});

describe('exportPublication — falha do motor de composição propaga e não grava nada (AC-024-008, FR-024-009)', () => {
  it('buildSummaryPdf rejeitando (Variante RESUMO): a exceção propaga, nenhum Buffer, nenhum evento gravado', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    jest
      .spyOn(pdfComposer, 'buildSummaryPdf')
      .mockRejectedValueOnce(new Error('falha simulada no motor de composição'));

    const err = await captureError(() =>
      exportPublication(rawContent.id, { variant: 'RESUMO' }, actorOf(editor), testPrisma),
    );
    expect((err as Error).message).toBe('falha simulada no motor de composição');

    const counts = await countEventsFor(rawContent.id);
    expect(counts).toEqual({ productionStageEvents: 0, publicationEvents: 0 });
  });

  it('buildStripPdf rejeitando (Variante TIRA): a exceção propaga, nenhum Buffer, nenhum evento gravado', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    jest
      .spyOn(pdfComposer, 'buildStripPdf')
      .mockRejectedValueOnce(new Error('falha simulada no motor de composição'));

    const err = await captureError(() =>
      exportPublication(rawContent.id, { variant: 'TIRA' }, actorOf(editor), testPrisma),
    );
    expect((err as Error).message).toBe('falha simulada no motor de composição');

    const counts = await countEventsFor(rawContent.id);
    expect(counts).toEqual({ productionStageEvents: 0, publicationEvents: 0 });
  });
});

describe('exportPublication — sucesso grava 1 evento genérico + 1 log dedicado por Variante (AC-024-012, FR-024-010)', () => {
  it('productionStageEvent grava 1 linha PUBLICACAO_PDF e publicationEvent grava 1 linha com a Variante correta, por rawContentId — apurável por GROUP BY variant', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();

    const rawContentResumo = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentResumo.id);
    const rawContentTira = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContentTira.id);

    await exportPublication(
      rawContentResumo.id,
      { variant: 'RESUMO' },
      actorOf(editor),
      testPrisma,
    );
    await exportPublication(rawContentTira.id, { variant: 'TIRA' }, actorOf(editor), testPrisma);

    const countsResumo = await countEventsFor(rawContentResumo.id);
    expect(countsResumo).toEqual({ productionStageEvents: 1, publicationEvents: 1 });
    const countsTira = await countEventsFor(rawContentTira.id);
    expect(countsTira).toEqual({ productionStageEvents: 1, publicationEvents: 1 });

    const grouped = await testPrisma.publicationEvent.groupBy({
      by: ['variant'],
      _count: { _all: true },
      where: { rawContentId: { in: [rawContentResumo.id, rawContentTira.id] } },
    });
    const byVariant = Object.fromEntries(grouped.map((row) => [row.variant, row._count._all]));
    expect(byVariant).toEqual({ RESUMO: 1, TIRA: 1 });

    const resumoEvent = await testPrisma.publicationEvent.findFirstOrThrow({
      where: { rawContentId: rawContentResumo.id },
    });
    expect(resumoEvent.variant).toBe('RESUMO');
    const tiraEvent = await testPrisma.publicationEvent.findFirstOrThrow({
      where: { rawContentId: rawContentTira.id },
    });
    expect(tiraEvent.variant).toBe('TIRA');
  });
});

describe('exportPublication — 2 chamadas sucessivas geram o documento do ZERO, sem reusar cópia persistida (AC-024-013, FR-024-011)', () => {
  it('2 exportações RESUMO sucessivas para o MESMO rawContentId: buildSummaryPdf roda 2×, publicationEvent acumula 2 linhas, nenhuma tabela nova além de productionStageEvent/publicationEvent é escrita', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);

    const buildSpy = jest.spyOn(pdfComposer, 'buildSummaryPdf');

    await exportPublication(rawContent.id, { variant: 'RESUMO' }, actorOf(editor), testPrisma);
    await exportPublication(rawContent.id, { variant: 'RESUMO' }, actorOf(editor), testPrisma);

    expect(buildSpy).toHaveBeenCalledTimes(2);

    const counts = await countEventsFor(rawContent.id);
    expect(counts).toEqual({ productionStageEvents: 2, publicationEvents: 2 });

    // Variante RESUMO não toca a Tira — isola a propriedade "sem cache" sem a
    // complicação de a 1ª chamada de TIRA também escrever MnemonicStrip/MnemonicFrame.
    const stripCount = await testPrisma.mnemonicStrip.count();
    expect(stripCount).toBe(0);

    const transitions = (
      await testPrisma.productionStageEvent.findMany({
        where: { rawContentId: rawContent.id, stageType: 'PUBLICACAO_PDF' },
        orderBy: { sequence: 'asc' },
        select: { transitionType: true },
      })
    ).map((event) => event.transitionType);
    expect(transitions).toEqual(['ABERTURA', 'CONCLUSAO']);
  });
});

describe('exportPublication — Variante TIRA recusa exportar uma Tira sem Quadros (aceitação PLAN-025, BRIEF-024 R-1)', () => {
  it('Tira aberta e depois esvaziada (0 Quadros): NothingToExportError (409, NOTHING_TO_EXPORT); nenhum Buffer, nenhum evento gravado; buildStripPdf nunca chamada', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const strip = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    expect(strip.frames.length).toBeGreaterThan(0);

    // Esvazia a Tira já aberta — único jeito de uma Tira chegar a 0 Quadros: a geração
    // inicial (`buildInitialFrames`) sempre produz >=3 Quadros porque `concept`/`action`/
    // `object` são obrigatórios no schema da Quebra da regra.
    await testPrisma.mnemonicFrame.deleteMany({ where: { stripId: strip.id } });

    const buildStripPdfSpy = jest.spyOn(pdfComposer, 'buildStripPdf');

    const err = await captureError(() =>
      exportPublication(rawContent.id, { variant: 'TIRA' }, actorOf(editor), testPrisma),
    );
    expect(err).toBeInstanceOf(NothingToExportError);
    expect((err as NothingToExportError).statusCode).toBe(409);
    expect((err as NothingToExportError).code).toBe('NOTHING_TO_EXPORT');
    expect(buildStripPdfSpy).not.toHaveBeenCalled();

    const counts = await countEventsFor(rawContent.id);
    expect(counts).toEqual({ productionStageEvents: 0, publicationEvents: 0 });
  });

  it('MESMO cenário (Tira esvaziada): Variante RESUMO continua funcionando normalmente — a recusa é só de TIRA', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const strip = await openMnemonicStrip(rawContent.id, actorOf(editor), testPrisma);
    await testPrisma.mnemonicFrame.deleteMany({ where: { stripId: strip.id } });

    const result = await exportPublication(
      rawContent.id,
      { variant: 'RESUMO' },
      actorOf(editor),
      testPrisma,
    );

    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.filename).toBe(`${rawContent.id}-resumo-rascunho.pdf`);
  });
});

describe('exportPublication — teto de duração interno (AC-024-017, FR-024-015, DEC-025-002)', () => {
  afterEach(() => {
    env.PUBLICATION_PDF_TIMEOUT_MS = 12000;
  });

  /**
   * Um mock de "composição lenta" baseado em `setTimeout` NÃO prova esta garantia —
   * `setTimeout` devolve o event loop, então o timer de `withDeadline` sempre dispara na
   * hora certa mesmo que o caminho REAL (decode/encode síncrono de imagem em
   * `buildStripPdf`, `pdf-composer.ts`) trave o loop inteiro e nunca deixe a fila de
   * timers ser alcançada. Este teste usa Quadros REAIS com imagem PNG REAL
   * (`buildValidPngNxN`, genuinamente decodificável, não a assinatura mínima de
   * `PNG_FIXTURE_BUFFER`) grande o bastante para o `embedPng` síncrono do `pdf-lib`
   * consumir bem mais que o teto de teste — exercitando o caminho de CPU de verdade, não
   * um timer disfarçado.
   */
  it('composição TIRA com Quadros reais/imagem real (CPU-bound): rejeita com GenerationTimeoutError PERTO do teto configurado — não só depois que a composição inteira termina', async () => {
    const editor = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editor.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    const actor = actorOf(editor);

    // Abre a Tira (5 Quadros — 1 por Bloco não-vazio de `seedRuleBreakdown`) e vincula
    // TODOS a uma Associação visual com imagem REAL grande (1500×1500, bem abaixo do
    // teto de pixels de 20_000_000) — medido como suficiente para travar o event loop
    // por >1s de decode/encode síncrono (ver `buildValidPngNxN`).
    const strip = await openMnemonicStrip(rawContent.id, actor, testPrisma);
    const realPng = buildValidPngNxN(1500, 1500);
    for (const frame of strip.frames) {
      const association = await seedVisualAssociation(editor.id, { imageData: realPng });
      await testPrisma.mnemonicFrame.update({
        where: { id: frame.id },
        data: { visualAssociationId: association.id },
      });
    }

    // 400ms: acima do I/O de banco medido ANTES da composição em si (~150-370ms:
    // `assertRawContentExportable` + `ruleBreakdown.findUnique` + `mnemonicStrip.findUnique`
    // + 5× `getVisualAssociationBinary` em paralelo) — não pode ser tão curto a ponto do
    // teto disparar durante o I/O real (que é assíncrono de verdade, sem bug nenhum) — e
    // bem abaixo dos ~1.9s medidos de trabalho SÍNCRONO de `buildStripPdf` sozinho para
    // estes 5 Quadros, que é o alvo real desta prova.
    env.PUBLICATION_PDF_TIMEOUT_MS = 400;
    const callStart = Date.now();
    const err = await captureError(() =>
      exportPublication(rawContent.id, { variant: 'TIRA' }, actor, testPrisma),
    );
    const rejectionElapsedMs = Date.now() - callStart;

    expect(err).toBeInstanceOf(GenerationTimeoutError);
    expect((err as GenerationTimeoutError).statusCode).toBe(503);
    expect((err as GenerationTimeoutError).code).toBe('GENERATION_TIMEOUT');
    // 1500ms: I/O prévio medido (~150-370ms) + teto configurado (400ms) + até 1 Quadro
    // inteiro de decode caso o teto vença DURANTE o processamento de um Quadro (~450ms
    // medido, já que `buildStripPdf` só cede o event loop ENTRE Quadros, nunca dentro do
    // decode de uma imagem) ≈ 1.2s, com folga para variância de CI. Se `buildStripPdf`
    // parar de ceder o event loop por Quadro, o laço inteiro volta a drenar de uma vez
    // só e a rejeição só chega depois da composição completa (~1.9-2.3s medido, para
    // estes mesmos 5 Quadros/1500×1500px) — bem acima deste bound, o que reprova o teste.
    expect(rejectionElapsedMs).toBeLessThan(1500);

    const counts = await countEventsFor(rawContent.id);
    expect(counts).toEqual({ productionStageEvents: 0, publicationEvents: 0 });
  }, 15000);
});

describe('exportPublication — alcance comum a EDITOR/ADMIN para LEITURA de material já existente (AC-024-018, NFR-024-003, DEC-025-007)', () => {
  it('EDITOR B exporta "resumo" de Conteúdo bruto JÁ com Quebra salva de EDITOR A: permite normalmente', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContentOfA.id);

    const result = await exportPublication(
      rawContentOfA.id,
      { variant: 'RESUMO' },
      actorOf(editorB),
      testPrisma,
    );
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('EDITOR B exporta "tira" de Conteúdo bruto de EDITOR A cuja Tira JÁ está aberta (histórico não-vazio): permite normalmente', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContentOfA = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContentOfA.id);
    // A abre a Tira primeiro — histórico não-vazio (ABERTURA já emitida).
    await openMnemonicStrip(rawContentOfA.id, actorOf(editorA), testPrisma);

    const result = await exportPublication(
      rawContentOfA.id,
      { variant: 'TIRA' },
      actorOf(editorB),
      testPrisma,
    );
    expect(result.buffer.length).toBeGreaterThan(0);

    // A auto-geração (`openMnemonicStrip`) nunca foi chamada para B — o vínculo é lido
    // de baixo nível, sem herdar a guarda de autoria dela (só é possível verificar aqui
    // por efeito observável: nenhuma 2ª MnemonicStrip foi criada).
    const stripCount = await testPrisma.mnemonicStrip.count();
    expect(stripCount).toBe(1);
  });
});

describe('exportPublication — precedência de guarda: soft-delete recusa com a MESMA mensagem de "não encontrado", qualquer que seja o autor (AC-024-019, NFR-024-003)', () => {
  it('(a) soft-deleted, exportado pelo próprio autor; (b) soft-deleted E de outro autor ao mesmo tempo — as 2 mensagens são idênticas, e idênticas às de um id inexistente', async () => {
    const editorA = await createUser('EDITOR');
    const editorB = await createUser('EDITOR');
    const topicId = await createTopic();
    const rawContent = await createRawContent(editorA.id, topicId);
    await seedRuleBreakdown(rawContent.id);
    await testPrisma.rawContent.update({
      where: { id: rawContent.id },
      data: { deletedAt: new Date() },
    });

    const errorForOwner = await captureError(() =>
      exportPublication(rawContent.id, { variant: 'RESUMO' }, actorOf(editorA), testPrisma),
    );
    const errorForOtherAuthor = await captureError(() =>
      exportPublication(rawContent.id, { variant: 'RESUMO' }, actorOf(editorB), testPrisma),
    );
    const errorForRandomId = await captureError(() =>
      exportPublication(randomUUID(), { variant: 'RESUMO' }, actorOf(editorB), testPrisma),
    );

    expect(errorForOwner).toBeInstanceOf(NotFoundError);
    expect(errorForOtherAuthor).toBeInstanceOf(NotFoundError);
    expect(errorForRandomId).toBeInstanceOf(NotFoundError);

    const messageForOwner = (errorForOwner as NotFoundError).message;
    const messageForOtherAuthor = (errorForOtherAuthor as NotFoundError).message;
    const messageForRandomId = (errorForRandomId as NotFoundError).message;

    // Mutante-alvo (AC-024-019): reordenar a guarda de alcance para depois da guarda de
    // soft-delete faria o par (b) vazar um oráculo distinto — as 3 mensagens têm de ser
    // literalmente a mesma.
    expect(messageForOwner).toBe('Conteúdo bruto não encontrado.');
    expect(messageForOtherAuthor).toBe('Conteúdo bruto não encontrado.');
    expect(messageForRandomId).toBe('Conteúdo bruto não encontrado.');
  });
});

describe('exportPublication — filename segue o formato exato ${rawContentId}-${variant}-rascunho.pdf (A-024-007)', () => {
  it.each([['RESUMO', 'resumo'] as const, ['TIRA', 'tira'] as const])(
    'Variante %s: filename = `${rawContentId}-%s-rascunho.pdf`',
    async (variant, suffix) => {
      const editor = await createUser('EDITOR');
      const topicId = await createTopic();
      const rawContent = await createRawContent(editor.id, topicId);
      await seedRuleBreakdown(rawContent.id);

      const result = await exportPublication(
        rawContent.id,
        { variant },
        actorOf(editor),
        testPrisma,
      );

      expect(result.filename).toBe(`${rawContent.id}-${suffix}-rascunho.pdf`);
    },
  );
});
