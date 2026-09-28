import PgBoss from 'pg-boss';
import type { Logger } from 'pino';

export type JobQueue = PgBoss;

export interface JobQueueOptions {
  connectionString: string;
  logger: Logger;
  /** Отдельная схема БД для служебных таблиц pg-boss (не пересекается со схемой продукта). */
  schema?: string;
}

/**
 * Очередь фоновых задач на PostgreSQL (pg-boss, 02-архитектура — «Фоновые задачи и таймеры»):
 * таймауты принятия оператором, перелив, эскалация и другие срочные действия переживают
 * перезапуск/замену любого экземпляра сервиса (состояние — в БД, не в памяти процесса).
 * Собственная схема создаётся и обновляется самим pg-boss при первом запуске.
 */
export async function createJobQueue(opts: JobQueueOptions): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: opts.connectionString, schema: opts.schema ?? 'pgboss' });
  boss.on('error', (err) => opts.logger.error({ err: String(err) }, 'ошибка очереди задач (pg-boss)'));
  await boss.start();
  return boss;
}

/** Идемпотентно создаёт очередь задач (не ошибка, если уже существует). */
export async function ensureJobQueue(boss: PgBoss, name: string): Promise<void> {
  await boss.createQueue(name).catch((e: unknown) => {
    if (!String(e).includes('already exists')) throw e;
  });
}
