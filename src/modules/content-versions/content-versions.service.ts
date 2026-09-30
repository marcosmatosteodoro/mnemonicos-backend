import type { Prisma } from '../../generated/prisma/client';
import { ConflictError, ForbiddenError, NotFoundError } from '../../http/errors';
import { prisma } from '../../lib/prisma';
import { assertRawContentReachable, type ContentActor } from '../contents/contents.service';
import { recordProductionStageEvent } from '../production-events/production-events.service';
import type {
  ApproveContentVersionInput,
  CloseContentVersionInput,
} from './content-versions.schema';
import {
  hasVersionedContentChanged,
  toVersionedContentFields,
  type VersionedContentFields,
} from './versioned-content-diff';

/**
 * Ciclo de vida de Versão editorial (COMP-029-004/005 / TASK-029-002):
 * `closeContentVersion` (escrita de criação, append-only, FR-028-004 —
 * nenhuma função de update/delete SOBRE UMA VERSÃO existe neste módulo;
 * `approveContentVersion`, abaixo, é a única escrita de UPDATE, condicionada
 * a `approvedById: null` e restrita a 2 colunas, DEC-033-009), `listContentVersions`
 * (leitura do histórico completo). Guarda composta de `closeContentVersion`,
 * NESTA ORDEM (DEC-029-004/DEC-029-001, PLAN §6):
 *
 *   1. `tx.$queryRaw` `SELECT ... FOR UPDATE` trava a linha do `RawContent`
 *      pai — 1ª chamada do corpo, ANTES de qualquer decisão (molde
 *      `visual-associations.service.ts` `removeVisualAssociation`). Serializa
 *      fechamentos concorrentes do MESMO `rawContentId` (corrida de
 *      numeração, DEC-029-004).
 *   2. `assertRawContentReachable` (importado de `contents.service.ts`) —
 *      resolve inexistente/fora de alcance/soft-deleted na MESMA ordem e
 *      mensagens já estabelecidas por F2.
 *   3. Checagem explícita `actor.role === 'ADMIN' || rawContent.authorId ===
 *      actor.id` (DEC-029-001) — defesa em profundidade: para EDITOR,
 *      `assertRawContentReachable` já barraria um `rawContentId` de outro
 *      autor; este guard cobre ADMIN sempre passando, e é literal da DEC.
 *   4. `RuleBreakdown` precisa existir (FR-028-003/AC-028-004) — sem ela,
 *      recusa e informa o motivo, sem `INSERT`.
 *   5. Próximo `number` sequencial, dentro da MESMA transação, depois do lock
 *      do passo 1.
 *   6. Monta o `contentSnapshot` via `toVersionedContentFields`
 *      (`versioned-content-diff.ts`) — ALLOWLIST explícita dos campos
 *      versionados lidos nos passos 2/3 (RawContent) e 4 (RuleBreakdown),
 *      NUNCA espalhamento (`...rawContent`/`...ruleBreakdown`): o objeto
 *      inteiro carregaria campos não-versionados (ex.: `pegadinhaText`) para
 *      dentro do snapshot.
 *   7. `tx.contentVersion.create`.
 *   8. `recordProductionStageEvent(tx, { ..., transitionType: 'CONCLUSAO' })`
 *      — ÚLTIMA chamada do corpo, sempre `CONCLUSAO` direto, nunca via
 *      `decideStageTransition` (DEC-029-005).
 *
 * Qualquer falha nos passos 1-8 propaga sem gravar nada (fail-secure,
 * NFR-028-001/002).
 */

const CONTENT_VERSION_DETAIL_SELECT = {
  id: true,
  rawContentId: true,
  number: true,
  legislativeClosureDate: true,
  authorId: true,
  closedAt: true,
  approvedById: true,
  approvedAt: true,
} as const satisfies Prisma.ContentVersionSelect;

export interface ContentVersionDetail {
  id: string;
  rawContentId: string;
  number: number;
  legislativeClosureDate: Date;
  authorId: string;
  closedAt: Date;
  approvedById: string | null;
  approvedAt: Date | null;
  /**
   * Computado (nunca persistido, `contentSnapshot` NUNCA sai deste módulo,
   * COMP-033-005): reflete se a PRÓXIMA Exportação sairia com o carimbo
   * "Versão aprovada" — só é `true` para a Versão vigente, aprovada, sem
   * sinal de alteração aceso (`resolveAlterationSignal`); qualquer Versão
   * superada é `false` incondicionalmente, mesmo tendo sido aprovada no
   * passado (FR-032-006 — a aprovação nunca se propaga).
   */
  validApprovalForExport: boolean;
}

