import { runScheduledObjectSync } from '@cc/domain';
import { ensureJobQueue, type JobQueue, type Logger } from '@cc/service-kit';
import type { Pool } from 'pg';

export const OBJECT_SYNC_QUEUE = 'worker.objects-sync';

/**
 * Синхронизация справочника объектов по расписанию (Ф13, M-ORG-06): задача pg-boss раз в минуту проверяет, наступило
 * ли время ежедневного запуска (время и включение — в админке, без перезапуска). Состояние — в журнале
 * `object_sync_run`, запуск защищён advisory lock: замена экземпляра worker посреди запуска не даёт двойной сверки.
 */
export class ObjectSyncJob {
  constructor(private readonly o: { pool: Pool; boss: JobQueue; logger: Logger; secretsKey?: string }) {}

  async start(): Promise<void> {
    const { boss, pool, logger, secretsKey } = this.o;
    await ensureJobQueue(boss, OBJECT_SYNC_QUEUE);
    await boss.work(OBJECT_SYNC_QUEUE, async () => {
      const r = await runScheduledObjectSync(pool, { secretsKey });
      if (r.status === 'skipped') return;
      const { runId, status, total, added, updated, deactivated, reactivated, skipped, error } = r;
      const summary = { runId, status, total, added, updated, deactivated, reactivated, skipped, error };
      if (status === 'ok') logger.info(summary, 'синхронизация объектов выполнена');
      else logger.warn(summary, 'синхронизация объектов не выполнена');
    });
    await boss.schedule(OBJECT_SYNC_QUEUE, '* * * * *');
  }
}
