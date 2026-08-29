import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decideRefresh, type SessionRow } from '../../src/modules/auth/session-rotation';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const GRACE_SECONDS = 10;

/** Linha saudável: refresh no futuro, nunca rotacionada nem revogada. */
const activeRow = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  rotatedAt: null,
  revokedAt: null,
  refreshExpiresAt: new Date(NOW.getTime() + 60_000),
  ...overrides,
});

const secondsBeforeNow = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe('decideRefresh', () => {
  it('rotaciona quando o refresh é válido e ainda não foi trocado (AC-002-004)', () => {
    const decision = decideRefresh(activeRow(), NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'rotate' });
  });

  it('responde idempotente quando o refresh é reapresentado dentro da janela de graça (AC-002-026)', () => {
    const row = activeRow({ rotatedAt: secondsBeforeNow(GRACE_SECONDS - 1) });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'replay-grace' });
  });

  it('trata a graça como janela fechada: rotação exatamente no limite ainda é replay-grace (AC-002-026)', () => {
    const row = activeRow({ rotatedAt: secondsBeforeNow(GRACE_SECONDS) });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'replay-grace' });
  });

  it('acusa reuso quando o refresh foi rotacionado além da janela de graça (AC-002-005)', () => {
    const row = activeRow({ rotatedAt: secondsBeforeNow(GRACE_SECONDS + 1) });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'reuse' });
  });

  it('acusa reuso quando a linha já está revogada, mesmo sem rotação (AC-002-005)', () => {
    const row = activeRow({ revokedAt: secondsBeforeNow(1) });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'reuse' });
  });

  it('faz a revogação vencer a janela de graça: revogada dentro da graça → reuse (AC-002-005, precedência)', () => {
    const row = activeRow({
      revokedAt: secondsBeforeNow(5),
      rotatedAt: secondsBeforeNow(GRACE_SECONDS - 1),
    });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'reuse' });
  });

  it('recusa por expiração quando refreshExpiresAt está no passado (AC-002-006)', () => {
    const row = activeRow({ refreshExpiresAt: secondsBeforeNow(1) });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'expired' });
  });

  it('faz a expiração absoluta vencer a janela de graça (AC-002-006, precedência)', () => {
    const row = activeRow({
      refreshExpiresAt: secondsBeforeNow(1),
      rotatedAt: secondsBeforeNow(GRACE_SECONDS - 1),
    });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'expired' });
  });

  it('resolve refresh revogado e expirado como expired: expired vem antes de reuse na ordem documentada', () => {
    const row = activeRow({
      revokedAt: secondsBeforeNow(5),
      refreshExpiresAt: secondsBeforeNow(1),
    });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'expired' });
  });

  it('não expira no instante exato do vencimento: refreshExpiresAt igual a now ainda rotaciona', () => {
    const row = activeRow({ refreshExpiresAt: new Date(NOW.getTime()) });

    const decision = decideRefresh(row, NOW, GRACE_SECONDS);

    expect(decision).toEqual({ kind: 'rotate' });
  });

  it('não lê o relógio por dentro: o corpo não referencia Date.now() nem new Date()', () => {
    const source = readFileSync(
      join(__dirname, '../../src/modules/auth/session-rotation.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/Date\.now\(/);
    expect(source).not.toMatch(/new Date\(/);
  });
});