/**
 * Cliente Prisma injetável (mesmo padrão de `ContrastClient`): cobre
 * `contentVersion`, `rawContent` (exigido pelo tipo de `assertRawContentReachable`),
 * `ruleBreakdown` (leitura do par versionado), `$transaction` e
 * `productionStageEvent` (DEC-033-007).
 */
type ContentVersionClient = Pick<
  typeof prisma,
  'contentVersion' | 'rawContent' | 'ruleBreakdown' | 'productionStageEvent' | '$transaction'
>;

/**
 * Campos do `RawContent` lidos na MESMA linha travada no passo 1 (nenhuma 3ª
 * leitura de `RawContent`): os versionados (`rawText`/`radarClass`/
 * `sourceType`/`sourceCitation`/`sourceUrl`, usados para montar o
 * `contentSnapshot`, DEC-029-003) mais `authorId`/`lastEditedById`
 * (segregação de funções, FR-032-004). A guarda de edição pós-fechamento
 * (DEC-033-006 emendada) ordena por `ProductionStageEvent.sequence`, não por
 * `lastEditedAt` — nenhum carimbo de tempo do `RawContent` entra aqui.
 */
const RAW_CONTENT_VERSIONED_SELECT = {
  authorId: true,
  rawText: true,
  radarClass: true,
  sourceType: true,
  sourceCitation: true,
  sourceUrl: true,
  lastEditedById: true,
} as const satisfies Prisma.RawContentSelect;

/** Campos versionados da `RuleBreakdown` (passo 4/6) — os 5 blocos + a síntese. */
const RULE_BREAKDOWN_VERSIONED_SELECT = {
  concept: true,
  action: true,
  object: true,
  condition: true,
  exception: true,
  essence: true,
} as const satisfies Prisma.RuleBreakdownSelect;

/**
 * Fecha uma nova Versão editorial de `rawContentId` (FR-028-001 a 004/007,
 * NFR-028-001/002). Autor do `RawContent` ou ADMIN (DEC-029-001); recusa se o
 * pai estiver inalcançável/soft-deleted (`assertRawContentReachable`) ou sem
 * `RuleBreakdown` salva (FR-028-003).
 */
