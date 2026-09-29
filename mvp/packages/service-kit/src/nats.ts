import { connect, RetentionPolicy, StorageType, type JetStreamManager, type NatsConnection } from 'nats';
import type { Logger } from 'pino';

export async function connectNats(opts: {
  servers: string[];
  name: string;
  logger: Logger;
  /** Сколько ждать готовности JetStream после подключения (мс). */
  jetStreamTimeoutMs?: number;
}): Promise<NatsConnection> {
  const nc = await connect({
    servers: opts.servers,
    name: opts.name,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 500,
    waitOnFirstConnect: true,
    pingInterval: 5000,
  });
  // Кластер NATS отвечает на /healthz раньше, чем выбран мета-лидер JetStream: первые запросы JetStream API
  // в этот момент получают TIMEOUT и сервис падал при старте (compose up --wait видел его unhealthy). Ждём
  // готовности JetStream здесь — один раз для всех сервисов.
  await waitForJetStream(nc, opts.logger, opts.jetStreamTimeoutMs ?? 120_000);
  void (async () => {
    for await (const s of nc.status()) {
      // pingTimer — штатные пинги каждые pingInterval, в info они только засоряют журнал.
      const level = s.type === 'pingTimer' ? 'debug' : 'info';
      opts.logger[level]({ type: s.type, data: String(s.data) }, 'статус NATS');
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

/** Временная недоступность JetStream (выборы лидера, формирование группы RAFT) — стоит повторить. */
export function isTransientJsError(e: unknown): boolean {
  const s = String(e);
  return /TIMEOUT|timeout|503|no responders|JetStream (system )?temporarily unavailable|not ready|leader/i.test(
    s,
  );
}

/** Повторяет операцию JetStream при временной недоступности кластера (до timeoutMs). */
export async function retryJs<T>(
  fn: () => Promise<T>,
  timeoutMs = 60_000,
  logger?: Logger,
  what = 'JetStream',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientJsError(e) || Date.now() > deadline) throw e;
      logger?.warn({ err: String(e), attempt }, `${what}: кластер ещё не готов, повтор`);
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 3000)));
    }
  }
}

/** Ждёт, пока JetStream API начнёт отвечать (выбран мета-лидер кластера). */
export async function waitForJetStream(
  nc: NatsConnection,
  logger: Logger,
  timeoutMs = 120_000,
): Promise<void> {
  await retryJs(
    async () => {
      const jsm = await nc.jetstreamManager({ timeout: 5000 });
      await jsm.getAccountInfo();
    },
    timeoutMs,
    logger,
    'ожидание JetStream',
  );
}

/** Идемпотентно создаёт или обновляет поток JetStream (с повтором при временной недоступности кластера). */
export async function ensureStream(jsm: JetStreamManager, spec: StreamSpec): Promise<void> {
  await retryJs(() => ensureStreamOnce(jsm, spec), 60_000, undefined, `поток ${spec.name}`);
}

async function ensureStreamOnce(jsm: JetStreamManager, spec: StreamSpec): Promise<void> {
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

/**
 * Исходящие во внешние каналы (cc.outbound.<kind>, публикует outbox-relay) и статусы их доставки
 * (cc.delivery.<kind>, публикуют коннекторы). Должен существовать до запуска outbox-relay: публикация
 * в subject без потока останавливает relay (порядок outbox сохраняется ценой ожидания).
 */
export const OUTBOUND_STREAM: StreamSpec = {
  name: 'CC_OUTBOUND',
  subjects: ['cc.outbound.>', 'cc.delivery.>'],
  duplicateWindowMs: 600_000,
};
