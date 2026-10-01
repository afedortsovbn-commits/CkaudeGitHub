import { CONVERSATION_EVENTS, type MessageMeta, newId } from '@cc/contracts';
import {
  type Action,
  collectRefs,
  type Effect,
  type FlowEvent,
  type FlowGraph,
  type FlowState,
  isOpen,
  render,
  resumeFlow,
  type Schedule,
  startFlow,
  type StepResult,
} from '@cc/flow-engine';
import type { Pool, PoolClient } from 'pg';
import { appendMessage, emitConversation, loadRef } from './conversations';
import { DomainError } from './tickets';
import { enqueueBotTurn } from './webhooks';

/**
 * Автоматизация текстовых обращений (Ф7): правила автоответов (M-AUTO-02) и сценарный бот на flow-engine
 * (M-AUTO-04). Всё выполняется в транзакции обработки входящего сообщения (worker) — ответ бота и переход
 * в очередь фиксируются вместе с сообщением клиента, повторная доставка входящего не порождает дублей.
 * Правила и опубликованные версии ботов читаются из БД на каждом сообщении — изменения в админке действуют
 * сразу, без перезапуска и кэшей (M-ADM-04).
 */

type RuleKind = 'greeting' | 'queued' | 'after_hours' | 'keyword' | 'inactivity';

interface ConvRow {
  id: string;
  channel_id: string;
  channel_kind: string;
  contact_id: string;
  status: string;
  queue_id: string | null;
  bot_flow_version_id: string | null;
  bot_state: BotState | null;
  auto_state: AutoState;
}

interface AutoState {
  greeting?: string;
  queued?: string;
  after_hours?: string;
  keyword?: Record<string, string>;
  inactivityWarnedAt?: string;
}

/** Состояние бота обращения: шаг исполнителя + ожидаемый ответ внешней системы. */
export interface BotState extends FlowState {
  /** Запрос во внешнюю систему в работе: token сверяется при приходе ответа (запоздавший — игнорируется). */
  pending?: { token: string; operationId: string; input: Record<string, string> };
  /** Бот закончил (перевёл на оператора или закрыл диалог). */
  done?: boolean;
  /** Внешний бот (Bot Gateway, Ф9): подписка вида «bot», которой отдаются ходы диалога. */
  external?: string;
}

export interface RuleRow {
  id: string;
  name: string;
  kind: RuleKind;
  schedule_id: string | null;
  match_type: 'keyword' | 'regex' | null;
  pattern: string | null;
  text: string;
  params: Record<string, unknown>;
}

/** Запрос во внешнюю систему, который worker выполнит после фиксации транзакции (NATS → api). */
export interface BotHttp {
  conversationId: string;
  token: string;
  operationId: string;
  input: Record<string, string>;
}

/** Сколько ждать ответа внешней системы, прежде чем шаг повторит другой экземпляр worker. */
export const BOT_HTTP_DEADLINE_MS = 45_000;

