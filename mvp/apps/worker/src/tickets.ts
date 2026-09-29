import { ensureJobQueue, type JobQueue, type Logger } from '@cc/service-kit';
import { processEmailQueue, runDailyDigest } from '@cc/domain';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Pool } from 'pg';
import { buildMessage, type MailSettings } from './mail';

export const DIGEST_QUEUE = 'worker.ticket-digest';

export interface SmtpOptions {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  tlsInsecure: boolean;
  mail: MailSettings;
}

/**
 * 2-я линия в worker (Ф8): ежедневная рассылка сроков и напоминаний согласующим (pg-boss по расписанию,
 * раз в минуту проверяет «наступило ли время рассылки» — оно настраивается в админке без перезапуска) и отправка
 * писем из очереди `notification` через SMTP заказчика. Состояние — только в БД: остановка или замена экземпляра
 * посреди рассылки не даёт ни дублей, ни пропусков.
 */
export class TicketMailer {
  private running = false;
  private loop?: Promise<void>;
  private transport?: Transporter;
  private wake?: () => void;

  constructor(
    private readonly o: { pool: Pool; boss: JobQueue; logger: Logger; smtp: SmtpOptions; pollMs: number },
  ) {
    if (o.smtp.host) {
      this.transport = nodemailer.createTransport({
        host: o.smtp.host,
        port: o.smtp.port,
        secure: o.smtp.secure,
        auth: o.smtp.user ? { user: o.smtp.user, pass: o.smtp.password ?? '' } : undefined,
        tls: { rejectUnauthorized: !o.smtp.tlsInsecure },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
    }
  }

  async start(): Promise<void> {
    const { boss, pool, logger } = this.o;
    await ensureJobQueue(boss, DIGEST_QUEUE);
    await boss.work(DIGEST_QUEUE, async () => {
      const r = await runDailyDigest(pool);
      if (!r.skipped) logger.info(r, 'ежедневная рассылка по тикетам поставлена в очередь писем');
      this.wake?.();
    });
    await boss.schedule(DIGEST_QUEUE, '* * * * *');
    if (!this.transport) {
      logger.warn('SMTP_HOST не задан: письма по тикетам копятся в очереди и не отправляются');
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.transport?.close();
  }

  /** Немедленно обработать очередь (после ежедневной постановки). */
  private async run(): Promise<void> {
    const { pool, logger, pollMs, smtp } = this.o;
    while (this.running) {
      try {
        const n = await processEmailQueue(pool, {
          shouldStop: () => !this.running,
          send: async (mail) => {
            await this.transport!.sendMail(buildMessage(mail, smtp.mail));
          },
        });
        if (n) logger.info({ sent: n }, 'письма по тикетам отправлены');
      } catch (err) {
        logger.error({ err: String(err) }, 'ошибка обработки очереди писем');
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        this.wake = () => (clearTimeout(t), resolve());
      });
    }
  }
}
