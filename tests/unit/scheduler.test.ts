import {
  newCardSchedule,
  scheduleNext,
  type CardSchedule,
} from '../../src/modules/review/scheduler';

const NOW = new Date('2026-03-01T12:00:00.000Z');

const minutesBetween = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 60_000;
const daysBetween = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 86_400_000;

const mature: CardSchedule = {
  intervalDays: 10,
  easeFactor: 2.5,
  repetitions: 4,
  lapses: 0,
};

describe('scheduleNext', () => {
  it('devolve o cartão à mesma sessão quando o estudante erra', () => {
    const result = scheduleNext(mature, 'AGAIN', NOW);

    expect(result.intervalDays).toBe(0);
    expect(result.repetitions).toBe(0);
    expect(result.lapses).toBe(1);
    expect(minutesBetween(result.dueAt, NOW)).toBe(10);
  });

  it('reduz a facilidade a cada erro, sem passar do piso de 1,3', () => {
    let state: CardSchedule = { ...mature, easeFactor: 1.4 };
    state = scheduleNext(state, 'AGAIN', NOW);

    expect(state.easeFactor).toBe(1.3);

    state = scheduleNext(state, 'AGAIN', NOW);

    expect(state.easeFactor).toBe(1.3);
  });

  it('usa intervalos fixos nas duas primeiras revisões de um cartão novo', () => {
    const first = scheduleNext(newCardSchedule, 'GOOD', NOW);

    expect(first.intervalDays).toBe(1);
    expect(first.repetitions).toBe(1);

    const second = scheduleNext(first, 'GOOD', NOW);

    expect(second.intervalDays).toBe(3);
    expect(second.repetitions).toBe(2);
  });

  it('multiplica o intervalo pela facilidade em cartões maduros', () => {
    const result = scheduleNext(mature, 'GOOD', NOW);

    // 10 dias × 2,5 = 25
    expect(result.intervalDays).toBe(25);
    expect(daysBetween(result.dueAt, NOW)).toBe(25);
  });

  it('ordena os intervalos: DIFÍCIL < BOM < FÁCIL', () => {
    const hard = scheduleNext(mature, 'HARD', NOW).intervalDays;
    const good = scheduleNext(mature, 'GOOD', NOW).intervalDays;
    const easy = scheduleNext(mature, 'EASY', NOW).intervalDays;

    expect(hard).toBeLessThan(good);
    expect(good).toBeLessThan(easy);
  });

  it('aumenta a facilidade no FÁCIL, com teto de 3,0', () => {
    const result = scheduleNext({ ...mature, easeFactor: 2.95 }, 'EASY', NOW);

    expect(result.easeFactor).toBe(3);
  });

  it('nunca agenda além de um ano', () => {
    const result = scheduleNext({ ...mature, intervalDays: 300 }, 'EASY', NOW);

    expect(result.intervalDays).toBe(365);
  });

  it('preserva o número de lapsos quando a revisão é um acerto', () => {
    const result = scheduleNext({ ...mature, lapses: 3 }, 'GOOD', NOW);

    expect(result.lapses).toBe(3);
  });
});
