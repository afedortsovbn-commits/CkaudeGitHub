import { readFile, statfs } from 'node:fs/promises';
import { cpus } from 'node:os';
import {
  checkBreaks,
  pruneOutbox,
  remindTestDeadlines,
  type ResourceProbe,
  runResourceCheck,
} from '@cc/domain';
import { ensureJobQueue, type JobQueue, type Logger } from '@cc/service-kit';
import type { Pool } from 'pg';

export const RESOURCE_QUEUE = 'worker.resources';
export const HOUSEKEEPING_QUEUE = 'worker.housekeeping';
export const BREAKS_QUEUE = 'worker.breaks';
/** Напоминания о сроке тестов сотрудников (раз в день после времени ежедневной рассылки). */
export const TESTS_QUEUE = 'worker.test-deadlines';

/** Замер диска, памяти, подкачки и процессора сервера изнутри контейнера (диск — тот, где данные Docker). */
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
    if (kb('SwapTotal')) p.swap = { totalBytes: kb('SwapTotal'), freeBytes: kb('SwapFree') };
  } catch {
    /* не Linux */
  }
  try {
    // Средняя загрузка — по всему серверу (в контейнере /proc/loadavg не изолирован), ядра — сервера.
    const [, load5] = (await readFile('/proc/loadavg', 'utf8')).split(' ').map(Number);
    if (Number.isFinite(load5)) p.cpu = { load5: load5!, cores: cpus().length || 1 };
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
    // Тесты сотрудников: за 3 дня до срока и каждый день просрочки — сотруднику и супервизорам в колокольчик.
    await ensureJobQueue(boss, TESTS_QUEUE);
    await boss.work(TESTS_QUEUE, async () => {
      const r = await remindTestDeadlines(pool);
      if (r.operators || r.managers) logger.info(r, 'напоминания о сроке тестов отправлены');
    });
    await boss.schedule(TESTS_QUEUE, '*/10 * * * *');
  }
}
