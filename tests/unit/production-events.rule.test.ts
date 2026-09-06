import { decideStageTransition } from '../../src/modules/production-events/production-events.service';
import type { ProductionEventTransition } from '../../src/domain/types';

/**
 * `decideStageTransition` (COMP-010-002 / TASK-010-002) — regra pura de
 * decisão da transição a partir do histórico já registrado para um par
 * (`rawContentId`, `stageType`). Sem I/O, sem banco, sem relógio (perfil §7).
 *
 * AC-009-008 exige indiferença à ORDEM da lista de entrada (a função nunca lê
 * posição/índice — só `includes`); por isso a tabela cobre cada composição de
 * histórico nas duas ordens possíveis, quando há mais de um elemento.
 */

interface Case {
  description: string;
  existingTransitions: readonly ProductionEventTransition[];
  expected: ProductionEventTransition;
}

const cases: Case[] = [
  {
    description: 'histórico vazio → ABERTURA',
    existingTransitions: [],
    expected: 'ABERTURA',
  },
  {
    description: 'só ABERTURA no histórico → CONCLUSAO',
    existingTransitions: ['ABERTURA'],
    expected: 'CONCLUSAO',
  },
  {
    description: 'ABERTURA + CONCLUSAO (ordem cronológica) → RETRABALHO',
    existingTransitions: ['ABERTURA', 'CONCLUSAO'],
    expected: 'RETRABALHO',
  },
  {
    description: 'CONCLUSAO + ABERTURA (ordem invertida) → RETRABALHO, mesmo assim',
    existingTransitions: ['CONCLUSAO', 'ABERTURA'],
    expected: 'RETRABALHO',
  },
  {
    description: 'só CONCLUSAO no histórico (sem ABERTURA explícita) → RETRABALHO',
    existingTransitions: ['CONCLUSAO'],
    expected: 'RETRABALHO',
  },
  {
    description:
      'histórico com múltiplos RETRABALHO anteriores + CONCLUSAO → RETRABALHO (para sempre a partir da conclusão)',
    existingTransitions: ['ABERTURA', 'CONCLUSAO', 'RETRABALHO', 'RETRABALHO'],
    expected: 'RETRABALHO',
  },
  {
    description:
      'mesmo histórico do caso anterior, em ordem embaralhada → RETRABALHO, indiferente à ordem',
    existingTransitions: ['RETRABALHO', 'RETRABALHO', 'CONCLUSAO', 'ABERTURA'],
    expected: 'RETRABALHO',
  },
];

describe('decideStageTransition', () => {
  it.each(cases)('$description', ({ existingTransitions, expected }) => {
    expect(decideStageTransition(existingTransitions)).toBe(expected);
  });
});
