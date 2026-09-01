import { type AuthAuditEvent, type AuthAuditType, recordAuthEvent } from '../../src/lib/audit';
import { logger } from '../../src/lib/logger';

const ALL_TYPES: AuthAuditType[] = [
  'login.success',
  'login.failure',
  'login.throttled',
  'token.refresh',
  'token.reuse',
  'logout',
  'authz.denied',
];

const SENSITIVE_KEYS = ['password', 'token', 'accessToken', 'refreshToken'] as const;

function baseEvent(type: AuthAuditType): AuthAuditEvent {
  return {
    type,
    at: new Date('2026-08-28T12:00:00.000Z'),
    outcome: type === 'login.success' || type === 'logout' ? 'success' : 'failure',
    subject: 'editor@example.com',
    ip: '203.0.113.7',
  };
}

describe('recordAuthEvent', () => {
  it('emite cada um dos 7 tipos de evento por logger.info, sob a chave `audit`', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);

    for (const type of ALL_TYPES) recordAuthEvent(baseEvent(type));

    expect(info).toHaveBeenCalledTimes(ALL_TYPES.length);
    ALL_TYPES.forEach((type, i) => {
      const call = info.mock.calls[i];
      if (call === undefined) throw new Error(`sem chamada para o tipo ${type}`);
      expect(call[0]).toEqual({ audit: baseEvent(type) });
    });

    info.mockRestore();
  });

  it('inclui marca temporal, desfecho, sujeito e origem no evento emitido', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const event = baseEvent('login.failure');

    recordAuthEvent(event);

    const payload = info.mock.calls[0]?.[0] as { audit: Record<string, unknown> } | undefined;
    if (payload === undefined) throw new Error('esperava um registro de auditoria');
    expect(payload.audit).toMatchObject({
      at: event.at,
      outcome: 'failure',
      subject: 'editor@example.com',
      ip: '203.0.113.7',
    });

    info.mockRestore();
  });

  it('não emite nenhuma chave de material sensível no evento (asserção estrutural)', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);

    recordAuthEvent({ ...baseEvent('token.reuse'), userAgent: 'jest-agent/1.0' });

    const payload = info.mock.calls[0]?.[0] as { audit: Record<string, unknown> } | undefined;
    if (payload === undefined) throw new Error('esperava um registro de auditoria');
    const keys = Object.keys(payload.audit);
    for (const forbidden of SENSITIVE_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    // O emissor repassa o evento como veio — não enriquece com campos extras.
    expect(keys.sort()).toEqual(['at', 'ip', 'outcome', 'subject', 'type', 'userAgent'].sort());

    info.mockRestore();
  });

  it('propaga userAgent quando informado e o omite quando ausente', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);

    recordAuthEvent(baseEvent('logout'));
    recordAuthEvent({ ...baseEvent('login.success'), userAgent: 'curl/8.0' });

    const first = info.mock.calls[0]?.[0] as { audit: Record<string, unknown> };
    const second = info.mock.calls[1]?.[0] as { audit: Record<string, unknown> };
    expect('userAgent' in first.audit).toBe(false);
    expect(second.audit.userAgent).toBe('curl/8.0');

    info.mockRestore();
  });
});
