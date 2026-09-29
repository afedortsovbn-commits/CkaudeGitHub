import { retryJs } from './nats';
import type { KV } from 'nats';

/**
 * Аренда (lease) в NATS KV: ровно один экземпляр сервиса владеет ресурсом (опрос почтового ящика,
 * long-polling Telegram-бота — два getUpdates на один токен дают 409 Conflict). Бакет создаётся с TTL:
 * если владелец упал, ключ истекает и ресурс забирает другой экземпляр (02-архитектура 2.2).
 * Захват и продление — CAS по ревизии (`create` / `update`), поэтому двух владельцев не бывает.
 */
export class KvLease {
  private revision: number | null = null;

  constructor(
    private readonly kv: KV,
    readonly key: string,
    private readonly owner: string,
  ) {}

  get held(): boolean {
    return this.revision !== null;
  }

  /** Захватить или продлить; true — экземпляр владеет ресурсом после вызова. */
  async refresh(): Promise<boolean> {
    try {
      this.revision =
        this.revision === null
          ? await this.kv.create(this.key, this.owner)
          : await this.kv.update(this.key, this.owner, this.revision);
      return true;
    } catch {
      this.revision = null;
      return false;
    }
  }

  /** Отдать ресурс при корректной остановке — другой экземпляр подхватит без ожидания TTL. */
  async release(): Promise<void> {
    if (this.revision === null) return;
    const rev = this.revision;
    this.revision = null;
    await this.kv.delete(this.key, { previousSeq: rev }).catch(() => undefined);
  }
}

/** Бакет аренд; TTL — через сколько истекает аренда упавшего владельца. */
export async function leaseBucket(
  js: import('nats').JetStreamClient,
  name: string,
  ttlMs: number,
  replicas: number,
): Promise<KV> {
  return retryJs(
    () => js.views.kv(name, { ttl: ttlMs, history: 1, replicas }),
    60_000,
    undefined,
    `KV ${name}`,
  );
}
