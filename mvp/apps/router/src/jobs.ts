import { ensureJobQueue, type Logger } from '@cc/service-kit';
import type PgBoss from 'pg-boss';
import type { Pool } from 'pg';
import { handleOfferTimeout } from './assign';

export const OFFER_TIMEOUT_QUEUE = 'router.offer-timeout';

/** Регистрирует и обрабатывает задачу таймаута принятия оператором (M-RT-05). */
export async function registerJobs(boss: PgBoss, pool: Pool, logger: Logger): Promise<void> {
  await ensureJobQueue(boss, OFFER_TIMEOUT_QUEUE);
  await boss.work<{ conversationId: string; offerId: string }>(OFFER_TIMEOUT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        await handleOfferTimeout(pool, job.data);
      } catch (err) {
        logger.error({ err: String(err), jobId: job.id }, 'ошибка обработки таймаута предложения');
        throw err; // pg-boss повторит задачу согласно политике очереди
      }
    }
  });
}

/** Заводит задачу «если оператор за offerTimeoutS не ответил — вернуть обращение в очередь». */
export async function scheduleOfferTimeout(
  boss: PgBoss,
  data: { conversationId: string; offerId: string },
  offerTimeoutS: number,
): Promise<void> {
  await boss.send(OFFER_TIMEOUT_QUEUE, data, { startAfter: offerTimeoutS });
}
