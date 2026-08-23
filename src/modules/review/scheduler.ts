import type { ReviewRating } from '../../domain/types';

/** Constantes do agendamento — variante enxuta do SM-2. */
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
const MAX_INTERVAL_DAYS = 365;
/** Um erro devolve o cartão à mesma sessão, não ao dia seguinte. */
const RELEARN_DELAY_MINUTES = 10;

export interface CardSchedule {
  /** Intervalo atual em dias (0 = cartão novo ou em reaprendizado). */
  intervalDays: number;
  /** Fator de facilidade: quanto maior, mais rápido o intervalo cresce. */
  easeFactor: number;
  /** Acertos consecutivos. */
  repetitions: number;
  /** Quantas vezes o cartão foi esquecido. */
  lapses: number;
}

export interface ScheduleOutcome extends CardSchedule {
  dueAt: Date;
}

export const newCardSchedule: CardSchedule = {
  intervalDays: 0,
  easeFactor: 2.5,
  repetitions: 0,
  lapses: 0,
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const addDays = (from: Date, days: number) => new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

const addMinutes = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60 * 1000);

/**
 * Calcula o próximo agendamento de um cartão a partir da nota que o estudante
 * deu a si mesmo. Função pura: nenhuma leitura de relógio ou de banco aqui —
 * `now` entra por parâmetro justamente para o teste poder fixá-lo.
 */
export function scheduleNext(
  current: CardSchedule,
  rating: ReviewRating,
  now: Date,
): ScheduleOutcome {
  if (rating === 'AGAIN') {
    return {
      intervalDays: 0,
      easeFactor: clamp(current.easeFactor - 0.2, MIN_EASE, MAX_EASE),
      repetitions: 0,
      lapses: current.lapses + 1,
      dueAt: addMinutes(now, RELEARN_DELAY_MINUTES),
    };
  }

  const easeFactor = clamp(
    current.easeFactor + (rating === 'HARD' ? -0.15 : rating === 'EASY' ? 0.15 : 0),
    MIN_EASE,
    MAX_EASE,
  );

  const repetitions = current.repetitions + 1;
  const intervalDays = clamp(
    Math.round(nextInterval(current, rating, easeFactor)),
    1,
    MAX_INTERVAL_DAYS,
  );

  return {
    intervalDays,
    easeFactor,
    repetitions,
    lapses: current.lapses,
    dueAt: addDays(now, intervalDays),
  };
}

function nextInterval(current: CardSchedule, rating: ReviewRating, easeFactor: number): number {
  // Cartão novo ou recém-reaprendido: intervalos fixos até firmar.
  if (current.repetitions === 0) {
    return rating === 'HARD' ? 1 : rating === 'GOOD' ? 1 : 2;
  }

  if (current.repetitions === 1) {
    return rating === 'HARD' ? 2 : rating === 'GOOD' ? 3 : 5;
  }

  const base = Math.max(current.intervalDays, 1) * easeFactor;

  return rating === 'HARD' ? base * 0.6 : rating === 'EASY' ? base * 1.3 : base;
}
