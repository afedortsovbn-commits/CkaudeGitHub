import {
  type DeliveryStatus,
  deliverySubject,
  type InboundMessage,
  InboundMessageSchema,
  inboundSubject,
  type OutboundMessage,
  OutboundMessageSchema,
  outboundSubject,
} from '@cc/contracts';
import type { Logger } from '@cc/service-kit';
import {
  AckPolicy,
  type Consumer,
  headers,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  type KV,
} from 'nats';
import type { ChannelJournal } from './journal';

/** Ошибка, повтор которой бессмыслен (клиент заблокировал бота, неверный адрес) — сразу «не доставлено». */
export class PermanentError extends Error {}

/**
 * Входящее канала → поток CC_INBOUND. Подтверждать каналу (Telegram 200 OK, флаг IMAP) — только после
 * этого вызова: сообщение уже сохранено в JetStream (R3) и дойдёт до worker (02-архитектура 6.2 п.5).
 */
export async function publishInbound(js: JetStreamClient, msg: InboundMessage): Promise<void> {
  const m = InboundMessageSchema.parse(msg);
  const id = `${m.channelKind}:${m.externalId}`;
  const h = headers();
  h.set('Nats-Msg-Id', id);
  await js.publish(inboundSubject(m.channelKind), JSON.stringify(m), { msgID: id, headers: h, timeout: 5000 });
}

/**
 * Доставка исходящих коннектором (M-CH-08): durable-потребитель cc.outbound.<kind>, общий для всех
 * экземпляров коннектора. Защита от повторной отправки при повторной доставке из потока — отметка в
 * NATS KV после успешной отправки (окно дубля — только сбой процесса между отправкой и отметкой).
 * При остановке текущая отправка завершается и подтверждается — поэтапное обновление не дублирует.
 */
export class OutboundWorker {
  private running = false;
  private loop?: Promise<void>;
  private consumer?: Consumer;

  constructor(
    private readonly o: {
      js: JetStreamClient;
      jsm: JetStreamManager;
      kind: string;
      sent: KV;
      maxAttempts: number;
      logger: Logger;
      journal: ChannelJournal;
      send: (m: OutboundMessage) => Promise<{ externalId: string | null }>;
    },
  ) {}

  async start(): Promise<void> {
    const durable = `connector-${this.o.kind}-outbound`;
    await this.o.jsm.consumers
      .add('CC_OUTBOUND', {
        durable_name: durable,
        filter_subject: outboundSubject(this.o.kind),
        ack_policy: AckPolicy.Explicit,
        ack_wait: 60_000_000_000,
        max_deliver: this.o.maxAttempts + 2,
      })
      .catch((e: unknown) => {
        if (!String(e).includes('already')) throw e;
      });
    this.consumer = await this.o.js.consumers.get('CC_OUTBOUND', durable);
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
        const batch = await this.consumer!.fetch({ max_messages: 10, expires: 1000 });
        for await (const m of batch) {
          await this.handle(m);
          if (!this.running) break;
        }
      } catch (err) {
        this.o.logger.warn({ err: String(err) }, 'ошибка чтения исходящих, повтор');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  private async status(msg: OutboundMessage, s: Omit<DeliveryStatus, 'messageId' | 'channelId' | 'at'>) {
    const payload: DeliveryStatus = { ...s, messageId: msg.messageId, channelId: msg.channelId, at: Date.now() };
    await this.o.js.publish(deliverySubject(this.o.kind), JSON.stringify(payload), {
      msgID: `${msg.messageId}:${s.status}`,
      timeout: 5000,
    });
  }

  private async handle(m: JsMsg): Promise<void> {
    const parsed = OutboundMessageSchema.safeParse(m.json());
    if (!parsed.success) {
      this.o.logger.error({ subject: m.subject }, 'некорректное исходящее — отброшено');
      m.term();
      return;
    }
    const msg = parsed.data;
    try {
      const done = await this.o.sent.get(msg.messageId);
      if (done?.value.length) {
        const prev = JSON.parse(done.string()) as { externalId: string | null };
        await this.status(msg, { status: 'sent', externalId: prev.externalId, error: null });
        m.ack();
        return;
      }
      const r = await this.o.send(msg);
      await this.o.sent.put(msg.messageId, JSON.stringify(r));
      await this.status(msg, { status: 'sent', externalId: r.externalId, error: null });
      this.o.journal.log(msg.channelId, 'out', 'сообщение доставлено');
      m.ack();
    } catch (err) {
      const attempt = m.info.redeliveryCount;
      const final = err instanceof PermanentError || attempt >= this.o.maxAttempts;
      this.o.logger.warn({ err: String(err), messageId: msg.messageId, attempt, final }, 'не удалось доставить');
      if (!final) {
        m.nak(Math.min(1000 * 2 ** attempt, 60_000));
        return;
      }
      try {
        await this.status(msg, { status: 'failed', externalId: null, error: String(err).slice(0, 300) });
        this.o.journal.log(msg.channelId, 'out', `не доставлено: ${String(err).slice(0, 200)}`, false);
        m.ack();
      } catch {
        m.nak(5000);
      }
    }
  }
}
