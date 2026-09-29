import { parseEvent } from '@cc/contracts';
import { type DeliveryOptions, fanOutEvent, processWebhookQueue } from '@cc/domain';
import type { Logger } from '@cc/service-kit';
import {
  AckPolicy,
  type Consumer,
  DeliverPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
} from 'nats';
import type { Pool } from 'pg';

const CONSUMER = 'worker-webhooks';

/**
 * Webhooks в worker (Ф9, M-INT-02): 1) durable-потребитель потока событий CC_EVENTS (общий для всех
 * экземпляров) раскладывает событие по подпискам — строки `webhook_delivery`, подтверждение после записи;
 * 2) цикл доставки отправляет накопленное с подписью HMAC, повторами и журналом. Состояние — только в БД:
 * остановка экземпляра посреди доставки не теряет и не дублирует (аренда строки истекает, строку берёт другой).
 */
export class WebhookProcessor {
  private running = false;
  private consumeLoop?: Promise<void>;
  private sendLoop?: Promise<void>;
  private consumer?: Consumer;
  private wake?: () => void;

  constructor(
    private readonly o: {
      pool: Pool;
      js: JetStreamClient;
      jsm: JetStreamManager;
      logger: Logger;
      pollMs: number;
      delivery: DeliveryOptions;
    },
  ) {}

  async start(): Promise<void> {
    await this.o.jsm.consumers
      .add('CC_EVENTS', {
        durable_name: CONSUMER,
        ack_policy: AckPolicy.Explicit,
        ack_wait: 30_000_000_000,
        max_deliver: 50,
        // История событий до появления потребителя (первый запуск Ф9) подписчикам не нужна.
        deliver_policy: DeliverPolicy.New,
      })
      .catch((e: unknown) => {
        if (!String(e).includes('already')) throw e;
      });
    this.consumer = await this.o.js.consumers.get('CC_EVENTS', CONSUMER);
    this.running = true;
    this.consumeLoop = this.consume();
    this.sendLoop = this.send();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await Promise.all([this.consumeLoop, this.sendLoop]);
  }

  private async consume(): Promise<void> {
    while (this.running) {
      try {
        const batch = await this.consumer!.fetch({ max_messages: 100, expires: 1000 });
        let n = 0;
        for await (const m of batch) {
          n += await this.handle(m);
          if (!this.running) break;
        }
        if (n) this.wake?.();
      } catch (err) {
        this.o.logger.warn({ err: String(err) }, 'ошибка чтения потока CC_EVENTS (webhooks), повтор');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  private async handle(m: JsMsg): Promise<number> {
    let e;
    try {
      e = parseEvent(m.json());
    } catch {
      m.term();
      return 0;
    }
    try {
      const n = await fanOutEvent(this.o.pool, e);
      m.ack();
      return n;
    } catch (err) {
      this.o.logger.error(
        { err: String(err), event: e.id },
        'webhooks: не удалось разложить событие, повтор',
      );
      m.nak(Math.min(1000 * 2 ** m.info.redeliveryCount, 30_000));
      return 0;
    }
  }

  private async send(): Promise<void> {
    while (this.running) {
      try {
        await processWebhookQueue(this.o.pool, { ...this.o.delivery, shouldStop: () => !this.running });
      } catch (err) {
        this.o.logger.error({ err: String(err) }, 'ошибка обработки очереди webhooks');
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.o.pollMs);
        this.wake = () => (clearTimeout(t), resolve());
      });
    }
  }
}
