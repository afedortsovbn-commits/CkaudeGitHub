import { DeliveryStatusSchema } from '@cc/contracts';
import { applyDeliveryStatus } from '@cc/domain';
import type { Logger } from '@cc/service-kit';
import { AckPolicy, type Consumer, type JetStreamClient, type JetStreamManager, type JsMsg } from 'nats';
import type { Pool } from 'pg';

const CONSUMER = 'worker-delivery';

/**
 * Статусы доставки исходящих от коннекторов (cc.delivery.>) → message.delivery_status и событие для
 * рабочего места оператора. Durable-потребитель общий для всех экземпляров worker; подтверждение — после
 * фиксации транзакции, повтор безопасен (applyDeliveryStatus идемпотентен).
 */
export class DeliveryProcessor {
  private running = false;
  private loop?: Promise<void>;
  private consumer?: Consumer;

  constructor(
    private readonly o: { pool: Pool; js: JetStreamClient; jsm: JetStreamManager; logger: Logger },
  ) {}

  async start(): Promise<void> {
    await this.o.jsm.consumers
      .add('CC_OUTBOUND', {
        durable_name: CONSUMER,
        filter_subject: 'cc.delivery.>',
        ack_policy: AckPolicy.Explicit,
        ack_wait: 30_000_000_000,
        max_deliver: 20,
      })
      .catch((e: unknown) => {
        if (!String(e).includes('already')) throw e;
      });
    this.consumer = await this.o.js.consumers.get('CC_OUTBOUND', CONSUMER);
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const batch = await this.consumer!.fetch({ max_messages: 50, expires: 1000 });
        for await (const m of batch) {
          await this.handle(m);
          if (!this.running) break;
        }
      } catch (err) {
        this.o.logger.warn({ err: String(err) }, 'ошибка чтения статусов доставки, повтор');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  private async handle(m: JsMsg): Promise<void> {
    const parsed = DeliveryStatusSchema.safeParse(m.json());
    if (!parsed.success) {
      this.o.logger.error({ subject: m.subject }, 'некорректный статус доставки — отброшен');
      m.term();
      return;
    }
    const client = await this.o.pool.connect();
    try {
      await client.query('BEGIN');
      await applyDeliveryStatus(client, parsed.data);
      await client.query('COMMIT');
      m.ack();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.o.logger.error({ err: String(err), messageId: parsed.data.messageId }, 'ошибка статуса доставки');
      m.nak(Math.min(1000 * 2 ** m.info.redeliveryCount, 30_000));
    } finally {
      client.release();
    }
  }
}
