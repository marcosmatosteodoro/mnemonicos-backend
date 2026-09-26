import type { NormativeSourceType, ProofRadarClass } from '../../domain/types';

/**
 * Os 11 campos versionados (COMP-029-003, A-028-002/DEC-029-003): os 5 de
 * `RawContent` (`rawText`/`radarClass`/`sourceType`/`sourceCitation`/`sourceUrl`) mais os
 * 6 de `RuleBreakdown` (`concept`/`action`/`object`/`condition`/`exception`/`essence`) —
 * a MESMA allowlist que `content-versions.service.ts` (TASK-029-002) grava em
 * `contentSnapshot` (passo 6, DEC-029-003). Único ponto de manutenção quando o recorte de
 * A-028-002 mudar: um campo novo entra aqui E lá, ou a comparação abaixo passa a comparar
 * um subconjunto desatualizado sem avisar (Json não tem typecheck cruzado — ver
 * TASK-029-003, "Comparação com o molde canônico").
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
