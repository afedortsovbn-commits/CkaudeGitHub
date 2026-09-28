import { describe, expect, it } from 'vitest';
import { makeEvent, parseEvent, subjectFor } from './event';

describe('оболочка события', () => {
  it('создаёт валидное событие с UUIDv7 и версией 1 по умолчанию', () => {
    const e = makeEvent({ type: 'demo.ping.created', source: 'test', data: { n: 1 } });
    expect(e.version).toBe(1);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.id[14]).toBe('7');
    expect(parseEvent(JSON.parse(JSON.stringify(e)))).toMatchObject({ type: 'demo.ping.created' });
  });

  it('потребитель не падает на неизвестных полях (аддитивная совместимость)', () => {
    const e = { ...makeEvent({ type: 'demo.ping.created', source: 'test', data: {} }), futureField: 42 };
    expect(() => parseEvent(e)).not.toThrow();
  });

  it('отклоняет неверный тип события', () => {
    expect(() => makeEvent({ type: 'BadType', source: 't', data: {} })).toThrow();
  });

  it('строит subject', () => {
    expect(subjectFor('conversation.message.created')).toBe('cc.events.conversation.message.created');
  });
});
