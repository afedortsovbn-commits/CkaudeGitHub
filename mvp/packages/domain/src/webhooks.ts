import { createHmac } from 'node:crypto';
import {
  BOT_TURN_EVENT,
  type BotTurnData,
  type EventEnvelope,
  newId,
  publicEventOf,
  SIGNATURE_HEADER,
  signaturePayload,
  TIMESTAMP_HEADER,
  type WebhookBody,
} from '@cc/contracts';
import { isSealed, openSecret } from '@cc/service-kit';
import type { Pool, PoolClient } from 'pg';

/**
 * Исходящие webhooks (Ф9, M-INT-02) и доставка ходов внешнему боту (M-AI-02).
 *
 * Надёжность: событие шины превращается в строки `webhook_delivery` (по одной на подписку; уникальный ключ
 * (подписка, событие) — повторная обработка события не даёт дубля). Доставляет отдельный цикл worker: строки
 * «арендуются» (SKIP LOCKED + locked_until), результат пишется в журнал. Сбой получателя не влияет на
 * обработку обращений — всё асинхронно; при сбое подписка переходит в режим «пробной доставки» с
 * экспоненциальной задержкой (одна доставка за попытку, а не шквал), первая успешная возвращает в работу
 * всю накопленную очередь — доставка «догоняет» после восстановления получателя.
 */

export const PLACEHOLDER_BASE = '{{base}}';

/** Задержка следующей попытки: 2, 4, 8 … с, не больше maxS. */
export const backoffSec = (n: number, maxS: number) => Math.min(maxS, 2 ** Math.max(1, Math.min(n, 20)));

/** Разложить событие шины по подпискам (в транзакции вызывающего). Возвращает число созданных доставок. */
export async function fanOutEvent(db: Pool | PoolClient, e: EventEnvelope): Promise<number> {
  const pub = publicEventOf(e);
  if (!pub) return 0;
  const channelId = typeof pub.data.channelId === 'string' ? pub.data.channelId : null;
  const conversationId = typeof pub.data.conversationId === 'string' ? pub.data.conversationId : null;
  const body: WebhookBody = { id: e.id, type: pub.type, occurredAt: e.occurredAt, data: pub.data };
  const r = await db.query(
    `INSERT INTO webhook_delivery (id, subscription_id, event_id, event_type, conversation_id, payload)
     SELECT gen_random_uuid(), s.id, $1, $2, $3, $4 FROM webhook_subscription s
      WHERE s.is_active AND s.kind = 'events'
        AND (cardinality(s.event_types) = 0 OR $2 = ANY (s.event_types))
        AND (cardinality(s.channel_ids) = 0 OR $5::uuid = ANY (s.channel_ids))
     ON CONFLICT (subscription_id, event_id) DO NOTHING`,
    [e.id, pub.type, conversationId, JSON.stringify(body), channelId],
  );
  return r.rowCount ?? 0;
}

/**
 * Ход внешнего бота: доставка conversation.bot_turn по последнему сообщению клиента. Возвращает срок ответа
 * бота или null, если подписка отключена/удалена.
 */
