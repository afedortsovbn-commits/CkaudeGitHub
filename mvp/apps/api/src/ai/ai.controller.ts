import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { newId } from '@cc/contracts';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, hasPerm, RequirePerm } from '../auth/guard';
import { llmChat } from '../automation/assist';
import { APP_CONTEXT, type AppContext } from '../context';
import { one, rows, toApi, withTx } from '../lib/db';
import { forbidden, notFound, parse } from '../lib/errors';

const uuid = z.string().uuid();
const AskBody = z
  .object({
    question: z.string().trim().min(1).max(2000),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) }).strict())
      .max(20)
      .default([]),
  })
  .strict();
const ReviewBody = z.object({ note: z.string().max(2000).optional() }).strict();

interface FieldDef {
  key: string;
  label: string;
  type: string;
  options: string[] | null;
}
interface Suggestion {
  topicId: string | null;
  fields: Record<string, string>;
}

/** Нормализация для сравнения «что предложила модель» и «что оставил оператор». */
const norm = (v: unknown) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Д-030: при закрытии или передаче на 2-ю линию сверить последнее предложение нейросети с итогом оператора:
 * каждое изменённое поле — строка журнала исправлений (для супервизора и дообучения модели).
 */
export async function recordAiCorrections(
  tx: PoolClient,
  conversationId: string,
  userId: string,
): Promise<number> {
  const fill = await one<{ id: string; suggested: Suggestion }>(
    tx,
    `SELECT id, suggested FROM ai_fill WHERE conversation_id = $1 AND checked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  if (!fill) return 0;
  const c = await one<{ topic_id: string | null; fields: Record<string, unknown> }>(
    tx,
    `SELECT topic_id, fields FROM conversation WHERE id = $1`,
    [conversationId],
  );
  if (!c) return 0;
  const labels = new Map(
    (
      await rows<{ key: string; label: string }>(
        tx,
        `SELECT DISTINCT ON (key) key, label FROM field_def WHERE key = ANY ($1)`,
        [Object.keys(fill.suggested.fields ?? {})],
      )
    ).map((r) => [r.key, r.label]),
  );
  const diffs: { field: string; label: string; suggested: string; final: string }[] = [];
  const s = fill.suggested;
  if (s.topicId && s.topicId !== c.topic_id) {
    const names = await rows<{ id: string; name: string }>(
      tx,
      `SELECT id, name FROM topic WHERE id = ANY ($1)`,
      [[s.topicId, c.topic_id].filter(Boolean)],
    );
    const n = (id: string | null) => names.find((x) => x.id === id)?.name ?? '';
    diffs.push({ field: 'topic', label: 'Тема', suggested: n(s.topicId), final: n(c.topic_id) });
  }
  for (const [k, v] of Object.entries(s.fields ?? {}))
    if (norm(v) !== norm(c.fields?.[k]))
      diffs.push({
        field: k,
        label: labels.get(k) ?? k,
        suggested: String(v),
        final: String(c.fields?.[k] ?? ''),
      });
  for (const d of diffs)
    await tx.query(
      `INSERT INTO ai_correction (id, fill_id, conversation_id, field, label, suggested, final, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId(), fill.id, conversationId, d.field, d.label, d.suggested, d.final, userId],
    );
  await tx.query(`UPDATE ai_fill SET checked_at = now() WHERE id = $1`, [fill.id]);
  return diffs.length;
}

// ------------------------------------------------------------------ заглушка: заполнение по правилам

/** Корень слова для грубого сравнения (первые 5 букв). */
const stems = (s: string) =>
  (s.toLowerCase().match(/[а-яёa-z0-9]{4,}/g) ?? []).map((w) => w.slice(0, 5)).filter((w) => w.length >= 4);