export async function closeContentVersion(
  rawContentId: string,
  input: CloseContentVersionInput,
  actor: ContentActor,
  db: ContentVersionClient = prisma,
): Promise<ContentVersionDetail> {
  return db.$transaction(async (tx) => {
    // Passo 1 (DEC-029-004): trava a linha do RawContent pai ANTES de
    // qualquer decisão — serializa fechamentos concorrentes do mesmo
    // rawContentId (molde visual-associations.service.ts:340-342).
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM raw_contents WHERE id = ${rawContentId} FOR UPDATE
    `;
    if (locked[0] === undefined) {
      throw new NotFoundError('Conteúdo bruto não encontrado.');
    }

    // Passo 2 (DEC-029-001 herdada): guarda de alcance por autoria.
    await assertRawContentReachable(rawContentId, actor, tx);

    // Passo 3: leitura de detalhe do RawContent — reaproveita a MESMA linha
    // travada no passo 1 (nenhuma 3ª leitura de RawContent).
    const rawContent = await tx.rawContent.findUniqueOrThrow({
      where: { id: rawContentId },
      select: RAW_CONTENT_VERSIONED_SELECT,
    });

    if (actor.role !== 'ADMIN' && rawContent.authorId !== actor.id) {
      throw new ForbiddenError('Você não tem permissão para fechar uma versão deste conteúdo.');
    }

    // Passo 4 (FR-028-003/AC-028-004): a Quebra da regra precisa existir.
    const ruleBreakdown = await tx.ruleBreakdown.findUnique({
      where: { rawContentId },
      select: RULE_BREAKDOWN_VERSIONED_SELECT,
    });
    if (ruleBreakdown === null) {
      throw new NotFoundError('Quebra da regra precisa existir antes do fechamento.');
    }

    // Passo 5 (DEC-029-004): próximo número, dentro da MESMA transação,
    // depois do lock do passo 1.
    const last = await tx.contentVersion.findFirst({
      where: { rawContentId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;

    // Passo 6 (DEC-029-003): allowlist explícita dos campos versionados, via
    // `toVersionedContentFields` — a MESMA função que `publication.service.ts`
    // usa para o lado "atual" da comparação (`versioned-content-diff.ts`,
    // único ponto de manutenção) — NUNCA espalhamento de
    // RawContent/RuleBreakdown (o objeto inteiro carregaria campos
    // não-versionados, ex. pegadinhaText, para dentro do snapshot).
    const contentSnapshot = toVersionedContentFields(rawContent, ruleBreakdown);

    const created = await tx.contentVersion.create({
      data: {
        rawContentId,
        number,
        legislativeClosureDate: new Date(input.legislativeClosureDate),
        authorId: actor.id,
        contentSnapshot,
      },
      select: CONTENT_VERSION_DETAIL_SELECT,
    });

    // Passo 8 (DEC-029-005): sempre CONCLUSAO direto, nunca via
    // decideStageTransition — ÚLTIMA chamada do corpo.
    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'VERSAO_EDITORIAL',
      transitionType: 'CONCLUSAO',
      actorId: actor.id,
      now: new Date(),
    });

    return { ...created, validApprovalForExport: false };
  });
}

/**
 * Lista o histórico completo de Versões editoriais de `rawContentId`, do
 * número mais antigo ao mais recente (FR-028-005). Mesma guarda de alcance de
 * `assertRawContentReachable` (DEC-029-002 herdada), SEM restrição adicional
 * por autoria da Versão — um EDITOR que alcança o próprio `RawContent` vê
 * TODAS as Versões nele, mesmo as fechadas por um ADMIN.
 *
 * `validApprovalForExport` (COMP-033-005, FR-032-006/007) só é computado para
 * a Versão vigente (o último item do array já ordenado ASC) e só quando ela
 * JÁ está aprovada (`approvedById !== null`) — senão é `false` por
 * construção, sem I/O extra. Toda entrada que não é a vigente é `false`
 * incondicionalmente, mesmo tendo sido aprovada no passado.
 *
 * Custo depende só de `N` (Versões daquele `RawContent`, NFR-028-003/
 * NFR-032-003/AC-028-012/AC-032-013) — o índice `@@unique([rawContentId,
 * number])` (TASK-029-001) serve o `findMany` filtrado por `rawContentId`.
 * Medido: 2 statements (`assertRawContentReachable` + este `findMany`) quando
 * a vigente não está aprovada; +2 (leitura de `RawContent`/`RuleBreakdown`
 * versionados) +1 condicional (`productionStageEvent.findFirst`, dentro de
 * `resolveAlterationSignal`, pulado no short-circuit de conteúdo alterado)
 * quando ela está — nenhum dos statements cresce com `N`.
 */
export async function listContentVersions(
  rawContentId: string,
  actor: ContentActor,
  db: ContentVersionClient = prisma,
): Promise<ContentVersionDetail[]> {
  await assertRawContentReachable(rawContentId, actor, db);

  const versions = await db.contentVersion.findMany({
    where: { rawContentId },
    orderBy: { number: 'asc' },
    select: { ...CONTENT_VERSION_DETAIL_SELECT, contentSnapshot: true },
  });

  const vigente = versions.at(-1);
  let currentIsValidForExport = false;
  if (vigente !== undefined && vigente.approvedById !== null) {
    const rawContent = await db.rawContent.findUniqueOrThrow({
      where: { id: rawContentId },
      select: RAW_CONTENT_VERSIONED_SELECT,
    });
    const ruleBreakdown = await db.ruleBreakdown.findUniqueOrThrow({
      where: { rawContentId },
      select: RULE_BREAKDOWN_VERSIONED_SELECT,
    });
    const currentFields = toVersionedContentFields(rawContent, ruleBreakdown);
    const altered = await resolveAlterationSignal(rawContentId, currentFields, vigente, db);
    currentIsValidForExport = !altered;
  }

  const lastIndex = versions.length - 1;
  return versions.map((version, index) => ({
    id: version.id,
    rawContentId: version.rawContentId,
    number: version.number,
    legislativeClosureDate: version.legislativeClosureDate,
    authorId: version.authorId,
    closedAt: version.closedAt,
    approvedById: version.approvedById,
    approvedAt: version.approvedAt,
    validApprovalForExport: index === lastIndex ? currentIsValidForExport : false,
  }));
}

/**
 * Sinal combinado de alteração pós-fechamento (DEC-033-007): OU lógico entre
 * `hasVersionedContentChanged` (CONTEÚDO/Quebra da regra) e o evento de Tira
 * mnemônica mais recente (`ProductionStageEvent`, `stageType:
 * 'TIRA_MNEMONICA'`) posterior a `version.closedAt`. Único ponto de
 * manutenção da combinação.
 *
 * Short-circuit (TRISK-033-002): CONTEÚDO alterado retorna sem consultar
 * `productionStageEvent`. `orderBy: { sequence: 'desc' }` (nunca
 * `occurredAt`) — desempate determinístico (AC-009-008).
 */
export async function resolveAlterationSignal(
  rawContentId: string,
  current: VersionedContentFields,
  version: { contentSnapshot: unknown; closedAt: Date },
  db: Pick<typeof prisma, 'productionStageEvent'>,
): Promise<boolean> {
  if (hasVersionedContentChanged(current, version.contentSnapshot as VersionedContentFields)) {
    return true;
  }

  const latestTiraEvent = await db.productionStageEvent.findFirst({
    where: { rawContentId, stageType: 'TIRA_MNEMONICA' },
    orderBy: { sequence: 'desc' },
    select: { occurredAt: true },
  });

  return latestTiraEvent !== null && latestTiraEvent.occurredAt > version.closedAt;
}

/**
 * Aprova a Versão vigente de `rawContentId` (FR-032-001 a 005/009/013 a 018),
 * dentro de uma `$transaction`, guardas nesta ordem (DEC-033-001 herdada, DEC-033-009):
 *
 *   1. Lock da linha do `RawContent` pai — 1ª chamada, serializa fechamentos/
 *      aprovações concorrentes do mesmo `rawContentId`.
 *   2. `assertRawContentReachable` (FR-032-018).
 *   3. Detalhe do `RawContent` versionado.
 *   4. Versão vigente inexistente → `NotFoundError` (FR-032-003) — ANTES da
 *      leitura de `RuleBreakdown` (passo 10): `*OrThrow` só depois da guarda
 *      que torna a ausência impossível (a invariante "toda ContentVersion tem
 *      RuleBreakdown" só vale a partir daqui — um RawContent sem Versão pode
 *      legitimamente não ter RuleBreakdown salva).
 *   5. Número informado ≠ vigente → `ConflictError` (FR-032-014, duplo travamento).
 *   6. Já aprovada → `ConflictError` (checagem antecipada — a garantia real é o
 *      passo 12).
 *   7. Segregação de funções: ator ∈ {autor da Versão, autor do RawContent,
 *      último editor} → `ForbiddenError` genérico (FR-032-004, NFR-032-002 —
 *      nunca revela qual identidade bateu).
 *   8. Edição pós-fechamento sem mudança versionada (DEC-033-006 emendada):
 *      existe `ProductionStageEvent` `CONTEUDO_BRUTO` do `rawContentId` com
 *      `sequence` maior que a do `VERSAO_EDITORIAL` que fechou a Versão
 *      vigente → `ConflictError` (ordem do BANCO — `sequence` é atribuída no
 *      INSERT, dentro da transação que espera o lock do passo 1; nunca
 *      `lastEditedAt`/relógio de aplicação, que uma edição concorrente pode
 *      commitar com timestamp ANTERIOR ao fechamento apesar de ter sido
 *      serializada DEPOIS pelo lock). `findFirstOrThrow` é seguro aqui: toda
 *      `ContentVersion` nasce com seu próprio `VERSAO_EDITORIAL` na MESMA
 *      transação de `closeContentVersion` (passo 4 já garante que `vigente`
 *      existe).
 *   9. Fonte normativa ausente no `contentSnapshot` da Versão vigente →
 *      `ConflictError` (FR-032-013).
 *   10. `RuleBreakdown` versionada (só agora — passo 4 já garante que existe).
 *   11. Sinal de alteração pós-fechamento (conteúdo OU Tira) aceso →
 *       `ConflictError` (FR-032-015).
 *   12. `updateMany` condicionado a `approvedById: null` — a garantia REAL de
 *       exatamente 1 escrita (DEC-033-009); `count !== 1` → `ConflictError`.
 *   13. `recordProductionStageEvent` sempre `CONCLUSAO` direto (DEC-033-008) —
 *       ÚLTIMA chamada do corpo.
 *
 * Qualquer falha nos passos 1-12 propaga sem gravar nada (fail-secure,
 * NFR-032-001/002).
 */
export async function approveContentVersion(
  rawContentId: string,
  number: number,
  input: ApproveContentVersionInput,
  actor: ContentActor,
  db: ContentVersionClient = prisma,
): Promise<ContentVersionDetail> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM raw_contents WHERE id = ${rawContentId} FOR UPDATE
    `;
    if (locked[0] === undefined) {
      throw new NotFoundError('Conteúdo bruto não encontrado.');
    }

    await assertRawContentReachable(rawContentId, actor, tx);

    const rawContent = await tx.rawContent.findUniqueOrThrow({
      where: { id: rawContentId },
      select: RAW_CONTENT_VERSIONED_SELECT,
    });

    const vigente = await tx.contentVersion.findFirst({
      where: { rawContentId },
      orderBy: { number: 'desc' },
      select: { ...CONTENT_VERSION_DETAIL_SELECT, contentSnapshot: true },
    });
    if (vigente === null) {
      throw new NotFoundError('Não há versão para aprovar.');
    }

    if (vigente.number !== number) {
      throw new ConflictError(
        'A versão exibida não é mais a vigente. Atualize a página para ver a versão atual.',
      );
    }

    if (vigente.approvedById !== null) {
      throw new ConflictError('Esta versão já foi aprovada.');
    }

    const producerIds = new Set([vigente.authorId, rawContent.authorId, rawContent.lastEditedById]);
    if (producerIds.has(actor.id)) {
      throw new ForbiddenError('Você não tem permissão para aprovar esta versão.');
    }

    const closureEvent = await tx.productionStageEvent.findFirstOrThrow({
      where: { rawContentId, stageType: 'VERSAO_EDITORIAL' },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const editedAfterClosure = await tx.productionStageEvent.findFirst({
      where: {
        rawContentId,
        stageType: 'CONTEUDO_BRUTO',
        sequence: { gt: closureEvent.sequence },
      },
      select: { id: true },
    });
    if (editedAfterClosure !== null) {
      throw new ConflictError(
        'O conteúdo foi editado depois do fechamento desta versão. É preciso fechar uma nova versão para aprovar.',
      );
    }

    const snapshot = vigente.contentSnapshot as unknown as VersionedContentFields;
    if (snapshot.sourceType === null || snapshot.sourceCitation === null) {
      throw new ConflictError(
        'Esta versão foi fechada sem fonte normativa. Registre a fonte no conteúdo e feche uma nova versão para aprovação.',
      );
    }

    const ruleBreakdown = await tx.ruleBreakdown.findUniqueOrThrow({
      where: { rawContentId },
      select: RULE_BREAKDOWN_VERSIONED_SELECT,
    });

    const current = toVersionedContentFields(rawContent, ruleBreakdown);
    const altered = await resolveAlterationSignal(rawContentId, current, vigente, tx);
    if (altered) {
      throw new ConflictError(
        'O conteúdo ou a Tira mnemônica foram alterados depois do fechamento desta versão. É preciso fechar uma nova versão para aprovar.',
      );
    }

    const now = new Date();
    const result = await tx.contentVersion.updateMany({
      where: { id: vigente.id, approvedById: null },
      data: { approvedById: actor.id, approvedAt: now },
    });
    if (result.count !== 1) {
      throw new ConflictError('Esta versão já foi aprovada.');
    }

    await recordProductionStageEvent(tx, {
      rawContentId,
      stageType: 'APROVACAO_VERSAO',
      transitionType: 'CONCLUSAO',
      actorId: actor.id,
      now,
    });

    return {
      id: vigente.id,
      rawContentId,
      number: vigente.number,
      legislativeClosureDate: vigente.legislativeClosureDate,
      authorId: vigente.authorId,
      closedAt: vigente.closedAt,
      approvedById: actor.id,
      approvedAt: now,
      // Sem recomputar resolveAlterationSignal: o passo 11 já confirmou o
      // sinal `false` na mesma transação — 2ª leitura seria redundante.
      validApprovalForExport: true,
    };
  });
}
