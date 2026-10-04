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

/** Tipo do evento de auditoria de ação sobre uma conta de usuário (DEC-051-011). */
export type UserAuditType = 'user.reactivated';

/**
 * Evento de auditoria de uma ação de ADMIN sobre uma conta (NFR-050-001).
 * Paralelo a `AuthAuditEvent` (DEC-051-011) — não generaliza `AuthAuditType`:
 * `subject` ali é quem se autenticou/tentou autenticar; aqui `actorId` e
 * `targetId` distinguem quem agiu de sobre quem agiu. Mesmo objeto plano de 1
 * nível (restrição do `redact` do pino). Nunca carrega senha nem token.
 */
export interface UserAuditEvent {
  type: UserAuditType;
  at: Date;
  actorId: string;
  targetId: string;
}

/** Emite o evento de auditoria de ação de usuário pela mesma trilha estruturada. */
export function recordUserAuditEvent(event: UserAuditEvent): void {
  logger.info({ audit: event }, `user:${event.type}`);
}
