import { z } from 'zod';

/**
 * Schema Zod de fechamento de Versão editorial (COMP-029-002 / TASK-029-002):
 * único campo aceito do cliente é `legislativeClosureDate` — número, autor e
 * timestamp técnico são todos calculados/derivados no service, nunca aceitos
 * do input (`closeContentVersion` nem os leria daqui, o schema nem os
 * declara). O `:id` da rota reusa `rawContentIdParamSchema` de
 * `../contents/contents.schema.ts` (nenhum `:versionId` — esta fatia não
 * expõe leitura/edição por Versão individual).
 *
 * `legislativeClosureDate` recusa data FUTURA por comparação de DATA, não de
 * timestamp (DEC-029-006): "hoje" é lido de `new Date().toISOString().slice(0, 10)`
 * no momento do `parse` — sem parâmetro de `now` injetável (1º schema Zod do
 * projeto dependente de tempo; testável por `jest.useFakeTimers().setSystemTime(...)`,
 * sem alterar a assinatura). Sem checagem de monotonicidade entre Versões
 * sucessivas — uma Versão nova pode declarar data anterior à da Versão
 * anterior (DEC-029-006).
 */
export const closeContentVersionSchema = z.object({
  legislativeClosureDate: z.iso
    .date('Data de fechamento legislativo inválida.')
    .refine((value) => value <= new Date().toISOString().slice(0, 10), {
      message: 'Data de fechamento legislativo não pode ser futura.',
    }),
});

export type CloseContentVersionInput = z.infer<typeof closeContentVersionSchema>;

/**
 * Schema de aprovação de Versão vigente (COMP-033-002): exatamente 2
 * confirmações, cada uma só aceita `true` — `false`, ausente ou string
 * falha o `parse` com 422 (A-032-004, ato único atômico, sem estado parcial).
 */
export const approveContentVersionSchema = z.object({
  legalCheckConfirmed: z.literal(true, 'Confirmação da checagem jurídica é obrigatória.'),
  pedagogicalCheckConfirmed: z.literal(true, 'Confirmação da checagem pedagógica é obrigatória.'),
});

export type ApproveContentVersionInput = z.infer<typeof approveContentVersionSchema>;

/**
 * `:id`/`:number` da rota de aprovação — schema PRÓPRIO (não reexporta
 * `rawContentIdParamSchema` isoladamente): o duplo travamento de FR-032-014
 * exige o número como parte do MESMO objeto de params desta rota.
 */
export const approveContentVersionParamsSchema = z.object({
  id: z.uuid('Identificador de conteúdo bruto inválido.'),
  number: z.coerce.number('Número de Versão inválido.').int().positive(),
});

export type ApproveContentVersionParams = z.infer<typeof approveContentVersionParamsSchema>;
