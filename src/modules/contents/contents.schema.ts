import { z } from 'zod';

/**
 * Schemas Zod do Conteúdo bruto (COMP-006-002 / TASK-006-006). Os literais dos
 * dois enums espelham `schema.prisma` (`ProofRadarClass`, `NormativeSourceType`);
 * ficam **inline** aqui — não importados de `domain/types.ts` — porque a
 * mirragem cross-repo desses enums é COMP-006-008/TASK-006-004, tarefa paralela
 * e disjunta desta (Wave 2). `listRawContentsQuerySchema` (TASK-006-008) e
 * `saveRuleBreakdownSchema` (TASK-006-009) nascem em tarefas seguintes.
 */

const PROOF_RADAR_CLASSES = ['ALTA', 'MEDIA', 'DETALHE', 'EXCECAO', 'PEGADINHA'] as const;

const NORMATIVE_SOURCE_TYPES = [
  'CF',
  'CTN',
  'LEI',
  'LEI_COMPLEMENTAR',
  'SUMULA',
  'ATO_NORMATIVO',
] as const;

/**
 * Citação obrigatória quando o tipo do dispositivo normativo é informado
 * (FR-005-011 / AC-005-015). Roda como `.superRefine` tanto na criação quanto na
 * edição (mesma regra, chamada duas vezes — nunca duplicada) porque a edição é
 * `.partial()` do mesmo shape e não herda o refinamento de `createRawContentSchema`
 * automaticamente (Zod não permite `.partial()` sobre um schema já refinado).
 */
function requireCitationWhenSourceType(
  data: { sourceType?: (typeof NORMATIVE_SOURCE_TYPES)[number]; sourceCitation?: string },
  ctx: z.RefinementCtx,
): void {
  if (data.sourceType !== undefined && !data.sourceCitation) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourceCitation'],
      message: 'Informe a citação do dispositivo quando o tipo de fonte é selecionado.',
    });
  }
}

/**
 * Shape base, sem refinamento — reusado por `createRawContentSchema` (completo)
 * e por `updateRawContentSchema` (`.partial()`, TASK-006-006 critério §2: nenhum
 * dos dois shapes declara `authorId` — a autoria vem do `actorId`/`actor` da
 * sessão, nunca do corpo da requisição).
 */
const rawContentFieldsSchema = z.object({
  topicId: z.string().trim().min(1, 'Informe o tema/assunto.'),
  rawText: z.string().trim().min(1, 'Informe o texto normativo.'),
  radarClass: z.enum(PROOF_RADAR_CLASSES, {
    error: 'Selecione uma classe do radar de prova.',
  }),
  sourceType: z
    .enum(NORMATIVE_SOURCE_TYPES, { error: 'Tipo de fonte normativa inválido.' })
    .optional(),
  sourceCitation: z.string().trim().min(1, 'Informe a citação do dispositivo.').optional(),
  sourceUrl: z.string().trim().min(1, 'Informe o link da fonte.').optional(),
});

/** Criação de Conteúdo bruto (FR-005-001/002/003/010/011). */
export const createRawContentSchema = rawContentFieldsSchema.superRefine(
  requireCitationWhenSourceType,
);

export type CreateRawContentInput = z.infer<typeof createRawContentSchema>;

/**
 * Edição de Conteúdo bruto — mesmos campos aplicáveis, todos opcionais
 * (FR-005-007): a chamada de serviço pode enviar só o subconjunto alterado
 * (`updateRawContent(id, { rawText: 'novo' }, actor)`), nunca um formulário
 * completo obrigatório. Mesma obrigatoriedade de fonte de `createRawContentSchema`
 * quando o campo é enviado.
 */
export const updateRawContentSchema = rawContentFieldsSchema
  .partial()
  .superRefine(requireCitationWhenSourceType);

export type UpdateRawContentInput = z.infer<typeof updateRawContentSchema>;
