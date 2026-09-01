/**
 * Desfecho de uma tentativa de renovação de sessão, decidido sem I/O.
 * A persistência de cada desfecho — rotação em transação, revogação por
 * família — é do `auth.service`, não daqui.
 *
 * - `rotate`: refresh válido e ainda não trocado → emitir sucessor.
 * - `replay-grace`: refresh reapresentado dentro da janela de graça → mesma
 *   rotação do ramo `rotate` (nova ponta da família), sem revogação e sem
 *   `token.reuse`, para renovações concorrentes do SPA não deslogarem.
 *   Reemitir o sucessor já emitido seria o ideal, mas é inviável: só o hash
 *   do token é persistido, nunca o valor em claro.
 * - `reuse`: refresh já rotacionado além da graça, ou linha já revogada →
 *   revogar toda a família.
 * - `expired`: `refreshExpiresAt` no passado → exigir nova autenticação.
 */
export type RefreshDecision =
  { kind: 'rotate' } | { kind: 'replay-grace' } | { kind: 'reuse' } | { kind: 'expired' };

/**
 * Subconjunto da linha de `Session` que a decisão consulta. Tipo estrutural
 * local, não o gerado pelo Prisma: mantém `decideRefresh` pura e testável em
 * `tests/unit/` sem o client gerado nem conexão de banco.
 */
export interface SessionRow {
  /** Setado quando este refresh já foi trocado por um sucessor; null = nunca. */
  rotatedAt: Date | null;
  /** Setado por logout, reuso, troca de senha ou desativação; null = ativa. */
  revokedAt: Date | null;
  /** Expiração absoluta do token de renovação (7 dias — FR-002-005). */
  refreshExpiresAt: Date;
}

/**
 * Decide o desfecho de uma renovação a partir da linha de sessão e de `now`.
 *
 * Precedência dos ramos, para os casos em que mais de uma condição vale ao
 * mesmo tempo: **expired → reuse → replay-grace → rotate**. A expiração
 * absoluta vence a janela de graça e o reuso (token revogado e expirado →
 * `expired`).
 *
 * Função pura: nenhuma leitura de relógio ou de banco — `now` entra por
 * parâmetro para o teste poder fixá-lo.
 */
export function decideRefresh(
  session: SessionRow,
  now: Date,
  graceSeconds: number,
): RefreshDecision {
  if (session.refreshExpiresAt.getTime() < now.getTime()) {
    return { kind: 'expired' };
  }

  if (session.revokedAt != null) {
    return { kind: 'reuse' };
  }

  if (session.rotatedAt != null) {
    const elapsedMs = now.getTime() - session.rotatedAt.getTime();

    return elapsedMs <= graceSeconds * 1000 ? { kind: 'replay-grace' } : { kind: 'reuse' };
  }

  return { kind: 'rotate' };
}
