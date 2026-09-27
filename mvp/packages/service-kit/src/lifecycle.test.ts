import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { Lifecycle } from './lifecycle';

describe('Lifecycle', () => {
  it('снимает readiness до остановки, вызывает хуки по порядку и один раз', async () => {
    const calls: string[] = [];
    let exitCode: number | undefined;
    const lc = new Lifecycle({
      logger: pino({ level: 'silent' }),
      drainDelayMs: 10,
      timeoutMs: 1000,
      exit: (c) => {
        exitCode = c;
      },
      sleep: async () => {
        calls.push(`sleep:ready=${lc.isReady}`);
      },
    });
    lc.onShutdown('nats', 30, () => void calls.push('nats'));
    lc.onShutdown('http', 10, () => void calls.push('http'));
    lc.onShutdown('relay', 20, async () => void calls.push('relay'));
    lc.markReady();
    expect(lc.isReady).toBe(true);
    await Promise.all([lc.shutdown(), lc.shutdown()]);
    expect(calls).toEqual(['sleep:ready=false', 'http', 'relay', 'nats']);
    expect(exitCode).toBe(0);
    expect(lc.current).toBe('stopped');
  });

  it('ошибка в хуке не прерывает остальные, код выхода 1', async () => {
    const calls: string[] = [];
    let exitCode: number | undefined;
    const lc = new Lifecycle({
      logger: pino({ level: 'silent' }),
      drainDelayMs: 0,
      timeoutMs: 1000,
      exit: (c) => void (exitCode = c),
    });
    lc.onShutdown('a', 1, () => {
      throw new Error('boom');
    });
    lc.onShutdown('b', 2, () => void calls.push('b'));
    await lc.shutdown();
    expect(calls).toEqual(['b']);
    expect(exitCode).toBe(1);
  });
});
