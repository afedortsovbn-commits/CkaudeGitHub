import { connect, RetentionPolicy, StorageType, type JetStreamManager, type NatsConnection } from 'nats';
import type { Logger } from 'pino';

export async function connectNats(opts: {
  servers: string[];
  name: string;
  logger: Logger;
}): Promise<NatsConnection> {
  const nc = await connect({
    servers: opts.servers,
    name: opts.name,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 500,
    waitOnFirstConnect: true,
    pingInterval: 5000,
  });
  void (async () => {
    for await (const s of nc.status()) {
      opts.logger.info({ type: s.type, data: String(s.data) }, 'статус NATS');
    }
  })();
  return nc;
}

export interface StreamSpec {
  name: string;
  subjects: string[];
  replicas?: number;
  /** Окно дедупликации по Nats-Msg-Id. Главная защита от дублей — уникальные ключи в БД. */
  duplicateWindowMs?: number;
}

/** Идемпотентно создаёт или обновляет поток JetStream. */
export async function ensureStream(jsm: JetStreamManager, spec: StreamSpec): Promise<void> {
  const cfg = {
    name: spec.name,
    subjects: spec.subjects,
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    num_replicas: spec.replicas ?? 3,
    duplicate_window: (spec.duplicateWindowMs ?? 120_000) * 1_000_000,
  };
  try {
    await jsm.streams.info(spec.name);
    await jsm.streams.update(spec.name, cfg);
  } catch (e) {
    if (String(e).includes('stream not found')) {
      await jsm.streams.add(cfg);
    } else {
      throw e;
    }
  }
}

/** Поток событий домена: все `cc.events.>` */
export const EVENTS_STREAM: StreamSpec = { name: 'CC_EVENTS', subjects: ['cc.events.>'] };

/** Входящие сообщения каналов: сохраняются в R3 до подтверждения каналу, обрабатываются worker. */
export const INBOUND_STREAM: StreamSpec = { name: 'CC_INBOUND', subjects: ['cc.inbound.>'] };
