import { checkAlerts, loadStaffTelegram, processTelegramQueue, StaffTelegramApi } from '@cc/domain';
import { ensureJobQueue, type JobQueue, type Logger } from '@cc/service-kit';
import type { Pool } from 'pg';

export const ALERTS_QUEUE = 'worker.notify-alerts';

/**
 * Уведомления сотрудникам (Д-012): отправка очереди `notification` в Telegram через бота для сотрудников
 * (настройка `notify.telegram`, читается на каждом проходе — без перезапуска) и ежеминутные проверки событий
 * (минимум операторов на линии, долгое ожидание, просроченные обращения и тикеты, напоминание о смене).
 */
export class StaffNotifier {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(private readonly o: { pool: Pool; boss: JobQueue; logger: Logger; pollMs: number }) {}

  async start(): Promise<void> {
    const { boss, pool, logger } = this.o;
    await ensureJobQueue(boss, ALERTS_QUEUE);
    await boss.work(ALERTS_QUEUE, async () => {
      const r = await checkAlerts(pool);
      const n = r.belowMin + r.longWait + r.noFree + r.overdue + r.ticketOverdue + r.shifts + r.openReminders;
      if (n) {
        logger.info(r, 'уведомления о событиях поставлены в очередь');
        this.wake?.();
      }
    });
    await boss.schedule(ALERTS_QUEUE, '* * * * *');
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { pool, logger, pollMs } = this.o;
    while (this.running) {
      try {
        const s = await loadStaffTelegram(pool);
        if (s.botToken) {
          const api = new StaffTelegramApi(s.botToken, s.apiRoot);
          const n = await processTelegramQueue(pool, {
            shouldStop: () => !this.running,
            send: async (chatId, text) => {
              await api.sendMessage(chatId, text);
            },
          });
          if (n) logger.info({ sent: n }, 'уведомления отправлены в Telegram');
        }
      } catch (err) {
        logger.error({ err: String(err) }, 'ошибка отправки уведомлений в Telegram');
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        this.wake = () => (clearTimeout(t), resolve());
      });
    }
  }
}