function stubFill(
  text: string,
  topics: { id: string; name: string; parent: string }[],
  defs: FieldDef[],
  contact: Record<string, string>,
) {
  const words = new Set(stems(text));
  let best: { id: string; score: number } | null = null;
  for (const t of topics) {
    const score =
      stems(t.name).filter((w) => words.has(w)).length * 2 +
      stems(t.parent).filter((w) => words.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { id: t.id, score };
  }
  const fields: Record<string, string> = {};
  const first = text.split('\n').find((l) => l.trim().length > 10) ?? text;
  if (first.trim()) fields.issue_summary = first.trim().slice(0, 300);
  const pick = (re: RegExp) => re.exec(text)?.[1];
  for (const f of defs) {
    const k = f.key;
    let v: string | undefined;
    if (f.type === 'phone' || k.includes('phone')) v = contact.phone || pick(/(\+?375[\d\s-]{9,13})/);
    else if (f.type === 'email' || k.includes('email')) v = contact.email || pick(/([\w.-]+@[\w-]+\.[\w.]+)/);
    else if (k.startsWith('azs')) v = pick(/АЗС\s*(?:№|N|номер)?\s*(\d{1,4})/i);
    else if (k.includes('card')) v = pick(/\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4,7})\b/);
    else if (k.includes('plate')) v = pick(/\b(\d{4}\s?[A-ZА-Я]{2}-?\d)\b/i);
    else if (f.type === 'date') {
      const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
      v = m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : undefined;
    } else if (k === 'client_name' || k === 'fio') v = contact.name;
    if (f.type === 'select' && v && !(f.options ?? []).includes(v)) v = undefined;
    if (v) fields[k] = v.trim();
  }
  return { topicId: best?.id ?? null, fields };
}

/**
 * Нейросеть (Д-030, Д-031). Модель подключается в «Подсказки: провайдеры» — провайдер OpenAI-совместимого API
 * (локальный Ollama/vLLM) с функцией «Заполнение полей» или «Помощник». Пока его нет, работает заглушка по
 * правилам: тема по словам из переписки, суть — первое сообщение клиента, телефон, почта, № АЗС, карта, дата.
 */