async function loadConv(tx: PoolClient, id: string): Promise<ConvRow> {
  const { rows } = await tx.query<ConvRow>(
    `SELECT id, channel_id, channel_kind, contact_id, status, queue_id, bot_flow_version_id, bot_state, auto_state
       FROM conversation WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw new Error(`обращение ${id} не найдено`);
  return rows[0];
}

/**
 * Активные правила вида kind для канала обращения (пустые списки каналов — все текстовые каналы). Ответ на отзыв
 * публичен (Ф13), поэтому для канала «Отзыв» действуют только правила, где он выбран явно.
 */
export async function rulesFor(
  tx: PoolClient | Pool,
  kind: RuleKind,
  channelId: string | null,
  channelKind: string | null,
): Promise<RuleRow[]> {
  const { rows } = await tx.query<RuleRow>(
    `SELECT id, name, kind, schedule_id, match_type, pattern, text, params FROM auto_reply_rule
      WHERE is_active AND kind = $1
        AND ($2::uuid IS NULL OR cardinality(channel_ids) = 0 OR $2 = ANY (channel_ids))
        AND ($3::text IS NULL OR cardinality(channel_kinds) = 0 OR $3 = ANY (channel_kinds))
        AND ($3::text IS DISTINCT FROM 'review' OR $2 = ANY (channel_ids) OR $3 = ANY (channel_kinds))
      ORDER BY sort_order, name`,
    [kind, channelId, channelKind],
  );
  return rows;
}

async function contactVars(tx: PoolClient, contactId: string): Promise<Record<string, string>> {
  const { rows } = await tx.query<{
    display_name: string | null;
    phone: string | null;
    email: string | null;
  }>(`SELECT display_name, phone, email FROM contact WHERE id = $1`, [contactId]);
  const c = rows[0];
  return {
    'client.name': c?.display_name ?? '',
    'client.phone': c?.phone ?? '',
    'client.email': c?.email ?? '',
    name: c?.display_name ?? '',
    phone: c?.phone ?? '',
  };
}

async function loadSchedules(tx: PoolClient, ids: string[]): Promise<Record<string, Schedule>> {
  if (!ids.length) return {};
  const { rows } = await tx.query<{
    id: string;
    timezone: string;
    week: Schedule['week'];
    holidays: string[];
  }>(
    `SELECT id, timezone, week, holidays::text[] AS holidays FROM schedule WHERE id = ANY ($1) AND is_active`,
    [ids],
  );
  return Object.fromEntries(
    rows.map((r) => [r.id, { timezone: r.timezone, week: r.week, holidays: r.holidays }]),
  );
}

async function autoMessage(tx: PoolClient, c: ConvRow, body: string, meta: MessageMeta): Promise<void> {
  if (!body.trim()) return;
  await appendMessage(tx, {
    conversationId: c.id,
    direction: 'out',
    body,
    channelKind: c.channel_kind,
    meta,
  });
}

async function markAuto(tx: PoolClient, c: ConvRow, patch: AutoState): Promise<void> {
  c.auto_state = { ...c.auto_state, ...patch };
  await tx.query(`UPDATE conversation SET auto_state = $2 WHERE id = $1`, [
    c.id,
    JSON.stringify(c.auto_state),
  ]);
}

/** Одно правило вида kind (первое по порядку) — один раз за обращение. */
async function replyOnce(
  tx: PoolClient,
  c: ConvRow,
  kind: 'greeting' | 'queued',
  vars: Record<string, string>,
): Promise<void> {
  if (c.auto_state[kind]) return;
  const rule = (await rulesFor(tx, kind, c.channel_id, c.channel_kind))[0];
  if (!rule) return;
  await autoMessage(tx, c, render(rule.text, vars), { auto: kind });
  await markAuto(tx, c, { [kind]: new Date().toISOString() });
}

/** Нерабочее время по расписанию правила — один раз за обращение. */
async function afterHours(
  tx: PoolClient,
  c: ConvRow,
  vars: Record<string, string>,
  now: Date,
): Promise<void> {
  if (c.auto_state.after_hours) return;
  for (const rule of await rulesFor(tx, 'after_hours', c.channel_id, c.channel_kind)) {
    if (!rule.schedule_id) continue;
    const s = (await loadSchedules(tx, [rule.schedule_id]))[rule.schedule_id];
    if (!s || isOpen(s, now)) continue;
    await autoMessage(tx, c, render(rule.text, vars), { auto: 'after_hours' });
    await markAuto(tx, c, { after_hours: now.toISOString() });
    return;
  }
}

export function keywordMatches(rule: Pick<RuleRow, 'match_type' | 'pattern'>, body: string): boolean {
  if (!rule.pattern) return false;
  try {
    return rule.match_type === 'regex'
      ? new RegExp(rule.pattern, 'i').test(body)
      : rule.pattern
          .split(/[,;\n]/)
          .map((w) => w.trim().toLowerCase())
          .filter(Boolean)
          .some((w) => body.toLowerCase().includes(w));
  } catch {
    return false; // некорректное регулярное выражение — правило пропускается, а не роняет обработку
  }
}

/** Ответ на ключевые слова, пока обращение ждёт оператора; каждое правило — не больше раза за обращение. */
async function keywords(tx: PoolClient, c: ConvRow, body: string, vars: Record<string, string>) {
  const sent = c.auto_state.keyword ?? {};
  for (const rule of await rulesFor(tx, 'keyword', c.channel_id, c.channel_kind)) {
    if (sent[rule.id] || !keywordMatches(rule, body)) continue;
    await autoMessage(tx, c, render(rule.text, vars), { auto: 'keyword' });
    await markAuto(tx, c, { keyword: { ...sent, [rule.id]: new Date().toISOString() } });
    return;
  }
}

/**
 * Автоматика после сохранения входящего сообщения (в той же транзакции): приветствие и «нерабочее время»
 * при первом сообщении, затем бот (если назначен каналу) или «вы в очереди» и ответ на ключевые слова.
 * Возвращает запрос во внешнюю систему, если бот его ждёт, — worker выполнит его после фиксации.
 */
export async function afterInbound(
  tx: PoolClient,
  r: { conversationId: string; created: boolean; body: string },
  now = new Date(),
): Promise<BotHttp | null> {
  const c = await loadConv(tx, r.conversationId);
  if (c.channel_kind === 'voice') return null;
  const vars = await contactVars(tx, c.contact_id);
  if (r.created) {
    await replyOnce(tx, c, 'greeting', vars);
    await afterHours(tx, c, vars, now);
  }
  if (c.status === 'bot' && c.bot_state?.external && !c.bot_state.done) {
    await externalBotTurn(tx, c, now);
    return null;
  }
  if (c.status === 'bot' && c.bot_flow_version_id) {
    return r.created || !c.bot_state
      ? startBot(tx, c, vars, now)
      : continueBot(tx, c, { type: 'text', text: r.body }, now);
  }
  if (c.status === 'queued' || c.status === 'offered') {
    if (r.created) await replyOnce(tx, c, 'queued', vars);
    await keywords(tx, c, r.body, vars);
  }
  return null;
}

// ------------------------------------------------------------------ бот

async function loadGraph(tx: PoolClient, versionId: string): Promise<FlowGraph | null> {
  const { rows } = await tx.query<{ graph: FlowGraph }>(`SELECT graph FROM flow_version WHERE id = $1`, [
    versionId,
  ]);
  return rows[0]?.graph ?? null;
}

async function engineCtx(tx: PoolClient, graph: FlowGraph, now: Date) {
  return { now, schedules: await loadSchedules(tx, collectRefs(graph).schedules) };
}

async function startBot(
  tx: PoolClient,
  c: ConvRow,
  vars: Record<string, string>,
  now: Date,
): Promise<BotHttp | null> {
  const graph = await loadGraph(tx, c.bot_flow_version_id!);
  if (!graph) return handoff(tx, c, { queueId: null, topicId: null, priority: 0, text: '' }, {});
  const botVars = { ...vars, channel: c.channel_kind };
  return drive(tx, c, graph, startFlow(graph, botVars, await engineCtx(tx, graph, now)), now);
}

async function continueBot(tx: PoolClient, c: ConvRow, event: FlowEvent, now: Date): Promise<BotHttp | null> {
  const st = c.bot_state;
  if (!st || st.done) return null;
  // Клиент пишет, пока бот ждёт ответа внешней системы, — сообщение сохранено, шаг не меняется.
  if (st.pending && event.type !== 'http') return null;
  const graph = await loadGraph(tx, c.bot_flow_version_id!);
  if (!graph) return null;
  const r = resumeFlow(graph, st, event, await engineCtx(tx, graph, now));
  if (!r) return null;
  return drive(tx, c, graph, r, now);
}

async function applyEffects(tx: PoolClient, c: ConvRow, effects: Effect[]): Promise<void> {
  for (const e of effects) {
    if (e.type !== 'contact') continue;
    // Поле карточки клиента (M-AUTO-04 «сбор полей»); телефон и email — ещё и идентификаторы для узнавания
    // клиента в других каналах (M-CARD-01), если не принадлежат другому клиенту.
    await tx.query(
      `UPDATE contact SET ${e.field === 'name' ? 'display_name' : e.field} = $2, updated_at = now() WHERE id = $1`,
      [c.contact_id, e.value],
    );
    if (e.field !== 'name')
      await tx.query(
        `INSERT INTO contact_identity (id, contact_id, kind, value) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, value) DO NOTHING`,
        [newId(), c.contact_id, e.field, e.value],
      );
  }
}

async function saveState(tx: PoolClient, c: ConvRow, st: BotState, wakeAt: Date | null): Promise<void> {
  c.bot_state = st;
  await tx.query(
    `UPDATE conversation SET bot_state = $2, bot_wake_at = $3, updated_at = now() WHERE id = $1`,
    [c.id, JSON.stringify(st), wakeAt],
  );
}

/** Выполнять действия бота, пока шаг не потребует ответа клиента или внешней системы. */
async function drive(
  tx: PoolClient,
  c: ConvRow,
  graph: FlowGraph,
  first: StepResult,
  now: Date,
): Promise<BotHttp | null> {
  let r: StepResult | null = first;
  const ctx = await engineCtx(tx, graph, now);
  for (let i = 0; r && i < 100; i++) {
    await applyEffects(tx, c, r.effects);
    const a: Action = r.action;
    switch (a.type) {
      case 'say':
        await autoMessage(tx, c, a.text, { auto: 'bot' });
        r = resumeFlow(graph, r.state, { type: 'done' }, ctx);
        continue;
      case 'prompt':
        await autoMessage(tx, c, a.text, {
          auto: 'bot',
          ...(a.buttons.length ? { buttons: a.buttons } : {}),
        });
        await saveState(tx, c, r.state, null);
        return null;
      case 'http': {
        const token = newId();
        await saveState(
          tx,
          c,
          { ...r.state, pending: { token, operationId: a.operationId, input: a.input } },
          new Date(Date.now() + BOT_HTTP_DEADLINE_MS),
        );
        return { conversationId: c.id, token, operationId: a.operationId, input: a.input };
      }
      case 'handoff':
        await saveState(tx, c, { ...r.state, done: true }, null);
        return handoff(tx, c, a, r.state.vars);
      case 'hangup':
        await autoMessage(tx, c, a.text ?? '', { auto: 'bot' });
        await saveState(tx, c, { ...r.state, done: true }, null);
        await closeAuto(tx, c.id, 'Бот завершил диалог');
        return null;
      default:
        // Голосовое действие в текстовом сценарии (проверка графа такое не пропускает) — к оператору.
        await saveState(tx, c, { ...r.state, done: true }, null);
        return handoff(tx, c, { queueId: null, topicId: null, priority: 0, text: '' }, r.state.vars);
    }
  }
  return null;
}

const HIDDEN_VARS = new Set(['name', 'phone', 'channel', 'client.name', 'client.phone', 'client.email']);

/**
 * Перевод на оператора (узел «Перевод на оператора» или конец сценария): обращение встаёт в очередь с
 * темой и приоритетом; переписка с ботом остаётся в обращении, собранные ботом данные — во внутренней заметке.
 */
async function handoff(
  tx: PoolClient,
  c: ConvRow,
  a: { queueId: string | null; topicId: string | null; priority: number; text: string },
  vars: Record<string, string>,
): Promise<null> {
  if (a.text) await autoMessage(tx, c, a.text, { auto: 'bot' });
  const q = a.queueId
    ? (
        await tx.query<{ id: string; name: string; priority: number }>(
          `SELECT id, name, priority FROM queue WHERE id = $1 AND is_active`,
          [a.queueId],
        )
      ).rows[0]
    : undefined;
  const queueId = q?.id ?? c.queue_id;
  const base = q
    ? q.priority
    : ((await tx.query<{ priority: number }>(`SELECT priority FROM queue WHERE id = $1`, [queueId])).rows[0]
        ?.priority ?? 0);
  const seg = await tx.query<{ boost: number }>(
    `SELECT sp.boost FROM contact ct JOIN segment_priority sp ON sp.segment = ct.segment AND sp.is_active WHERE ct.id = $1`,
    [c.contact_id],
  );
  const topic = a.topicId
    ? (
        await tx.query<{ path: string[]; is_important: boolean; name: string }>(
          `SELECT path, is_important, name FROM topic WHERE id = $1 AND is_active`,
          [a.topicId],
        )
      ).rows[0]
    : undefined;
  await tx.query(
    `UPDATE conversation SET status = 'queued', queue_id = $2, priority = $3, escalated = false, queued_at = now(),
       offered_at = NULL, bot_wake_at = NULL,
       topic_id = COALESCE($4, topic_id), topic_path = COALESCE($5, topic_path),
       is_important = is_important OR $6, version = version + 1, updated_at = now()
     WHERE id = $1`,
    [
      c.id,
      queueId,
      base + a.priority + (seg.rows[0]?.boost ?? 0),
      topic ? a.topicId : null,
      topic?.path ?? null,
      !!topic?.is_important,
    ],
  );
  c.status = 'queued';
  const qName =
    q?.name ??
    (queueId
      ? (await tx.query<{ name: string }>(`SELECT name FROM queue WHERE id = $1`, [queueId])).rows[0]?.name
      : null);
  await appendMessage(tx, {
    conversationId: c.id,
    direction: 'system',
    body: `Бот передал диалог оператору${qName ? ` (очередь «${qName}»${topic ? `, тема «${topic.name}»` : ''})` : ''}`,
    channelKind: c.channel_kind,
  });
  const collected = Object.entries(vars).filter(([k, v]) => v && !HIDDEN_VARS.has(k));
  if (collected.length)
    await appendMessage(tx, {
      conversationId: c.id,
      direction: 'note',
      body: `Бот собрал:\n${collected.map(([k, v]) => `${k}: ${v}`).join('\n')}`,
      channelKind: c.channel_kind,
    });
  await replyOnce(tx, c, 'queued', await contactVars(tx, c.contact_id));
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, c.id), { action: 'bot_handoff' });
  return null;
}

/**
 * Ответ внешней системы для шага бота. Выполняется новой транзакцией после запроса; ответ к уже
 * пройденному шагу (другой экземпляр успел раньше) игнорируется по token.
 */
export async function resumeBotHttp(
  tx: PoolClient,
  h: { conversationId: string; token: string },
  res: { ok: boolean; outputs: Record<string, string> },
  now = new Date(),
): Promise<BotHttp | null> {
  const c = await loadConv(tx, h.conversationId);
  if (c.status !== 'bot' || c.bot_state?.pending?.token !== h.token) return null;
  c.bot_state = { ...c.bot_state, pending: undefined };
  return continueBot(tx, c, { type: 'http', ok: res.ok, outputs: res.outputs }, now);
}

/**
 * Шаги бота, чей ответ внешней системы не пришёл к сроку (экземпляр worker остановлен посреди запроса):
 * забираются одним экземпляром (SKIP LOCKED), срок сдвигается — запрос повторяется.
 */
export async function claimStaleBotSteps(tx: PoolClient, limit = 20): Promise<BotHttp[]> {
  const { rows } = await tx.query<{ id: string; bot_state: BotState }>(
    `SELECT id, bot_state FROM conversation
      WHERE bot_wake_at IS NOT NULL AND bot_wake_at < now() AND status = 'bot'
        AND NOT (COALESCE(bot_state, '{}') ? 'external')
      ORDER BY bot_wake_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  const out: BotHttp[] = [];
  for (const r of rows) {
    const p = r.bot_state?.pending;
    if (!p) {
      await tx.query(`UPDATE conversation SET bot_wake_at = NULL WHERE id = $1`, [r.id]);
      continue;
    }
    await tx.query(`UPDATE conversation SET bot_wake_at = $2 WHERE id = $1`, [
      r.id,
      new Date(Date.now() + BOT_HTTP_DEADLINE_MS),
    ]);
    out.push({ conversationId: r.id, token: p.token, operationId: p.operationId, input: p.input });
  }
  return out;
}

