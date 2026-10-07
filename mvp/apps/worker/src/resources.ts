import { readFile, statfs } from 'node:fs/promises';
import { checkBreaks, pruneOutbox, type ResourceProbe, runResourceCheck } from '@cc/domain';
import { ensureJobQueue, type JobQueue, type Logger } from '@cc/service-kit';
import type { Pool } from 'pg';

export const RESOURCE_QUEUE = 'worker.resources';
export const HOUSEKEEPING_QUEUE = 'worker.housekeeping';
export const BREAKS_QUEUE = 'worker.breaks';

/** Замер диска и памяти сервера изнутри контейнера: диск — тот, на котором Docker хранит данные. */
export async function probeResources(diskPath = '/'): Promise<ResourceProbe> {
  const p: ResourceProbe = {};
  try {
    const s = await statfs(diskPath);
    p.disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    /* нет замера — показатель просто не выводится */
  }
  try {
    const m = await readFile('/proc/meminfo', 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(m)?.[1] ?? 0) * 1024;
    if (kb('MemTotal')) p.memory = { totalBytes: kb('MemTotal'), availableBytes: kb('MemAvailable') };
  } catch {
    /* не Linux */
  }
  return p;
}

/**
 * Контроль ресурсов (каждые 5 минут) и ночная чистка служебной очереди outbox (отправленные старше 30 дней).
 * Журнал событий, записи разговоров и прочие данные здесь не удаляются.
 */
export class ResourceMonitor {
  constructor(private readonly o: { pool: Pool; boss: JobQueue; logger: Logger; diskPath?: string }) {}

  async start(): Promise<void> {
    const { boss, pool, logger } = this.o;
    await ensureJobQueue(boss, RESOURCE_QUEUE);
    await boss.work(RESOURCE_QUEUE, async () => {
      const r = await runResourceCheck(pool, await probeResources(this.o.diskPath));
      const bad = r.samples.filter((s) => s.level !== 'ok');
      if (bad.length) logger.warn({ resources: bad, notified: r.notified }, 'ресурсы сервера на пределе');
    });
    await boss.schedule(RESOURCE_QUEUE, '*/5 * * * *');
    await ensureJobQueue(boss, HOUSEKEEPING_QUEUE);
    await boss.work(HOUSEKEEPING_QUEUE, async () => {
      const n = await pruneOutbox(pool, 30);
      if (n) logger.info({ deleted: n }, 'очередь outbox очищена от отправленных событий старше 30 дней');
    });
    await boss.schedule(HOUSEKEEPING_QUEUE, '40 3 * * *');
    // Контроль перерывов по графику: не ушёл на перерыв / не вернулся — уведомление супервизорам.
    await ensureJobQueue(boss, BREAKS_QUEUE);
    await boss.work(BREAKS_QUEUE, async () => {
      const r = await checkBreaks(pool);
      if (r.lateStart || r.lateEnd) logger.info(r, 'нарушение перерывов по графику — уведомлены супервизоры');
    });
    await boss.schedule(BREAKS_QUEUE, '* * * * *');
  }
}
