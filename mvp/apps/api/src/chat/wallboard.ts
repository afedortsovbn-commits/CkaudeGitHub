import type { Principal } from '@cc/auth';
import { scopeFilter } from '@cc/auth';
import type { SupervisorThresholds } from '@cc/contracts';
import { systemTimezone } from '@cc/domain';
import type { Pool } from 'pg';
import { one, rows } from '../lib/db';

/**
 * Экран мониторинга на отдельный монитор: текущее состояние крупно (очередь, операторы, разговоры, сегодня),
 * шкала последних 2 часов и список проблем — сейчас и за последние 2 часа. Сравнение потока — со средним за то
 * же время в предыдущие 7 дней.
 */

export type Level = 'ok' | 'warn' | 'crit';
export interface Problem {
  key: string;
  level: Level;
  /** Короткий текст для экрана (крупно). */
  text: string;
}
export interface Bucket {
  at: string;
  received: number;
  /** Среднее за это же время в предыдущие 7 дней. */
  usual: number;
  maxWaitS: number;
  lost: number;
  flags: ('spike' | 'slow' | 'lost')[];
}

const SCOPE = { enterprise: 'c.enterprise_id', department: 'c.department_id', topicPath: 'c.topic_path' };
const BUCKET_MIN = 10;
const BUCKETS = 12;
const min = (s: number) => Math.max(1, Math.round(s / 60));

/** Резкий рост: в 1,5 раза больше обычного и не меньше порога; в 2 раза — критично. */
export function spikeLevel(received: number, usual: number, minCount: number): Level {
  if (received < minCount) return 'ok';
  const ratio = usual > 0 ? received / usual : Infinity;
  return ratio >= 2 ? 'crit' : ratio >= 1.5 ? 'warn' : 'ok';
}

export interface WallboardInput {
  operators: { status: string; onCall: boolean; inChat: boolean }[];
  now: {
    talking: number;
    ivr: number;
    qVoice: number;
    qText: number;
    oldestWaitS: number;
    chats: number;
    bot: number;
  };
  buckets: Omit<Bucket, 'flags'>[];
  today: { received: number; answered: number; abandoned: number; slPct: number | null; asaS: number | null };
  resources: { level: Level; label: string }[];
  th: SupervisorThresholds;
}

/** Сводка и проблемы (без БД — проверяется unit-тестами). */
export function evaluateWallboard(i: WallboardInput) {
  const online = i.operators.filter((o) => o.status !== 'offline');
  const busy = online.filter((o) => o.onCall || o.inChat).length;
  const ops = {
    online: online.length,
    free: online.filter((o) => o.status === 'ready' && !o.onCall && !o.inChat).length,
    busy,
    wrapUp: online.filter((o) => o.status === 'wrap_up' && !o.onCall && !o.inChat).length,
    onBreak: online.filter((o) => o.status === 'break').length,
  };
  const th = i.th;
  const buckets: Bucket[] = i.buckets.map((b) => {
    const flags: Bucket['flags'] = [];
    if (spikeLevel(b.received, b.usual, 5) !== 'ok') flags.push('spike');
    if (b.maxWaitS >= th.waitWarnS) flags.push('slow');
    if (b.lost > 0) flags.push('lost');
    return { ...b, flags };
  });
  const last3 = buckets.slice(-3);
  const recv30 = last3.reduce((a, b) => a + b.received, 0);
  const usual30 = last3.reduce((a, b) => a + b.usual, 0);
  const lost30 = last3.reduce((a, b) => a + b.lost, 0);
  const queued = i.now.qVoice + i.now.qText;
  const problems: Problem[] = [];
  const add = (key: string, level: Level, text: string) =>
    level !== 'ok' && problems.push({ key, level, text });
  add(
    'wait',
    i.now.oldestWaitS >= th.waitCritS ? 'crit' : i.now.oldestWaitS >= th.waitWarnS ? 'warn' : 'ok',
    `Клиент ждёт ответа уже ${min(i.now.oldestWaitS)} мин`,
  );
  add(
    'no_free',
    queued > 0 && ops.free === 0 ? 'crit' : 'ok',
    'В очереди есть клиенты, свободных операторов нет',
  );
  add(
    'queue',
    queued >= th.queueCrit ? 'crit' : queued >= th.queueWarn ? 'warn' : 'ok',
    `В очереди ${queued} — больше обычного`,
  );
  const sp = spikeLevel(recv30, usual30, 10);
  add(
    'spike',
    sp,
    usual30 > 0
      ? `Резкий рост: ${recv30} обращений за 30 мин — в ${(recv30 / usual30).toFixed(1).replace('.', ',')} раза больше обычного`
      : `Резкий рост: ${recv30} обращений за 30 мин`,
  );
  add('lost', lost30 >= 3 ? 'crit' : lost30 > 0 ? 'warn' : 'ok', `Не дождались ответа за 30 мин: ${lost30}`);
  add(
    'sl',
    i.today.slPct !== null && i.today.slPct < th.slTargetPct ? 'warn' : 'ok',
    `Уровень сервиса сегодня ${Math.round(i.today.slPct ?? 0)}% — ниже цели ${th.slTargetPct}%`,
  );
  for (const r of i.resources)
    add(`res:${r.label}`, r.level, `Сервер: ${r.label.toLowerCase()} — на пределе`);
  const rank = { ok: 0, warn: 1, crit: 2 } as const;
  problems.sort((a, b) => rank[b.level] - rank[a.level]);
  // Было за последние 2 часа (сейчас уже нет): отрезки шкалы с отметками.
  const recent = buckets.filter((b) => b.flags.length).length;
  const level: Level = problems[0]?.level ?? 'ok';
  return { level, problems, operators: ops, buckets, recentProblemBuckets: recent };
}