@Controller('api/v1')
export class AiController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private get llm() {
    return { pool: this.ctx.pool, secretsKey: this.ctx.config.SECRETS_KEY };
  }

  /** Предложить тему и поля карточки по переписке; оператор проверяет и исправляет. */
  @Post('conversations/:id/ai-fill')
  @HttpCode(200)
  @RequirePerm('conversations.work')
  async fill(@CurrentUser() p: Principal, @Param('id') id: string) {
    parse(uuid, id);
    const c = await one<{ assignee_id: string | null; topic_id: string | null; contact_id: string }>(
      this.ctx.pool,
      `SELECT assignee_id, topic_id, contact_id FROM conversation WHERE id = $1`,
      [id],
    );
    if (!c) throw notFound('Обращение');
    if (c.assignee_id !== p.id && !hasPerm(p, 'supervisor.monitor')) throw forbidden();
    const msgs = await rows<{ direction: string; body: string }>(
      this.ctx.pool,
      `SELECT direction, body FROM message WHERE conversation_id = $1 AND direction IN ('in', 'out', 'note')
        ORDER BY sent_at, seq LIMIT 200`,
      [id],
    );
    const clientText = msgs
      .filter((m) => m.direction === 'in' || m.direction === 'note')
      .map((m) => m.body)
      .join('\n');
    const topics = await rows<{ id: string; name: string; parent: string }>(
      this.ctx.pool,
      `SELECT t.id, t.name, COALESCE(pt.name, '') AS parent FROM topic t LEFT JOIN topic pt ON pt.id = t.parent_id
        WHERE t.is_active AND NOT EXISTS (SELECT 1 FROM topic ch WHERE ch.parent_id = t.id AND ch.is_active)`,
    );
    const contact =
      (await one<Record<string, string>>(
        this.ctx.pool,
        `SELECT COALESCE(phone, '') AS phone, COALESCE(email, '') AS email, COALESCE(display_name, '') AS name
           FROM contact WHERE id = $1`,
        [c.contact_id],
      )) ?? {};
    const defsFor = (topicId: string | null) =>
      topicId
        ? rows<FieldDef>(
            this.ctx.pool,
            `SELECT DISTINCT ON (f.key) f.key, f.label, f.type, f.options FROM topic t
               JOIN field_def f ON f.topic_id = ANY (t.path) AND f.is_active WHERE t.id = $1`,
            [topicId],
          )
        : Promise.resolve([] as FieldDef[]);

    let provider = 'stub';
    let s: Suggestion = { topicId: null, fields: {} };
    const ai = await llmChat(
      this.llm,
      'fill',
      [
        {
          role: 'system',
          content:
            'Ты помогаешь оператору контакт-центра сети АЗС заполнить карточку обращения по переписке. Ответь JSON: ' +
            '{"topicId": "<id темы из списка или null>", "fields": {"issue_summary": "суть обращения 1-2 предложения", ...}}. ' +
            'Заполняй только то, что явно есть в переписке. Темы: ' +
            topics.map((t) => `${t.id} — ${t.parent ? `${t.parent} › ` : ''}${t.name}`).join('; '),
        },
        {
          role: 'user',
          content: msgs
            .map((m) => `${m.direction === 'in' ? 'Клиент' : 'Оператор'}: ${m.body}`)
            .join('\n')
            .slice(-12000),
        },
      ],
      { json: true },
    ).catch(() => null);
    if (ai) {
      try {
        const j = JSON.parse(ai.text) as { topicId?: string | null; fields?: Record<string, unknown> };
        s = {
          topicId: topics.some((t) => t.id === j.topicId) ? (j.topicId as string) : null,
          fields: Object.fromEntries(
            Object.entries(j.fields ?? {})
              .filter(([, v]) => v !== null && v !== undefined && String(v).trim())
              .map(([k, v]) => [k, String(v).slice(0, 2000)]),
          ),
        };
        provider = ai.provider;
      } catch {
        /* модель ответила не JSON — заглушка ниже */
      }
    }
    if (provider === 'stub') {
      const first = stubFill(clientText, topics, [], contact);
      const topicId = c.topic_id ?? first.topicId;
      s = stubFill(clientText, topics, await defsFor(topicId), contact);
      s.topicId = c.topic_id ? null : first.topicId;
    }
    // Тему, уже выбранную оператором, не меняем.
    if (c.topic_id) s.topicId = null;
    await this.ctx.pool.query(
      `INSERT INTO ai_fill (id, conversation_id, provider, suggested, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [newId(), id, provider, JSON.stringify(s), p.id],
    );
    return { provider, stub: provider === 'stub', ...s };
  }

  /** Журнал исправлений (Д-030): что оператор поменял после нейросети — для супервизора и дообучения. */
  @Get('ai/corrections')
  @RequirePerm('supervisor.monitor', 'assist.manage')
  async corrections(@Query() q: Record<string, string>) {
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
    const list = await rows(
      this.ctx.pool,
      `SELECT k.id, k.conversation_id, k.field, k.label, k.suggested, k.final, k.created_at, k.reviewed_at, k.review_note,
              u.full_name AS user_name, r.full_name AS reviewed_by_name, f.provider, ct.display_name AS contact_name
         FROM ai_correction k JOIN ai_fill f ON f.id = k.fill_id
         LEFT JOIN app_user u ON u.id = k.user_id LEFT JOIN app_user r ON r.id = k.reviewed_by
         LEFT JOIN conversation c ON c.id = k.conversation_id LEFT JOIN contact ct ON ct.id = c.contact_id
        WHERE k.created_at >= now() - make_interval(days => $1)
        ORDER BY k.created_at DESC LIMIT 500`,
      [days],
    );
    const stats = await one<{ fills: number; checked: number; corrected: number }>(
      this.ctx.pool,
      `SELECT count(*)::int AS fills, count(*) FILTER (WHERE checked_at IS NOT NULL)::int AS checked,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_correction k WHERE k.fill_id = f.id))::int AS corrected
         FROM ai_fill f WHERE f.created_at >= now() - make_interval(days => $1)`,
      [days],
    );
    return { items: list.map((r) => toApi(r)), stats };
  }

  @Post('ai/corrections/:id/review')
  @HttpCode(200)
  @RequirePerm('supervisor.monitor', 'assist.manage')
  async review(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    parse(uuid, id);
    const b = parse(ReviewBody, body ?? {});
    const r = await withTx(this.ctx.pool, (tx) =>
      one(
        tx,
        `UPDATE ai_correction SET reviewed_at = now(), reviewed_by = $2, review_note = COALESCE($3, review_note)
          WHERE id = $1 RETURNING id`,
        [id, p.id, b.note ?? null],
      ),
    );
    if (!r) throw notFound('Запись журнала');
    return { ok: true };
  }

  /** Помощник администратора и супервизора (Д-031): вопросы по системе, цифры, где что настраивается. */
  @Post('assistant/ask')
  @HttpCode(200)
  @RequirePerm('settings.manage', 'supervisor.monitor')
  async ask(@Body() body: unknown) {
    const b = parse(AskBody, body);
    const facts = await this.facts();
    const ai = await llmChat(this.llm, 'assistant', [
      {
        role: 'system',
        content:
          'Ты помощник администратора и супервизора контакт-центра (обращения 1-й и 2-й линии, IVR, боты, отчёты). ' +
          `Отвечай кратко по-русски. Текущие показатели: ${JSON.stringify(facts)}. Разделы: ${LINKS.map((l) => `${l.label} (${l.to})`).join(', ')}.`,
      },
      ...b.history.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content: b.question },
    ]).catch(() => null);
    if (ai) return { answer: ai.text, links: linksFor(b.question), provider: ai.provider, stub: false };
    return { ...stubAnswer(b.question, facts), provider: 'stub', stub: true };
  }

  private async facts() {
    const r = await one<Record<string, number>>(
      this.ctx.pool,
      `SELECT (SELECT count(*)::int FROM conversation WHERE status = 'queued') AS queued,
              (SELECT count(*)::int FROM conversation WHERE status IN ('active', 'hold', 'offered')) AS in_work,
              (SELECT count(*)::int FROM agent_status WHERE status = 'ready') AS ready,
              (SELECT count(*)::int FROM agent_status WHERE status = 'break') AS on_break,
              (SELECT count(*)::int FROM conversation WHERE created_at >= date_trunc('day', now())) AS today_new,
              (SELECT count(*)::int FROM conversation WHERE status = 'closed' AND closed_at >= date_trunc('day', now())) AS today_closed,
              (SELECT count(*)::int FROM ticket WHERE status IN ('new', 'in_work', 'rework') AND due_date < current_date) AS tickets_overdue,
              (SELECT count(*)::int FROM ticket WHERE status IN ('new', 'in_work', 'rework', 'approval')) AS tickets_open`,
    );
    return r ?? {};
  }
}

const LINKS = [
  { re: /ivr|голосов|меню|приветств/i, to: '/ivr', label: 'Сценарии голосовых' },
  { re: /бот|чат-бот|текстов/i, to: '/bots', label: 'Сценарии текстовых' },
  { re: /настро|распредел|срок/i, to: '/settings', label: 'Настройки' },
  { re: /отч[её]т|аналит|выгруз/i, to: '/reports', label: 'Отчёты' },
  { re: /очеред|оператор|супервиз|монитор/i, to: '/supervisor', label: 'Супервизор' },
  { re: /2-?й лини|тикет|просроч/i, to: '/tickets', label: '2-я линия' },
  { re: /сотрудник|пользоват|рол/i, to: '/users', label: 'Сотрудники' },
  { re: /график|смен/i, to: '/schedule', label: 'График работы' },
  { re: /уведомлен|минимум/i, to: '/notify', label: 'Уведомления' },
  { re: /обучен|курс|тест/i, to: '/courses', label: 'Обучение' },
];
const linksFor = (q: string) => LINKS.filter((l) => l.re.test(q)).map(({ to, label }) => ({ to, label }));

function stubAnswer(
  q: string,
  f: Record<string, number>,
): { answer: string; links: { to: string; label: string }[] } {
  const links = linksFor(q);
  const parts: string[] = [];
  if (/очеред|ожида|сейчас|обстанов|ситуац/i.test(q))
    parts.push(
      `Сейчас в очереди ${f.queued ?? 0}, в работе ${f.in_work ?? 0}; операторов готовы ${f.ready ?? 0}, на перерыве ${f.on_break ?? 0}.`,
    );
  if (/сегодня|за день|сколько.*обращ/i.test(q))
    parts.push(`Сегодня поступило ${f.today_new ?? 0} обращений, закрыто ${f.today_closed ?? 0}.`);
  if (/2-?й лини|тикет|просроч/i.test(q))
    parts.push(`На 2-й линии открыто ${f.tickets_open ?? 0}, из них просрочено ${f.tickets_overdue ?? 0}.`);
  if (/ivr|голосов|меню|приветств/i.test(q))
    parts.push(
      'Голосовое меню меняется в «Сценарии голосовых»: правка схемы → «Проверить» → «Опубликовать»; новые звонки сразу идут по новой версии. Записи фраз — в «Аудиобиблиотеке».',
    );
  if (!parts.length)
    parts.push(
      'Нейросеть пока не подключена — я отвечаю по правилам: обстановка на линии, обращения за сегодня, 2-я линия и просрочка, где что настраивается. ' +
        'Модель подключается в «Подсказки: провайдеры» (провайдер OpenAI-совместимого API, функция «Помощник»).',
    );
  return { answer: parts.join('\n'), links };
}
