import { INTEGRATION_SUBJECT, type IntegrationReply, IntegrationRequestSchema } from '@cc/contracts';
import type { Logger } from '@cc/service-kit';
import type { NatsConnection } from 'nats';
import type { Pool } from 'pg';
import { executeOperation } from './integrations';

/**
 * Приём запросов интеграционных операций от call-control (узел IVR) и worker (боты): группа очереди `api` —
 * запрос обрабатывает один экземпляр. При остановке новые запросы перестают приниматься (drain подписки,
 * NATS отдаст их другому экземпляру), начатые — завершаются.
 */
export function serveIntegrations(
  nc: NatsConnection,
  deps: { pool: Pool; secretsKey?: string; logger: Logger },
): { stop(): Promise<void> } {
  const inflight = new Set<Promise<void>>();
  const sub = nc.subscribe(INTEGRATION_SUBJECT, {
    queue: 'api',
    callback: (err, msg) => {
      if (err) return;
      const p = (async () => {
        let reply: IntegrationReply;
        try {
          const req = IntegrationRequestSchema.parse(msg.json());
          const r = await executeOperation(deps, req);
          // Ответ внешней системы наружу не передаём — только выходы по маппингу.
          reply = {
            ok: r.ok,
            outputs: r.outputs,
            error: r.error,
            httpStatus: r.httpStatus,
            durationMs: r.durationMs,
          };
        } catch (e) {
          reply = { ok: false, outputs: {}, error: `Некорректный запрос: ${String(e)}`, durationMs: 0 };
        }
        msg.respond(JSON.stringify(reply));
      })().finally(() => inflight.delete(p));
      inflight.add(p);
    },
  });
  return {
    async stop() {
      await sub.drain();
      await Promise.all([...inflight]);
    },
  };
}
