import { HttpException } from '@nestjs/common';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createMetrics, Lifecycle } from '@cc/service-kit';
import type { AppContext } from './context';
import { HealthController } from './health.controller';

function ctx() {
  const lifecycle = new Lifecycle({
    logger: pino({ level: 'silent' }),
    drainDelayMs: 0,
    timeoutMs: 1000,
    exit: () => undefined,
  });
  return { lifecycle, metrics: createMetrics('test') } as unknown as AppContext;
}

describe('HealthController', () => {
  it('readyz: 503 при запуске, 200 после готовности, 503 во время остановки', async () => {
    const c = ctx();
    const h = new HealthController(c);
    expect(() => h.readyz()).toThrow(HttpException);
    c.lifecycle.markReady();
    expect(h.readyz()).toEqual({ status: 'ready' });
    const stopping = c.lifecycle.shutdown();
    expect(() => h.readyz()).toThrow(HttpException);
    expect(h.healthz()).toEqual({ status: 'ok' });
    await stopping;
    expect(() => h.healthz()).toThrow(HttpException);
  });

  it('metrics отдаёт текст Prometheus', async () => {
    const text = await new HealthController(ctx()).metrics();
    expect(text).toContain('process_cpu_user_seconds_total');
  });
});
