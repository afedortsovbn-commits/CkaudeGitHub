import { type ChannelInstance, type ChannelJournal, publishInbound } from '@cc/connector-kit';
import { newId, type RocketDataChannelConfig } from '@cc/contracts';
import type { KvLease, Logger } from '@cc/service-kit';
import type { JetStreamClient, KV } from 'nats';
import { RocketDataApi } from './rocketdata-api';
import { reviewToInbound } from './reviews';

/** Отзывы, изменённые чуть раньше запомненной отметки, запрашиваются повторно (часы источника, запись «задним числом»). */
const OVERLAP_MS = 5 * 60_000;
/** Аренда (TTL 45 с) продлевается во время паузы между опросами не реже этого. */
const LEASE_TICK_MS = 10_000;
const MAX_PAGES = 200;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

interface PollState {
  /** Отметка «изменены начиная с» для следующего опроса (ISO). */
  since: string;
}

/**
 * Один экземпляр канала «Отзыв» (подключение к Rocket Data). Опрос ведёт только владелец аренды `rd.<id канала>`
 * (02-архитектура 2.2: 2 экземпляра коннектора, опрос — у владельца); отметка последнего опроса — в NATS KV
 * `cc_rd_state`: новый владелец продолжает с того же места. Отметка сдвигается только после записи всех отзывов
 * страницы в CC_INBOUND; повторно полученные отзывы отсекаются ключом сообщения (JetStream и БД).
 */
export class ReviewPoller {
  readonly api: RocketDataApi;
  private readonly abort = new AbortController();
  private loop?: Promise<void>;

  constructor(
    readonly channel: ChannelInstance<RocketDataChannelConfig>,
    private readonly o: {
      js: JetStreamClient;
      lease: KvLease;
      state: KV;
      journal: ChannelJournal;
      logger: Logger;
    },
  ) {
    this.api = new RocketDataApi(channel.config.api_url, channel.config.api_token);
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
    await this.o.lease.release();
  }

  private async readState(): Promise<PollState> {
    const e = await this.o.state.get(this.channel.id);
    if (e?.value.length) {
      try {
        return JSON.parse(e.string()) as PollState;
      } catch {
        /* повреждённая отметка — как при первом подключении */
      }
    }
    const days = this.channel.config.initial_days;
    return { since: new Date(Date.now() - days * 86_400_000).toISOString() };
  }

  /** Один проход: все страницы отзывов с отметки; возвращает число переданных в систему. */
  async pollOnce(signal: AbortSignal): Promise<number> {
    const { id } = this.channel;
    const state = await this.readState();
    const startedAt = Date.now();
    let cursor: string | null = null;
    let maxUpdated = Date.parse(state.since);
    let n = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.api.reviews(state.since, cursor);
      for (const bad of r.invalid) this.o.journal.log(id, 'in', `некорректный отзыв пропущен: ${bad}`, false);
      for (const review of r.items) {
        await publishInbound(this.o.js, {
          id: newId(),
          receivedAt: Date.now(),
          ...reviewToInbound(review, this.channel),
        });
        maxUpdated = Math.max(maxUpdated, Date.parse(review.updated_at));
        n++;
        // При остановке — дочитываем текущую страницу не дальше текущего отзыва: отметка не сдвигается, следующий
        // владелец аренды повторит страницу (дубли отсекаются ключом сообщения).
        if (signal.aborted) return n;
      }
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    // Следующий опрос — с последнего изменения (с запасом), но не позже начала этого прохода.
    const next = Math.min(maxUpdated, startedAt) - OVERLAP_MS;
    const since = new Date(Math.max(next, Date.parse(state.since))).toISOString();
    await this.o.state.put(id, JSON.stringify({ since } satisfies PollState));
    if (n) this.o.journal.log(id, 'in', `загружено отзывов: ${n}`);
    return n;
  }

  private async run(): Promise<void> {
    const { id, config } = this.channel;
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        if (!(await this.o.lease.refresh())) {
          await sleep(3000, signal);
          continue;
        }
        await this.pollOnce(signal);
        this.o.journal.status(id, 'connected', `опрос раз в ${config.poll_interval_s} с`);
        // Пауза до следующего опроса с продлением аренды.
        const until = Date.now() + config.poll_interval_s * 1000;
        while (!signal.aborted && Date.now() < until) {
          await sleep(Math.min(LEASE_TICK_MS, until - Date.now()), signal);
          if (!signal.aborted && !(await this.o.lease.refresh())) break;
        }
      } catch (err) {
        if (signal.aborted) break;
        this.o.logger.warn({ err: String(err), channelId: id }, 'ошибка опроса Rocket Data');
        this.o.journal.status(id, 'error', String(err).slice(0, 300));
        await sleep(Math.min(30_000, config.poll_interval_s * 1000), signal);
      }
    }
  }
}
