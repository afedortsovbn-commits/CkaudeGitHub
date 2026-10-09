import { describe, expect, it } from 'vitest';
import { assignmentState, gradeAttempt, isAnswerCorrect, type TestOption } from './operator-tests';

const opts: TestOption[] = [
  { id: 'a', text: 'А', correct: true },
  { id: 'b', text: 'Б', correct: false },
  { id: 'c', text: 'В', correct: true },
];

describe('тестирование сотрудников', () => {
  it('ответ верен, только если отмечены ровно все правильные варианты', () => {
    expect(isAnswerCorrect(opts, ['a', 'c'])).toBe(true);
    expect(isAnswerCorrect(opts, ['c', 'a'])).toBe(true);
    expect(isAnswerCorrect(opts, ['a'])).toBe(false);
    expect(isAnswerCorrect(opts, ['a', 'b', 'c'])).toBe(false);
    expect(isAnswerCorrect(opts, [])).toBe(false);
    expect(isAnswerCorrect([{ id: 'x', text: 'X', correct: false }], [])).toBe(false);
  });

  it('оценка — % правильных, пройдено по проходному баллу', () => {
    expect(gradeAttempt(8, 10, 80)).toEqual({ score: 80, passed: true });
    expect(gradeAttempt(7, 10, 80)).toEqual({ score: 70, passed: false });
    expect(gradeAttempt(2, 3, 67)).toEqual({ score: 67, passed: true });
    expect(gradeAttempt(0, 0, 50)).toEqual({ score: 0, passed: false });
  });

  it('состояние назначения: осталось дней, просрочено, пройдено, отменено', () => {
    const base = { passedAt: null, cancelledAt: null, dueDate: '2026-10-12' };
    expect(assignmentState(base, '2026-10-09')).toEqual({ status: 'open', daysLeft: 3 });
    expect(assignmentState(base, '2026-10-12')).toEqual({ status: 'open', daysLeft: 0 });
    expect(assignmentState(base, '2026-10-14')).toEqual({ status: 'overdue', daysLeft: -2 });
    expect(assignmentState({ ...base, passedAt: 'x' }, '2026-10-14').status).toBe('passed');
    expect(assignmentState({ ...base, cancelledAt: 'x' }, '2026-10-14').status).toBe('cancelled');
  });
});
