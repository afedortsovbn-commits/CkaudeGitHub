import type { ChannelInstance, ChannelJournal, ConnectorStorage } from '@cc/connector-kit';
import { publishInbound } from '@cc/connector-kit';
import { newId, type TelegramChannelConfig } from '@cc/contracts';
import type { KvLease, Logger } from '@cc/service-kit';
import type { JetStreamClient, KV } from 'nats';
import { TelegramApi, type TgUpdate } from './telegram-api';
import { parseUpdate } from './updates';

const POLL_TIMEOUT_S = 20;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Один экземпляр канала Telegram (бот). Режим polling: getUpdates ведёт только владелец аренды (два
 * опроса одного токена дают 409), смещение хранится в NATS KV — новый владелец продолжает с того же места;
 * повторно полученные обновления отсекаются уникальным ключом сообщения в БД. Режим webhook: обновления
 * принимают все экземпляры (HTTP), владелец аренды лишь регистрирует адрес webhook в Telegram.
 */
export class BotRunner {
  readonly api: TelegramApi;
  private readonly abort = new AbortController();
  private loop?: Promise<void>;

  constructor(
    readonly channel: ChannelInstance<TelegramChannelConfig>,
    private readonly o: {
      js: JetStreamClient;
      lease: KvLease;
      offsets: KV;
      storage: ConnectorStorage;
      journal: ChannelJournal;
      logger: Logger;
      publicBaseUrl?: string;
    },
  ) {
    this.api = new TelegramApi(channel.config.bot_token, channel.config.api_root);
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
    await this.o.lease.release();
  }

  /** Обновление → CC_INBOUND. Подтверждать Telegram (200 / следующий offset) — только после этого. */
  async handleUpdate(u: TgUpdate): Promise<void> {
    const p = parseUpdate(u, this.channel.id);
    if (!p) return;
    const attachments = [];
    for (const f of p.files) {
      const body = await this.api.download(f.fileId);
      const saved = await this.o.storage.saveInbound({
        filename: f.filename,
        contentType: f.contentType,
        body,
      });
      if (saved) attachments.push(saved);
    }
    await publishInbound(this.o.js, {
      id: newId(),
      channelId: this.channel.id,
      channelKind: 'telegram',
      externalId: p.externalId,
      identity: { kind: 'telegram', value: p.chatId },
      contact: p.displayName ? { displayName: p.displayName } : undefined,
      body: p.body,
      attachments,
      receivedAt: Date.now(),
    });
    this.o.journal.log(
      this.channel.id,
      'in',
      attachments.length ? `сообщение, файлов: ${attachments.length}` : 'сообщение',
    );
  }

  private async run(): Promise<void> {
    const { id, config } = this.channel;
    const signal = this.abort.signal;
    let prepared = false;
    while (!signal.aborted) {
      try {
        if (!(await this.o.lease.refresh())) {
          await sleep(3000, signal);
          continue;
        }
        if (config.mode === 'webhook') {
          if (!prepared) {
            if (!this.o.publicBaseUrl || !config.webhook_secret)
              throw new Error('для режима webhook нужны PUBLIC_BASE_URL коннектора и секрет webhook канала');
            await this.api.setWebhook(`${this.o.publicBaseUrl}/tg/${id}`, config.webhook_secret);
            prepared = true;
          }
          this.o.journal.status(id, 'connected', 'webhook');
          await sleep(10_000, signal);
          continue;
        }
        if (!prepared) {
          await this.api.deleteWebhook();
          prepared = true;
        }
        const offset = Number((await this.o.offsets.get(id))?.string() || 0);
        const updates = await this.api.getUpdates(offset, POLL_TIMEOUT_S, signal);
        for (const u of updates) await this.handleUpdate(u);
        if (updates.length) await this.o.offsets.put(id, String(updates.at(-1)!.update_id + 1));
        this.o.journal.status(id, 'connected', 'polling');
      } catch (err) {
        if (signal.aborted) break;
        this.o.logger.warn({ err: String(err), channelId: id }, 'ошибка канала Telegram');
        this.o.journal.status(id, 'error', String(err).slice(0, 300));
        await sleep(5000, signal);
      }
    }
  }
}
