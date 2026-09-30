import type { ProofRadarClass } from './types';

export type PresentationPriority = 'ALTA' | 'MEDIA' | 'BAIXA';

function assertNeverProofRadarClass(radarClass: never): never {
  throw new Error(`classe de radar de prova não tratada: ${String(radarClass)}`);
}

/**
 * Deriva a prioridade de apresentação do backlog do Painel estratégico a partir da classe
 * do radar de prova (DEC-035-006, comentário `schema.prisma:48-50` nunca antes codificado):
 * `ALTA`/`MEDIA` mantêm o próprio nome; `DETALHE`/`EXCECAO`/`PEGADINHA` colapsam em `BAIXA`.
 */
export function derivePresentationPriority(radarClass: ProofRadarClass): PresentationPriority {
  switch (radarClass) {
    case 'ALTA':
      return 'ALTA';
    case 'MEDIA':
      return 'MEDIA';
    case 'DETALHE':
    case 'EXCECAO':
    case 'PEGADINHA':
      return 'BAIXA';
    default:
      return assertNeverProofRadarClass(radarClass);
  }
}