export async function wallboard(pool: Pool, p: Principal) {
  const sc = scopeFilter(p.scope, SCOPE, 1);
  const operators = await rows<{ status: string; on_call: boolean; in_chat: boolean }>(
    pool,
    `SELECT COALESCE(ag.status, 'offline') AS status,
       EXISTS (SELECT 1 FROM call cl WHERE cl.agent_user_id = u.id AND cl.state IN ('talking', 'dialing')) AS on_call,
       EXISTS (SELECT 1 FROM conversation c WHERE c.assignee_id = u.id AND c.status IN ('active', 'offered', 'hold')
                 AND c.channel_kind <> 'voice') AS in_chat
       FROM app_user u LEFT JOIN agent_status ag ON ag.user_id = u.id
      WHERE u.is_active AND u.can_login AND EXISTS (
        SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
         WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))`,
  );
  const now = (await one<Record<string, number>>(
    pool,
    `SELECT (SELECT count(*) FROM call WHERE state = 'talking')::int AS talking,
            (SELECT count(*) FROM call WHERE state = 'ivr')::int AS ivr,
            count(*) FILTER (WHERE c.status = 'queued' AND c.channel_kind = 'voice')::int AS q_voice,
            count(*) FILTER (WHERE c.status = 'queued' AND c.channel_kind <> 'voice')::int AS q_text,
            COALESCE(extract(epoch FROM now() - min(c.queued_at) FILTER (WHERE c.status = 'queued'))::int, 0) AS oldest,
            count(*) FILTER (WHERE c.status IN ('active', 'offered', 'hold') AND c.channel_kind <> 'voice')::int AS chats,
            count(*) FILTER (WHERE c.status = 'bot' AND c.channel_kind <> 'voice')::int AS bot
       FROM conversation c WHERE c.status IN ('queued', 'active', 'offered', 'hold', 'bot') AND ${sc.sql}`,
    sc.params,
  ))!;
  // Шкала: 12 отрезков по 10 минут; «обычно» — среднее за то же время в предыдущие 7 дней.
  const buckets = await rows<{
    at: Date;
    received: number;
    usual: number;
    max_wait: number | null;
    lost: number;
  }>(
    pool,
    `WITH b AS (
       SELECT t0 FROM generate_series(date_bin('${BUCKET_MIN} min', now(), TIMESTAMPTZ '2000-01-01')
                                        - interval '${(BUCKETS - 1) * BUCKET_MIN} min',
                                      date_bin('${BUCKET_MIN} min', now(), TIMESTAMPTZ '2000-01-01'),
                                      interval '${BUCKET_MIN} min') AS t0)
     SELECT b.t0 AS at,
       (SELECT count(*) FROM conversation c WHERE c.created_at >= b.t0 AND c.created_at < b.t0 + interval '${BUCKET_MIN} min'
          AND ${sc.sql})::int AS received,
       (SELECT count(*) FROM conversation c, generate_series(1, 7) d
         WHERE c.created_at >= b.t0 - make_interval(days => d)
           AND c.created_at < b.t0 - make_interval(days => d) + interval '${BUCKET_MIN} min' AND ${sc.sql})::float / 7 AS usual,
       (SELECT max(extract(epoch FROM c.assigned_at - c.queued_at)) FROM conversation c
         WHERE c.created_at >= b.t0 - interval '1 day' AND c.assigned_at >= b.t0
           AND c.assigned_at < b.t0 + interval '${BUCKET_MIN} min' AND c.queued_at IS NOT NULL AND ${sc.sql})::int AS max_wait,
       (SELECT count(*) FROM conversation c
         WHERE c.status = 'closed' AND c.closed_at >= b.t0 AND c.closed_at < b.t0 + interval '${BUCKET_MIN} min'
           AND c.assigned_at IS NULL AND c.queued_at IS NOT NULL AND ${sc.sql})::int AS lost
       FROM b ORDER BY b.t0`,
    sc.params,
  );
  const last = await one<{ value: { samples?: { key: string; level: Level }[] } }>(
    pool,
    `SELECT value FROM system_setting WHERE key = 'resource.last'`,
  );
  return { operators, now, buckets, last };
}

/** Поступило сегодня (с полуночи по местному времени системы). */
export async function receivedToday(pool: Pool, p: Principal): Promise<number> {
  const tz = await systemTimezone(pool);
  const sc = scopeFilter(p.scope, SCOPE, 2);
  const r = await one<{ n: number }>(
    pool,
    `SELECT count(*)::int AS n FROM conversation c
      WHERE c.created_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AND ${sc.sql}`,
    [tz, ...sc.params],
  );
  return r?.n ?? 0;
}
