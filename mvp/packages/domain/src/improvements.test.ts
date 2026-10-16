import { describe, expect, it } from 'vitest';
import { improvementRating, templateKey } from './improvements';

describe('робот предложений (Д-098, Д-099)', () => {
  it('рейтинг растёт с частотой и весом и не выходит за 1–100', () => {
    expect(improvementRating(3, 0)).toBe(1);
    expect(improvementRating(3, 5)).toBeLessThan(improvementRating(3, 50));
    expect(improvementRating(1, 50)).toBeLessThan(improvementRating(3, 50));
    expect(improvementRating(3, 200)).toBe(100);
    expect(improvementRating(3, 100000)).toBe(100);
  });
  it('одинаковые ответы с разными числами и знаками — один ключ', () => {
    expect(templateKey('Заказ №123: бонусы придут через 3 дня!')).toBe(
      templateKey('заказ № 77 — бонусы придут через 5 дня'),
    );
  });
});
