import { describe, expect, it } from 'vitest';
import { dueDate, resolveDefaults, resolveResponseDays } from './matrix';

describe('resolveDefaults — подстановка ответственных и кураторов', () => {
  const path = ['fuel', 'fuel.quality', 'fuel.quality.diesel'];
  it('наследует назначения темы, если на подтеме нет своих', () => {
    const d = resolveDefaults(path, [
      { topicId: 'fuel', userId: 'r1', kind: 'responsible' },
      { topicId: 'fuel', userId: 'c1', kind: 'curator' },
    ]);
    expect(d).toMatchObject({ responsibles: ['r1'], curators: ['c1'], responsibleFromTopicId: 'fuel' });
  });
  it('более точное назначение на подтеме приоритетнее; куратор разрешается независимо', () => {
    const d = resolveDefaults(path, [
      { topicId: 'fuel', userId: 'r1', kind: 'responsible' },
      { topicId: 'fuel.quality', userId: 'r2', kind: 'responsible' },
      { topicId: 'fuel', userId: 'c1', kind: 'curator' },
    ]);
    expect(d.responsibles).toEqual(['r2']);
    expect(d.responsibleFromTopicId).toBe('fuel.quality');
    expect(d.curators).toEqual(['c1']);
  });
  it('если на уровне только куратор — ответственный берётся с верхнего уровня', () => {
    const d = resolveDefaults(path, [
      { topicId: 'fuel.quality.diesel', userId: 'c9', kind: 'curator' },
      { topicId: 'fuel', userId: 'r1', kind: 'responsible' },
    ]);
    expect(d).toMatchObject({ responsibles: ['r1'], curators: ['c9'] });
  });
  it('несколько ответственных на одну подтему, без дублей', () => {
    const d = resolveDefaults(
      ['t'],
      [
        { topicId: 't', userId: 'a', kind: 'responsible' },
        { topicId: 't', userId: 'b', kind: 'responsible' },
        { topicId: 't', userId: 'a', kind: 'responsible' },
      ],
    );
    expect(d.responsibles).toEqual(['a', 'b']);
  });
  it('нет назначений — пусто (оператор выберет вручную)', () => {
    expect(resolveDefaults(path, [])).toMatchObject({
      responsibles: [],
      curators: [],
      responsibleFromTopicId: null,
    });
  });
});

describe('срок ответа', () => {
  it('ближайший заданный срок вверх по дереву, иначе глобальный 15', () => {
    expect(resolveResponseDays([null, 10, null], 15)).toBe(10);
    expect(resolveResponseDays([5, null, 3], 15)).toBe(3);
    expect(resolveResponseDays([null, null], 15)).toBe(15);
  });
  it('дата срока — календарные дни в часовом поясе системы', () => {
    // 27.09 22:30 UTC = 28.09 01:30 в Минске → +15 дней = 13.10
    expect(dueDate(new Date('2026-09-27T22:30:00Z'), 15, 'Europe/Minsk')).toBe('2026-10-13');
    expect(dueDate(new Date('2026-09-27T10:00:00Z'), 1, 'Europe/Minsk')).toBe('2026-09-28');
  });
});
