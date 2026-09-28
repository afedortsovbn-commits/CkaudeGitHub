import { CHANNEL_SECRET_KEYS } from '@cc/contracts';
import { ensureStream, EVENTS_STREAM, type Logger, openSecret } from '@cc/service-kit';
import { DeliverPolicy, type JetStreamClient, type JetStreamManager } from 'nats';
import type { Pool } from 'pg';
import type { ZodType, ZodTypeDef } from 'zod';
import type { ChannelJournal } from './journal';

export interface ChannelInstance<T> {
  id: string;
  name: string;
  config: T;
  /** Меняется при любом изменении записи канала — по нему коннектор перезапускает обработчик канала. */
  version: string;
}

/**
 * Активные экземпляры каналов одного типа из БД (M-CH-07): добавление/выключение/изменение канала в
 * админке применяется без перезапуска — по событию config.changed и страховочной перечиткой.
 * Секреты расшифровываются здесь; некорректная конфигурация — статус «ошибка» у канала, не падение.
 */
export class ChannelRegistry<T> {
  private timer?: NodeJS.Timeout;
  private stopEvents?: () => void;
  private chain: Promise<void> = Promise.resolve();
  private pending = false;

  constructor(
    private readonly o: {
      pool: Pool;
      js: JetStreamClient;
      jsm: JetStreamManager;
      kind: string;
      schema: ZodType<T, ZodTypeDef, unknown>;
      secretsKey: string;
      reloadMs: number;
      replicas: number;
      logger: Logger;
      journal: ChannelJournal;
      onChange: (channels: ChannelInstance<T>[]) => Promise<void>;
    },
  ) {}

  async start(): Promise<void> {
    await this.reload();
    await ensureStream(this.o.jsm, { ...EVENTS_STREAM, replicas: this.o.replicas });
    const consumer = await this.o.js.consumers.get('CC_EVENTS', {
      filterSubjects: ['cc.events.config.changed'],
      deliver_policy: DeliverPolicy.New,
    });
    const messages = await consumer.consume();
    this.stopEvents = () => void messages.stop();
    void (async () => {
      for await (const m of messages) {
        const entity = (m.json<{ data?: { entity?: string } }>().data ?? {}).entity;
        if (entity === 'channel') void this.reload();
      }
    })();
    this.timer = setInterval(() => void this.reload(), this.o.reloadMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.stopEvents?.();
  }

  /** Перечитка последовательная: одновременные сигналы схлопываются в одну следующую перечитку. */
  reload(): Promise<void> {
    if (this.pending) return this.chain;
    this.pending = true;
    this.chain = this.chain.then(async () => {
      this.pending = false;
      try {
        await this.o.onChange(await this.load());
      } catch (err) {
        this.o.logger.error({ err: String(err), kind: this.o.kind }, 'ошибка перечитки каналов');
      }
    });
    return this.chain;
  }

  private async load(): Promise<ChannelInstance<T>[]> {
    const { rows } = await this.o.pool.query<{
      id: string;
      name: string;
      config: Record<string, unknown>;
      updated_at: Date;
    }>(`SELECT id, name, config, updated_at FROM channel WHERE kind = $1 AND is_active ORDER BY created_at`, [
      this.o.kind,
    ]);
    const out: ChannelInstance<T>[] = [];
    for (const r of rows) {
      const raw: Record<string, unknown> = { ...r.config };
      try {
        for (const k of CHANNEL_SECRET_KEYS)
          if (typeof raw[k] === 'string') raw[k] = openSecret(raw[k] as string, this.o.secretsKey);
      } catch {
        this.o.journal.status(
          r.id,
          'error',
          'не удалось расшифровать секреты канала (проверьте SECRETS_KEY)',
        );
        continue;
      }
      const parsed = this.o.schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        this.o.journal.status(r.id, 'error', `некорректная конфигурация: ${issues}`);
        continue;
      }
      out.push({ id: r.id, name: r.name, config: parsed.data, version: r.updated_at.toISOString() });
    }
    return out;
  }
}
