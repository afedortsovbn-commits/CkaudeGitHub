import { describe, expect, it } from 'vitest';
import { isTransientJsError, retryJs } from './nats';

describe('JetStream: повтор при неготовом кластере', () => {
  it('TIMEOUT и 503 — временные, прочие ошибки — нет', () => {
    expect(isTransientJsError(new Error('NatsError: TIMEOUT'))).toBe(true);
    expect(isTransientJsError(new Error('503'))).toBe(true);
    expect(isTransientJsError(new Error('stream name already in use with a different configuration'))).toBe(
      false,
    );
  });

  it('повторяет временную ошибку и отдаёт результат; постоянную — сразу', async () => {
    let n = 0;
    const r = await retryJs(async () => {
      if (++n < 3) throw new Error('NatsError: TIMEOUT');
      return 'ok';
    }, 10_000);
    expect(r).toBe('ok');
    expect(n).toBe(3);
    await expect(retryJs(async () => Promise.reject(new Error('bad config')), 10_000)).rejects.toThrow(
      'bad config',
    );
  });
});