// ------------------------------------------------------------------ автозакрытие при молчании клиента

/** Закрыть обращение автоматически (бот, молчание клиента): без результата обработки и оператора. */
export async function closeAuto(tx: PoolClient, conversationId: string, reason: string): Promise<void> {
  const { rows } = await tx.query<{ channel_kind: string }>(
    `UPDATE conversation SET status = 'closed', closed_at = now(), bot_wake_at = NULL, version = version + 1,
       updated_at = now() WHERE id = $1 AND status <> 'closed' RETURNING channel_kind`,
    [conversationId],
  );
  if (!rows[0]) return;
  await appendMessage(tx, {
    conversationId,
    direction: 'system',
    body: reason,
    channelKind: rows[0].channel_kind,
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, conversationId), {
    action: 'closed',
    auto: true,
    dispositionKind: 'auto_closed',
  });
}

/**
 * Правило «автозакрытие при молчании» (M-AUTO-02): последнее сообщение диалога — от нас (оператор или бот),
 * клиент молчит warnAfterSec → предупреждение (текст правила); ещё closeAfterSec без ответа → закрытие.
 * Ответ клиента снимает отметку предупреждения (ingestInbound). Дедлайны — данные в БД, их проверяет
 * периодический обход любого экземпляра worker (SKIP LOCKED), а не таймер в памяти процесса.
 */
