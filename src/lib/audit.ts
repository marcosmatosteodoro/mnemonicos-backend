import { logger } from './logger';

/** Tipo do evento de auditoria, discriminante da união `AuthAuditEvent`. */
export type AuthAuditType =
  | 'login.success'
  | 'login.failure'
  | 'login.throttled'
  | 'token.refresh'
  | 'token.reuse'
  | 'logout'
  | 'authz.denied';

/** Desfecho registrado no evento. `authz.denied` e `token.reuse` são `failure`. */
export type AuthOutcome = 'success' | 'failure';

/**
 * Evento de auditoria de autenticação/autorização (NFR-002-005). É um **objeto
 * plano de um nível**: o `redact` do pino só cobre um nível de aninhamento, então
 * nenhum campo pode ser sub-objeto. NUNCA carrega senha nem valor de credencial
 * ou token — quem chama monta o payload campo a campo, jamais a partir de
 * `req.body` cru.
 */
export interface AuthAuditEvent {
  type: AuthAuditType;
  at: Date;
  outcome: AuthOutcome;
  /** userId quando conhecido, senão o e-mail normalizado que foi tentado. */
  subject: string;
  /** Indicador de origem da requisição. */
  ip: string;
  userAgent?: string;
}

/** Emite o evento de auditoria pela trilha estruturada do serviço. */
export function recordAuthEvent(event: AuthAuditEvent): void {
  logger.info({ audit: event }, `auth:${event.type}`);
}
