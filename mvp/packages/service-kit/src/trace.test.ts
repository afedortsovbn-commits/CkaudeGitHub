import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { enqueueEvent } from './outbox';
import { correlationIdFrom, currentCorrelationId, withCorrelation } from './trace';

describe('correlation-id (M-NFR-04)', () => {
  it('идентификатор из заголовка принимается, недопустимый заменяется новым', () => {
    expect(correlationIdFrom('req-123_a.b:c')).toBe('req-123_a.b:c');
    expect(correlationIdFrom('плохой id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('виден в асинхронной цепочке обработки и попадает в строки журнала', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(c, _e, cb) {
        lines.push(String(c));
        cb();
      },
    });
    const log = createLogger({ service: 't', version: '1', stream });
    await withCorrelation('corr-1', async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(currentCorrelationId()).toBe('corr-1');
      log.info('внутри');
    });
    log.info('снаружи');
    expect(JSON.parse(lines[0]!).correlationId).toBe('corr-1');
    expect(JSON.parse(lines[1]!).correlationId).toBeUndefined();
  });
  it('traceId события — correlation-id обработки, явный traceId сохраняется', async () => {
    const calls: unknown[][] = [];
    const tx = { query: async (_sql: string, params: unknown[]) => void calls.push(params) } as never;
    const ev = {
      id: 'e1',
      type: 'a.b',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 's',
      data: {},
    };
    await withCorrelation('corr-2', () => enqueueEvent(tx, ev));
    expect(calls[0]![5]).toBe('corr-2');
    expect((calls[1]![2] as { traceId: string }).traceId).toBe('corr-2');
    await withCorrelation('corr-3', () => enqueueEvent(tx, { ...ev, traceId: 'own' }));
    expect(calls[2]![5]).toBe('own');
  });
});
