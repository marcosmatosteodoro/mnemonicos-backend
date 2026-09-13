import type { prisma } from '../../lib/prisma';

/**
 * Camada de acesso ao binário no Postgres (COMP-023-003 / DEC-023-002): o
 * binário da imagem é a coluna `imageData Bytes` da própria linha
 * `VisualAssociation` — não é módulo de filesystem, e as 2 funções nunca abrem
 * transação própria. Operam sobre o MESMO client/`tx` recebido do chamador
 * (COMP-023-005 decide QUANDO chamar, dentro do `create`/`update` da linha) —
 * mesmo padrão de tipo de parâmetro injetável de
 * `MnemonicStripClient`/`MnemonicFrameWriteClient` em `tira.service.ts`.
 */
type PrismaClientOrTx = Pick<typeof prisma, 'visualAssociation'>;

/**
 * Grava o binário já validado por assinatura de bytes (`image-signature.ts`,
 * fora desta camada) na coluna `imageData` da linha existente.
 */
export async function saveVisualAssociationImage(
  tx: PrismaClientOrTx,
  id: string,
  buffer: Buffer,
): Promise<void> {
  await tx.visualAssociation.update({
    where: { id },
    // `Buffer` é `Uint8Array<ArrayBufferLike>`; o campo `Bytes` do Prisma
    // espera `Uint8Array<ArrayBuffer>` — só o parâmetro genérico diverge (o
    // buffer em memória nunca é `SharedArrayBuffer` nesta aplicação).
    data: { imageData: buffer as unknown as Uint8Array<ArrayBuffer> },
  });
}

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
