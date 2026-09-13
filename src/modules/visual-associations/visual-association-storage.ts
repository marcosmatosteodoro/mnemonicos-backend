import type { prisma } from '../../lib/prisma';

/**
 * Camada de acesso ao binário no Postgres (COMP-023-003 / DEC-023-002): o
 * binário da imagem é a coluna `imageData Bytes` da própria linha
 * `VisualAssociation` — não é módulo de filesystem. Opera sobre o MESMO
 * client/`tx` recebido do chamador, nunca abrindo transação própria — mesmo
 * padrão de tipo de parâmetro injetável de
 * `MnemonicStripClient`/`MnemonicFrameWriteClient` em `tira.service.ts`. A
 * escrita do binário roda no MESMO INSERT/UPDATE do Prisma em
 * `visual-associations.service.ts` (`create`/`update` com `imageData` no
 * `data`), não por uma função de escrita separada aqui.
 */
type PrismaClientOrTx = Pick<typeof prisma, 'visualAssociation'>;

/**
 * Lê o binário da linha, ou `null` se o id não existir — nunca lança para
 * associação inexistente (quem decide 404/403 é o chamador, COMP-023-005).
 */
export async function readVisualAssociationImage(
  db: PrismaClientOrTx,
  id: string,
): Promise<Buffer | null> {
  const row = await db.visualAssociation.findUnique({
    where: { id },
    select: { imageData: true },
  });

  if (row === null) return null;

  return Buffer.from(row.imageData);
}
