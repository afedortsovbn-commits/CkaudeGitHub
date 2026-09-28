import { describe, expect, it } from 'vitest';
import { loadConfig, natsServers } from './config';

describe('конфигурация', () => {
  it('применяет значения по умолчанию', () => {
    const c = loadConfig(undefined, { SERVICE_NAME: 'api' });
    expect(c.PORT).toBe(3000);
    expect(c.SHUTDOWN_DRAIN_DELAY_MS).toBe(3000);
    expect(c.OUTBOX_RELAY_ENABLED).toBe(true);
  });
  it('понятная ошибка при отсутствии обязательного', () => {
    expect(() => loadConfig(undefined, {})).toThrow(/SERVICE_NAME/);
  });
  it('разбирает список серверов NATS', () => {
    expect(natsServers({ NATS_SERVERS: 'nats://a:4222, nats://b:4222' })).toEqual([
      'nats://a:4222',
      'nats://b:4222',
    ]);
  });
});
