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