export async function sweepInactivity(tx: PoolClient, now = new Date()): Promise<number> {
  let n = 0;
  for (const rule of await rulesFor(tx, 'inactivity', null, null)) {
    const warnAfter = Math.max(10, Number(rule.params.warnAfterSec ?? 300));
    const closeAfter = Math.max(10, Number(rule.params.closeAfterSec ?? 300));
    const closeText = String(rule.params.closeText ?? '') || 'Диалог закрыт: клиент не отвечает.';
    const { rows: ch } = await tx.query<{ channel_ids: string[]; channel_kinds: string[] }>(
      `SELECT channel_ids, channel_kinds FROM auto_reply_rule WHERE id = $1`,
      [rule.id],
    );
    const { rows } = await tx.query<{
      id: string;
      channel_kind: string;
      warned: string | null;
      contact_id: string;
    }>(
      `SELECT c.id, c.channel_kind, c.contact_id, c.auto_state ->> 'inactivityWarnedAt' AS warned
         FROM conversation c
        WHERE c.status IN ('active', 'bot') AND c.channel_kind <> 'voice'
          AND (cardinality($1::uuid[]) = 0 OR c.channel_id = ANY ($1))
          AND (cardinality($2::text[]) = 0 OR c.channel_kind = ANY ($2))
          AND (c.channel_kind <> 'review' OR c.channel_id = ANY ($1) OR c.channel_kind = ANY ($2))
          AND c.last_message_at < $3::timestamptz - make_interval(secs => $4)
          AND (SELECT m.direction FROM message m WHERE m.conversation_id = c.id AND m.direction IN ('in', 'out')
                ORDER BY m.sent_at DESC, m.seq DESC LIMIT 1) = 'out'
          AND (NOT (c.auto_state ? 'inactivityWarnedAt')
               OR (c.auto_state ->> 'inactivityWarnedAt')::timestamptz < $3::timestamptz - make_interval(secs => $5))
        ORDER BY c.last_message_at LIMIT 50 FOR UPDATE OF c SKIP LOCKED`,
      [
        ch[0]?.channel_ids ?? [],
        ch[0]?.channel_kinds ?? [],
        now,
        Math.min(warnAfter, closeAfter),
        closeAfter,
      ],
    );
    for (const r of rows) {
      const conv = await loadConv(tx, r.id);
      if (!r.warned) {
        // Предупреждение ставится только после warnAfter от последнего сообщения.
        const last = await tx.query<{ ok: boolean }>(
          `SELECT last_message_at < $2::timestamptz - make_interval(secs => $3) AS ok FROM conversation WHERE id = $1`,
          [r.id, now, warnAfter],
        );
        if (!last.rows[0]?.ok) continue;
        await autoMessage(tx, conv, render(rule.text, await contactVars(tx, r.contact_id)), {
          auto: 'inactivity',
        });
        await markAuto(tx, conv, { inactivityWarnedAt: now.toISOString() });
      } else {
        await closeAuto(tx, r.id, closeText);
      }
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ внешний бот (Bot Gateway, Ф9, M-AI-02)

/**
 * Новое сообщение клиента в диалоге внешнего бота: ход боту (webhook conversation.bot_turn той же транзакцией —
 * доставку выполнит worker) и срок ответа. Не ответил к сроку — диалог уходит оператору (sweepExternalBots).
 */
async function externalBotTurn(tx: PoolClient, c: ConvRow, now: Date): Promise<void> {
  const deadline = await enqueueBotTurn(tx, c.id, c.bot_state!.external!, now);
  if (!deadline) {
    // Бот отключён или удалён из канала — сразу к оператору.
    await saveState(tx, c, { ...c.bot_state!, done: true }, null);
    await handoff(tx, c, { queueId: null, topicId: null, priority: 0, text: '' }, {});
    return;
  }
  await tx.query(`UPDATE conversation SET bot_wake_at = $2 WHERE id = $1`, [c.id, deadline]);
}

async function loadExternal(tx: PoolClient, conversationId: string): Promise<ConvRow> {
  const c = await loadConv(tx, conversationId);
  if (c.status !== 'bot' || !c.bot_state?.external || c.bot_state.done)
    throw new DomainError(409, 'not_bot', 'Обращение не ведёт внешний бот (уже у оператора или закрыто)');
  return c;
}

/** Ответ внешнего бота клиенту (кнопки — как у сценарного бота: нажатие приходит текстом кнопки). */
export async function externalBotReply(
  tx: PoolClient,
  conversationId: string,
  m: { text: string; buttons?: string[] },
  source: string,
) {
  const c = await loadExternal(tx, conversationId);
  const msg = await appendMessage(tx, {
    conversationId: c.id,
    direction: 'out',
    body: m.text,
    channelKind: c.channel_kind,
    meta: {
      auto: 'bot',
      external: source,
      ...(m.buttons?.length ? { buttons: m.buttons.map((label, i) => ({ id: `b${i + 1}`, label })) } : {}),
    },
  });
  // Бот ответил — срок снят до следующего сообщения клиента.
  await tx.query(`UPDATE conversation SET bot_wake_at = NULL WHERE id = $1`, [c.id]);
  return msg;
}

/** Внешний бот переводит диалог на оператора: очередь, тема, сообщение клиенту, заметка оператору. */
export async function externalBotHandoff(
  tx: PoolClient,
  conversationId: string,
  a: { queueId?: string; topicId?: string; text?: string; note?: string },
  source: string,
): Promise<void> {
  const c = await loadExternal(tx, conversationId);
  if (a.note)
    await appendMessage(tx, {
      conversationId: c.id,
      direction: 'note',
      body: a.note,
      channelKind: c.channel_kind,
      meta: { external: source },
    });
  await saveState(tx, c, { ...c.bot_state!, done: true }, null);
  await handoff(
    tx,
    c,
    { queueId: a.queueId ?? null, topicId: a.topicId ?? null, priority: 0, text: a.text ?? '' },
    {},
  );
}

/** Внешний бот не ответил к сроку (упал, недоступен) — клиент не остаётся без ответа: диалог к оператору. */
export async function sweepExternalBots(tx: PoolClient, now = new Date()): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM conversation
      WHERE bot_wake_at IS NOT NULL AND bot_wake_at < $1 AND status = 'bot' AND bot_state ? 'external'
      ORDER BY bot_wake_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
    [now],
  );
  for (const r of rows) {
    const c = await loadConv(tx, r.id);
    await appendMessage(tx, {
      conversationId: c.id,
      direction: 'system',
      body: 'Внешний бот не ответил вовремя — диалог передан оператору',
      channelKind: c.channel_kind,
    });
    await saveState(tx, c, { ...c.bot_state!, done: true }, null);
    await handoff(tx, c, { queueId: null, topicId: null, priority: 0, text: '' }, {});
  }
  return rows.length;
}
