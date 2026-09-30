import { describe, expect, it } from 'vitest';
import { KeyedRunner, orderingKey } from './inbound';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedRunner (Ф11)', () => {
  it('задачи одного ключа — строго по очереди, разных ключей — параллельно, не больше предела', async () => {
    const r = new KeyedRunner(3);
    const log: string[] = [];
    let running = 0;
    let peak = 0;
    const task = (id: string, ms: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      log.push(`+${id}`);
      await sleep(ms);
      log.push(`-${id}`);
      running--;
    };
    await r.push('a', task('a1', 30));
    await r.push('a', task('a2', 5));
    await r.push('b', task('b1', 10));
    await r.push('c', task('c1', 10));
    await r.push('d', task('d1', 10));
    await r.drain();
    expect(log.indexOf('+a2')).toBeGreaterThan(log.indexOf('-a1'));
    expect(log.indexOf('+b1')).toBeLessThan(log.indexOf('-a1'));
    expect(peak).toBeLessThanOrEqual(3);
    expect(log.filter((x) => x.startsWith('-'))).toHaveLength(5);
  });

  it('ошибка задачи не останавливает очередь ключа', async () => {
    const r = new KeyedRunner(2);
    const done: string[] = [];
    await r.push('k', async () => {
      throw new Error('сбой');
    });
    await r.push('k', async () => {
      done.push('second');
    });
    await r.drain();
    expect(done).toEqual(['second']);
  });

  it('ключ — канал и отправитель', () => {
    expect(orderingKey({ channelId: 'c', identity: { kind: 'telegram', value: '42' } })).toBe(
      'c:telegram:42',
    );
    expect(orderingKey(null)).toBe('::');
  });
});
