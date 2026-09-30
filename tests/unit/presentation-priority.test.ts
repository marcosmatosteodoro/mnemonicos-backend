import { derivePresentationPriority } from '../../src/domain/presentation-priority';
import type { ProofRadarClass } from '../../src/domain/types';

describe('derivePresentationPriority (TASK-035-004, DEC-035-006)', () => {
  it('ALTA deriva prioridade ALTA', () => {
    expect(derivePresentationPriority('ALTA')).toBe('ALTA');
  });

  it('MEDIA deriva prioridade MEDIA', () => {
    expect(derivePresentationPriority('MEDIA')).toBe('MEDIA');
  });

  const baixaClasses: ProofRadarClass[] = ['DETALHE', 'EXCECAO', 'PEGADINHA'];
  it.each(baixaClasses)('classe %s deriva prioridade BAIXA', (radarClass) => {
    expect(derivePresentationPriority(radarClass)).toBe('BAIXA');
  });
});