export async function enqueueBotTurn(
  tx: PoolClient,
  conversationId: string,
  subscriptionId: string,
  now = new Date(),
): Promise<Date | null> {
  const sub = (
    await tx.query<{ bot_timeout_s: number }>(
      `SELECT bot_timeout_s FROM webhook_subscription WHERE id = $1 AND is_active AND kind = 'bot'`,
      [subscriptionId],
    )
  ).rows[0];
  if (!sub) return null;
  const deadline = new Date(now.getTime() + sub.bot_timeout_s * 1000);
  const c = (
    await tx.query<{
      channel_id: string;
      channel_kind: string;
      contact_id: string;
      display_name: string | null;
      phone: string | null;
      email: string | null;
    }>(
      `SELECT c.channel_id, c.channel_kind, c.contact_id, ct.display_name, ct.phone, ct.email
         FROM conversation c JOIN contact ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [conversationId],
    )
  ).rows[0]!;
  const msgs = (
    await tx.query<{
      id: string;
      direction: string;
      body: string;
      attachments: { id: string; filename: string }[];
      sent_at: Date;
    }>(
      `SELECT id, direction, body, attachments, sent_at FROM message
        WHERE conversation_id = $1 AND direction IN ('in', 'out') ORDER BY sent_at DESC, seq DESC LIMIT 20`,
      [conversationId],
    )
  ).rows.reverse();
  const last = [...msgs].reverse().find((m) => m.direction === 'in');
  if (!last) return deadline;
  const path = `${PLACEHOLDER_BASE}/api/v1/ext/conversations/${conversationId}`;
  const data: BotTurnData = {
    conversationId,
    channel: { id: c.channel_id, kind: c.channel_kind },
    contact: { id: c.contact_id, name: c.display_name, phone: c.phone, email: c.email },
    message: {
      id: last.id,
      text: last.body,
      attachments: (last.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename })),
    },
    history: msgs.map((m) => ({ direction: m.direction, text: m.body, sentAt: m.sent_at.toISOString() })),
    replyUrl: `${path}/messages`,
    handoffUrl: `${path}/handoff`,
    deadline: deadline.toISOString(),
  };
  // Ключ идемпотентности — сообщение клиента: повторная обработка входящего не даёт второго хода.
  const eventId = last.id;
  const body: WebhookBody = {
    id: eventId,
    type: BOT_TURN_EVENT,
    occurredAt: now.toISOString(),
    data: data as unknown as Record<string, unknown>,
  };
  await tx.query(
    `INSERT INTO webhook_delivery (id, subscription_id, event_id, event_type, conversation_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (subscription_id, event_id) DO NOTHING`,
    [newId(), subscriptionId, eventId, BOT_TURN_EVENT, conversationId, JSON.stringify(body)],
  );
  return deadline;
}

// ---------------------------------------------------------------- доставка

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}
export type HttpSend = (r: HttpRequest) => Promise<{ status: number }>;

export const fetchSend: HttpSend = async (r) => {
  const res = await fetch(r.url, {
    method: 'POST',
    headers: r.headers,
    body: r.body,
    signal: AbortSignal.timeout(r.timeoutMs),
    redirect: 'error',
  });
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status };
};

export interface DeliveryOptions {
  secretsKey?: string;
  /** Адрес системы для ссылок в ходе бота (replyUrl). */
  baseUrl: string;
  /** Потолок задержки повтора, с. */
  maxBackoffS: number;
  /** Сколько доставка живёт в очереди, прежде чем получить статус failed, ч. */
  maxAgeH: number;
  send?: HttpSend;
  now?: () => Date;
}

interface SubRow {
  id: string;
  url: string;
  secret: string;
  headers: Record<string, string>;
  timeout_ms: number;
  failures: number;
}
interface DeliveryRow {
  id: string;
  subscription_id: string;
  event_type: string;
  conversation_id: string | null;
  payload: WebhookBody;
  attempts: number;
  created_at: Date;
  is_test: boolean;
}

export function signBody(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(signaturePayload(timestamp, body)).digest('hex')}`;
}

function openSubSecret(secret: string, key: string | undefined): string {
  if (!isSealed(secret)) return secret;
  if (!key) throw new Error('не задан SECRETS_KEY — нельзя подписать webhook');
  return openSecret(secret, key);
}

/** Одна попытка доставки: HTTP-запрос с подписью; ничего не пишет в БД. */
export async function attempt(
  sub: SubRow,
  d: Pick<DeliveryRow, 'id' | 'event_type' | 'payload'>,
  o: DeliveryOptions,
): Promise<{ ok: boolean; status: number | null; error: string | null; durationMs: number }> {
  const started = Date.now();
  try {
    const body = JSON.stringify(d.payload).replaceAll(PLACEHOLDER_BASE, o.baseUrl.replace(/\/$/, ''));
    const ts = Math.floor((o.now?.() ?? new Date()).getTime() / 1000);
    const headers: Record<string, string> = {
      ...Object.fromEntries(Object.entries(sub.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'cc-webhooks/1',
      'x-cc-event': d.event_type,
      'x-cc-delivery': d.id,
      [TIMESTAMP_HEADER]: String(ts),
      [SIGNATURE_HEADER]: signBody(openSubSecret(sub.secret, o.secretsKey), ts, body),
    };
    const r = await (o.send ?? fetchSend)({ url: sub.url, headers, body, timeoutMs: sub.timeout_ms });
    const ok = r.status >= 200 && r.status < 300;
    return { ok, status: r.status, error: ok ? null : `HTTP ${r.status}`, durationMs: Date.now() - started };
  } catch (err) {
    const e = err as Error;
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    return {
      ok: false,
      status: null,
      error: timeout
        ? `Нет ответа за ${sub.timeout_ms} мс`
        : `Ошибка соединения: ${cause?.code ?? cause?.message ?? e.message}`,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Забрать доставки, которые пора отправить. У подписки со сбоями — только одна (самая старая) «пробная».
 * Аренда (locked_until) защищает от повторной отправки другим экземпляром, пока идёт запрос.
 */
async function claim(pool: Pool, limit: number): Promise<{ d: DeliveryRow; s: SubRow }[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<DeliveryRow & { s: SubRow }>(
      `SELECT d.id, d.subscription_id, d.event_type, d.conversation_id, d.payload, d.attempts, d.created_at, d.is_test,
              row_to_json(s.*) AS s
         FROM webhook_delivery d JOIN webhook_subscription s ON s.id = d.subscription_id
        WHERE d.id IN (
                SELECT x.id FROM (
                  SELECT d2.id, d2.created_at, s2.failures,
                         row_number() OVER (PARTITION BY d2.subscription_id ORDER BY d2.created_at) AS rn
                    FROM webhook_delivery d2 JOIN webhook_subscription s2 ON s2.id = d2.subscription_id
                   WHERE d2.status = 'pending' AND d2.next_attempt_at <= now() AND s2.is_active
                     AND (s2.next_probe_at IS NULL OR s2.next_probe_at <= now())) x
                 WHERE x.failures = 0 OR x.rn = 1
                 ORDER BY x.created_at LIMIT $1)
          AND d.status = 'pending' AND (d.locked_until IS NULL OR d.locked_until < now())
        ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED`,
      [limit],
    );
    const picked = rows;
    // Среди выбранных у сбойной подписки может оказаться не первая строка (первую держит другой экземпляр) —
    // тогда в этот раз её пропускаем.
    const seen = new Set<string>();
    const out: { d: DeliveryRow; s: SubRow }[] = [];
    for (const r of picked) {
      if (r.s.failures > 0) {
        if (seen.has(r.subscription_id)) continue;
        seen.add(r.subscription_id);
      }
      out.push({ d: r, s: r.s });
    }
    if (out.length)
      await c.query(
        `UPDATE webhook_delivery SET locked_until = now() + make_interval(secs => 60) WHERE id = ANY ($1)`,
        [out.map((x) => x.d.id)],
      );
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function record(
  pool: Pool,
  d: DeliveryRow,
  s: SubRow,
  r: Awaited<ReturnType<typeof attempt>>,
  o: DeliveryOptions,
): Promise<void> {
  const now = o.now?.() ?? new Date();
  if (r.ok) {
    await pool.query(
      `UPDATE webhook_delivery SET status = 'sent', attempts = attempts + 1, sent_at = $2, last_status = $3,
         last_error = NULL, duration_ms = $4, locked_until = NULL WHERE id = $1`,
      [d.id, now, r.status, r.durationMs],
    );
    if (!d.is_test) {
      await pool.query(
        `UPDATE webhook_subscription SET last_success_at = $2, failures = 0, next_probe_at = NULL WHERE id = $1`,
        [s.id, now],
      );
      // Получатель ожил — накопленная очередь уходит сразу, не дожидаясь своих задержек.
      if (s.failures > 0)
        await pool.query(
          `UPDATE webhook_delivery SET next_attempt_at = $2 WHERE subscription_id = $1 AND status = 'pending'`,
          [s.id, now],
        );
    }
    return;
  }
  const attempts = d.attempts + 1;
  const expired = now.getTime() - d.created_at.getTime() > o.maxAgeH * 3600_000 || d.is_test;
  await pool.query(
    `UPDATE webhook_delivery SET attempts = $2, last_status = $3, last_error = $4, duration_ms = $5, locked_until = NULL,
       next_attempt_at = $6, status = CASE WHEN $7 THEN 'failed' ELSE status END WHERE id = $1`,
    [
      d.id,
      attempts,
      r.status,
      r.error,
      r.durationMs,
      new Date(now.getTime() + backoffSec(attempts, o.maxBackoffS) * 1000),
      expired,
    ],
  );
  if (d.is_test) return;
  await pool.query(
    // Параллельные неудачи одной пачки — один «раунд»: счётчик от значения на момент выборки.
    `UPDATE webhook_subscription SET failures = GREATEST(failures, $5), last_failure_at = $2, last_error = $3,
       next_probe_at = $2::timestamptz + make_interval(secs => $4) WHERE id = $1`,
    [s.id, now, r.error, backoffSec(s.failures + 1, o.maxBackoffS), s.failures + 1],
  );
}

/** Устаревший ход бота (диалог уже у оператора) не отправляется. */
async function stale(pool: Pool, d: DeliveryRow): Promise<boolean> {
  if (d.event_type !== BOT_TURN_EVENT || !d.conversation_id) return false;
  const r = await pool.query(
    `SELECT 1 FROM conversation WHERE id = $1 AND status = 'bot' AND NOT COALESCE((bot_state ->> 'done')::boolean, false)`,
    [d.conversation_id],
  );
  if (r.rowCount) return false;
  await pool.query(
    `UPDATE webhook_delivery SET status = 'failed', last_error = 'Диалог уже передан оператору', locked_until = NULL
      WHERE id = $1`,
    [d.id],
  );
  return true;
}

/** Обработать очередь доставок: пачками, параллельно. Возвращает число попыток. */
export async function processWebhookQueue(
  pool: Pool,
  o: DeliveryOptions & { shouldStop?: () => boolean; batch?: number },
): Promise<number> {
  let total = 0;
  for (let round = 0; round < 20 && !o.shouldStop?.(); round++) {
    const batch = await claim(pool, o.batch ?? 50);
    if (!batch.length) break;
    await Promise.all(
      batch.map(async ({ d, s }) => {
        if (await stale(pool, d)) return;
        const r = await attempt(s, d, o);
        await record(pool, d, s, r, o);
      }),
    );
    total += batch.length;
  }
  return total;
}

/** Проверочная доставка из админки: сразу, с результатом; состояние подписки не меняется. */
export async function sendTestDelivery(
  pool: Pool,
  subscriptionId: string,
  o: DeliveryOptions,
): Promise<{ id: string; ok: boolean; status: number | null; error: string | null; durationMs: number }> {
  const s = (
    await pool.query<SubRow>(
      `SELECT id, url, secret, headers, timeout_ms, failures FROM webhook_subscription WHERE id = $1`,
      [subscriptionId],
    )
  ).rows[0];
  if (!s) throw new Error('подписка не найдена');
  const id = newId();
  const now = o.now?.() ?? new Date();
  const payload: WebhookBody = {
    id,
    type: 'webhook.test',
    occurredAt: now.toISOString(),
    data: { subscriptionId, message: 'Проверка подписки из администрирования контакт-центра' },
  };
  await pool.query(
    `INSERT INTO webhook_delivery (id, subscription_id, event_id, event_type, payload, is_test, locked_until)
     VALUES ($1, $2, $1, 'webhook.test', $3, true, now() + make_interval(secs => 60))`,
    [id, subscriptionId, JSON.stringify(payload)],
  );
  const d: DeliveryRow = {
    id,
    subscription_id: subscriptionId,
    event_type: 'webhook.test',
    conversation_id: null,
    payload,
    attempts: 0,
    created_at: now,
    is_test: true,
  };
  const r = await attempt(s, d, o);
  await record(pool, d, s, r, o);
  return { id, ...r };
}

/** «Повторить сейчас»: подписка без ожидания пробной попытки, очередь (и неудавшиеся за срок) — в работу. */
export async function retryNow(pool: Pool, subscriptionId: string, deliveryId?: string): Promise<number> {
  await pool.query(`UPDATE webhook_subscription SET next_probe_at = NULL WHERE id = $1`, [subscriptionId]);
  const r = await pool.query(
    `UPDATE webhook_delivery SET status = 'pending', next_attempt_at = now(), locked_until = NULL
      WHERE subscription_id = $1 AND NOT is_test AND status <> 'sent' AND ($2::uuid IS NULL OR id = $2)`,
    [subscriptionId, deliveryId ?? null],
  );
  return r.rowCount ?? 0;
}
