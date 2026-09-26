import type { NormativeSourceType, ProofRadarClass } from '../../domain/types';

/**
 * Os 11 campos versionados (COMP-029-003, A-028-002/DEC-029-003): os 5 de
 * `RawContent` (`rawText`/`radarClass`/`sourceType`/`sourceCitation`/`sourceUrl`) mais os
 * 6 de `RuleBreakdown` (`concept`/`action`/`object`/`condition`/`exception`/`essence`).
 * Único ponto de manutenção quando o recorte de A-028-002 mudar: `toVersionedContentFields`
 * (abaixo) é a ÚNICA função que monta este formato a partir de `RawContent`/`RuleBreakdown`
 * — `content-versions.service.ts` (o snapshot gravado no fechamento) e
 * `publication.service.ts` (o lado "atual" da comparação) chamam a mesma função, nenhum dos
 * dois monta o objeto por conta própria.
 */
export interface VersionedContentFields {
  rawText: string;
  radarClass: ProofRadarClass;
  sourceType: NormativeSourceType | null;
  sourceCitation: string | null;
  sourceUrl: string | null;
  concept: string;
  action: string;
  object: string;
  condition: string | null;
  exception: string | null;
  essence: string;
}

/**
 * Monta os 11 campos versionados a partir do `RawContent` e da `RuleBreakdown` já lidos
 * pelo chamador (sem I/O aqui) — `satisfies VersionedContentFields` trava, em tempo de
 * compilação, qualquer campo esquecido ou de tipo errado; os parâmetros são `Pick`s
 * estruturais (não os models inteiros), então tanto o `rawContent`/`ruleBreakdown` de
 * `content-versions.service.ts` (que têm campos extras, ex. `authorId`) quanto os de
 * `publication.service.ts` (que têm forma reduzida própria) satisfazem o parâmetro sem
 * conversão. Sem anotação de retorno `: VersionedContentFields` (nominal) — o resultado
 * precisa chegar a `tx.contentVersion.create({ data: { contentSnapshot } })` como tipo de
 * objeto literal (sem index signature própria), o único formato que `Prisma.InputJsonObject`
 * aceita sem cast; `satisfies` trava a forma sem alterar o tipo inferido do retorno.
 */
export function toVersionedContentFields(
  rawContent: Pick<
    VersionedContentFields,
    'rawText' | 'radarClass' | 'sourceType' | 'sourceCitation' | 'sourceUrl'
  >,
  ruleBreakdown: Pick<
    VersionedContentFields,
    'concept' | 'action' | 'object' | 'condition' | 'exception' | 'essence'
  >,
) {
  return {
    rawText: rawContent.rawText,
    radarClass: rawContent.radarClass,
    sourceType: rawContent.sourceType,
    sourceCitation: rawContent.sourceCitation,
    sourceUrl: rawContent.sourceUrl,
    concept: ruleBreakdown.concept,
    action: ruleBreakdown.action,
    object: ruleBreakdown.object,
    condition: ruleBreakdown.condition,
    exception: ruleBreakdown.exception,
    essence: ruleBreakdown.essence,
  } satisfies VersionedContentFields;
}

/**
 * Compara o estado ATUAL do Conteúdo/Quebra contra o `contentSnapshot` de uma Versão
 * fechada — campo a campo, `===` estrito (função PURA, sem I/O, COMP-029-003):
 * `true` se QUALQUER um dos 11 campos divergir (fail-secure, A-028-012 — falso negativo é
 * o que NFR-028 proíbe; a comparação exata campo a campo nunca produz falso positivo,
 * então esse fail-secure é satisfeito por construção).
 */
export function hasVersionedContentChanged(
  current: VersionedContentFields,
  snapshot: VersionedContentFields,
): boolean {
  return (
    current.rawText !== snapshot.rawText ||
    current.radarClass !== snapshot.radarClass ||
    current.sourceType !== snapshot.sourceType ||
    current.sourceCitation !== snapshot.sourceCitation ||
    current.sourceUrl !== snapshot.sourceUrl ||
    current.concept !== snapshot.concept ||
    current.action !== snapshot.action ||
    current.object !== snapshot.object ||
    current.condition !== snapshot.condition ||
    current.exception !== snapshot.exception ||
    current.essence !== snapshot.essence
  );
}
