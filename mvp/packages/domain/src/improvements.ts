import { newId } from '@cc/contracts';
import type { Pool, PoolClient } from 'pg';

/**
 * Робот предложений по улучшению (Д-098) и кандидатов в шаблоны ответов (Д-099). Без нейросети — правила по данным
 * за последние 30 дней (с нейросетью позже добавятся формулировки и новые находки). Каждое правило даёт находки
 * «тема / подразделение / поле / час → частота и метрики»; находка обновляет ту же запись (rule + subject_key), не
 * трогая статус и заметку, выставленные людьми. Не найденные в этот раз записи помечаются is_current = false.
 */
export type ImprovementCategory = 'software' | 'process' | 'knowledge' | 'staff' | 'automation';

interface Finding {
  rule: string;
  subject: string;
  title: string;
  details: string;
  category: ImprovementCategory;
  topicId?: string | null;
  frequency: number;
  /** Насколько серьёзно (1 — мелочь, 3 — важно): рейтинг = вес × частота (логарифмически). */
  weight: number;
  metrics?: Record<string, unknown>;
}

/**
 * Рейтинг 1–100: вес правила (1–3) × частота по логарифму относительно 200 случаев — 200 и больше случаев важного
 * правила дают 100, единичный случай — несколько баллов.
 */
export function improvementRating(weight: number, frequency: number): number {
  const f = Math.log(1 + Math.max(0, frequency)) / Math.log(201);
  return Math.max(1, Math.min(100, Math.round((weight / 3) * 100 * f)));
}

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : 100);

type Db = Pool | PoolClient;

async function findings(db: Db, now: Date): Promise<Finding[]> {
  const out: Finding[] = [];
  const q = <T extends Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    db.query<T>(sql, [now, ...p]).then((r) => r.rows);

  // 1. Частые темы и рост обращений по теме (30 дней против предыдущих 30).
  const topics = await q<{ id: string; name: string; cur: number; prev: number }>(
    `SELECT t.id, t.name,
            count(*) FILTER (WHERE c.created_at > $1::timestamptz - interval '30 days')::int AS cur,
            count(*) FILTER (WHERE c.created_at <= $1::timestamptz - interval '30 days')::int AS prev
       FROM conversation c JOIN topic t ON t.id = c.topic_id
      WHERE c.created_at > $1::timestamptz - interval '60 days'
      GROUP BY t.id, t.name`,
  );
  const top = [...topics].sort((a, b) => b.cur - a.cur).slice(0, 5);
  for (const t of top)
    if (t.cur >= 5)
      out.push({
        rule: 'topic_top',
        subject: t.id,
        title: `Частая тема «${t.name}»: ${t.cur} обращений за 30 дней`,
        details:
          'Одна из самых частых тем. Проверьте, можно ли ответить автоматически: сценарий бота или голосового меню, ' +
          'шаблон ответа, статья в базе знаний, информация на сайте или в приложении.',
        category: 'automation',
        topicId: t.id,
        frequency: t.cur,
        weight: 2,
        metrics: { cur: t.cur, prev: t.prev },
      });
  // Рост — только заметный (от 10 обращений и на 50 %), 10 самых больших приростов.
  const growth = topics
    .filter((t) => t.cur >= 10 && t.cur >= t.prev * 1.5 && t.cur - t.prev >= 5)
    .sort((a, b) => b.cur - b.prev - (a.cur - a.prev))
    .slice(0, 10);
  for (const t of growth)
    out.push({
      rule: 'topic_growth',
      subject: t.id,
      title: `Рост обращений по теме «${t.name}»: ${t.cur} за 30 дней (${t.prev ? `+${pct(t.cur, t.prev)} %` : 'раньше не было'})`,
      details:
        'Число обращений заметно выросло. Найдите причину (сбой, изменение условий, акция, ошибка на АЗС или в ' +
        'приложении) и устраните её в бизнес-процессе.',
      category: 'process',
      topicId: t.id,
      frequency: t.cur,
      weight: 3,
      metrics: { cur: t.cur, prev: t.prev, growthPct: pct(t.cur, t.prev) },
    });

  // 2. Повторные обращения клиента по той же теме в течение 3 дней — вопрос не решён с первого раза.
  const repeats = await q<{ id: string; name: string; n: number }>(
    `SELECT t.id, t.name, count(*)::int AS n
       FROM conversation c JOIN topic t ON t.id = c.topic_id
      WHERE c.created_at > $1::timestamptz - interval '30 days'
        AND EXISTS (SELECT 1 FROM conversation p WHERE p.contact_id = c.contact_id AND p.topic_id = c.topic_id
                     AND p.id <> c.id AND p.created_at < c.created_at
                     AND p.created_at > c.created_at - interval '3 days')
      GROUP BY t.id, t.name HAVING count(*) >= 2`,
  );
  for (const r of repeats)
    out.push({
      rule: 'repeat_contacts',
      subject: r.id,
      title: `Клиенты обращаются повторно по теме «${r.name}»: ${r.n} раз за 30 дней`,
      details:
        'Клиент снова пишет или звонит по той же теме в течение 3 дней — вопрос не решается с первого раза. ' +
        'Проверьте полноту ответов операторов и сроки решения на 2-й линии.',
      category: 'process',
      topicId: r.id,
      frequency: r.n,
      weight: 3,
    });

  // 3. Низкая оценка клиентов по теме.
  const csat = await q<{ id: string; name: string; n: number; avg: number }>(
    `SELECT t.id, t.name, count(*)::int AS n, round(avg(r.score)::numeric, 2)::float AS avg
       FROM csat_rating r JOIN conversation c ON c.id = r.conversation_id JOIN topic t ON t.id = c.topic_id
      WHERE r.created_at > $1::timestamptz - interval '30 days'
      GROUP BY t.id, t.name HAVING count(*) >= 3 AND avg(r.score) <= 3.5`,
  );
  for (const r of csat)
    out.push({
      rule: 'low_csat',
      subject: r.id,
      title: `Низкая оценка клиентов по теме «${r.name}»: ${r.avg} из 5 (${r.n} оценок)`,
      details:
        'Клиенты недовольны обслуживанием по этой теме. Разберите разговоры с низкой оценкой, дополните обучение ' +
        'операторов и базу знаний.',
      category: 'knowledge',
      topicId: r.id,
      frequency: r.n,
      weight: 3,
      metrics: { avg: r.avg },
    });

  // 4. 2-я линия: просрочки и возвраты на доработку по подразделениям.
  const tickets = await q<{ id: string; name: string; overdue: number; returns: number }>(
    `SELECT d.id, d.name,
            count(*) FILTER (WHERE (t.closed_at IS NULL AND t.due_date < ($1::timestamptz)::date)
                                OR t.closed_in_time = false)::int AS overdue,
            COALESCE(sum(t.returns_count), 0)::int AS returns
       FROM ticket t JOIN department d ON d.id = t.department_id
      WHERE t.created_at > $1::timestamptz - interval '30 days'
      GROUP BY d.id, d.name`,
  );
  for (const d of tickets) {
    if (d.overdue >= 2)
      out.push({
        rule: 'ticket_overdue',
        subject: d.id,
        title: `Подразделение «${d.name}» нарушает сроки 2-й линии: ${d.overdue} обращений за 30 дней`,
        details:
          'Ответы 2-й линии просрочены. Проверьте нагрузку и ответственных по матрице, срок ответа и напоминания.',
        category: 'process',
        frequency: d.overdue,
        weight: 2,
      });
    if (d.returns >= 2)
      out.push({
        rule: 'ticket_returns',
        subject: d.id,
        title: `Ответы подразделения «${d.name}» возвращают на доработку: ${d.returns} раз за 30 дней`,
        details:
          'Куратор не принимает ответы с первого раза — уточните требования к ответу и проведите разбор.',
        category: 'process',
        frequency: d.returns,
        weight: 2,
      });
  }

  // 5. Нейросеть часто ошибается в одном поле карточки (оператор исправляет подсказку).
  const ai = await q<{ field: string; label: string; n: number }>(
    `SELECT field, max(label) AS label, count(*)::int AS n FROM ai_correction
      WHERE created_at > $1::timestamptz - interval '30 days' GROUP BY field HAVING count(*) >= 3`,
  );
  for (const a of ai)
    out.push({
      rule: 'ai_corrections',
      subject: a.field,
      title: `Нейросеть часто ошибается в поле «${a.label || a.field}»: ${a.n} исправлений за 30 дней`,
      details:
        'Операторы исправляют подсказку нейросети в этом поле. Доработайте правила или обучение модели, проверьте ' +
        'справочник значений поля.',
      category: 'software',
      frequency: a.n,
      weight: 2,
    });

  // 6. Долгое ожидание в очереди по часам — не хватает операторов.
  const waits = await q<{ h: number; n: number; avg: number }>(
    `SELECT EXTRACT(HOUR FROM c.queued_at AT TIME ZONE 'Europe/Minsk')::int AS h, count(*)::int AS n,
            round(avg(extract(epoch FROM c.assigned_at - c.queued_at)))::int AS avg
       FROM conversation c
      WHERE c.queued_at > $1::timestamptz - interval '30 days' AND c.assigned_at IS NOT NULL
        AND c.assigned_at >= c.queued_at
      GROUP BY 1 HAVING count(*) >= 5 AND avg(extract(epoch FROM c.assigned_at - c.queued_at)) >= 120`,
  );
  // Одна находка на все такие часы: «с 9 до 13, с 14 до 21» и худший час.
  if (waits.length) {
    const hours = waits.map((w) => w.h).sort((a, b) => a - b);
    const ranges: string[] = [];
    for (let i = 0; i < hours.length; i++) {
      let j = i;
      while (j + 1 < hours.length && hours[j + 1] === hours[j]! + 1) j++;
      ranges.push(`${hours[i]}:00–${hours[j]! + 1}:00`);
      i = j;
    }
    const worst = [...waits].sort((a, b) => b.avg - a.avg)[0]!;
    out.push({
      rule: 'queue_wait',
      subject: 'hours',
      title: `Клиенты долго ждут оператора: ${ranges.join(', ')} (хуже всего с ${worst.h}:00 — в среднем ${Math.round(worst.avg / 60)} мин)`,
      details:
        'В эти часы ожидание в очереди в среднем дольше 2 минут. Пересмотрите график смен и перерывов, минимум ' +
        'операторов на линии («Уведомления → Минимум операторов»).',
      category: 'staff',
      frequency: waits.reduce((n, w) => n + w.n, 0),
      weight: 2,
      metrics: { hours: waits },
    });
  }

  // 7. Тема без статьи в базе знаний.
  for (const t of topics.filter((x) => x.cur >= 5)) {
    const kb = await db.query(`SELECT 1 FROM kb_article WHERE is_active AND $1 = ANY(topic_ids) LIMIT 1`, [
      t.id,
    ]);
    if (!kb.rowCount)
      out.push({
        rule: 'no_kb',
        subject: t.id,
        title: `Нет статьи в базе знаний по теме «${t.name}» (${t.cur} обращений за 30 дней)`,
        details: 'Операторы отвечают по памяти. Подготовьте статью в базе знаний и привяжите её к теме.',
        category: 'knowledge',
        topicId: t.id,
        frequency: t.cur,
        weight: 1,
      });
  }
  return out;
}

/** Нормализация ответа для поиска повторов: регистр, пробелы, числа. */
export function templateKey(body: string): string {
  return body
    .toLowerCase()
    .replace(/\d+/g, '0')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Д-099: частые ответы операторов (одинаковые после нормализации, не из шаблонов и не автоответы) — кандидаты в
 * шаблоны. Уже существующие шаблоны и отклонённые людьми кандидаты не предлагаются снова.
 */
async function templateCandidates(db: Db, now: Date): Promise<number> {
  const rows = await db.query<{ body: string; author: string; topic_id: string | null }>(
    `SELECT m.body, m.author_user_id AS author, c.topic_id
       FROM message m JOIN conversation c ON c.id = m.conversation_id
      WHERE m.direction = 'out' AND m.author_user_id IS NOT NULL AND m.meta ->> 'auto' IS NULL
        AND m.sent_at > $1::timestamptz - interval '60 days' AND length(m.body) BETWEEN 40 AND 1500`,
    [now],
  );
  const groups = new Map<
    string,
    { bodies: Map<string, number>; authors: Set<string>; topics: Map<string, number>; n: number }
  >();
  for (const r of rows.rows) {
    const key = templateKey(r.body);
    if (key.length < 30) continue;
    const g = groups.get(key) ?? { bodies: new Map(), authors: new Set(), topics: new Map(), n: 0 };
    g.n++;
    g.bodies.set(r.body.trim(), (g.bodies.get(r.body.trim()) ?? 0) + 1);
    g.authors.add(r.author);
    if (r.topic_id) g.topics.set(r.topic_id, (g.topics.get(r.topic_id) ?? 0) + 1);
    groups.set(key, g);
  }
  const existing = new Set(
    (await db.query<{ body: string }>(`SELECT body FROM reply_template WHERE is_active`)).rows.map((r) =>
      templateKey(r.body),
    ),
  );
  let n = 0;
  for (const [key, g] of groups) {
    if (g.n < 3 || existing.has(key)) continue;
    const body = [...g.bodies.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const topic = [...g.topics.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    await db.query(
      `INSERT INTO template_suggestion (id, text_key, body, uses, operators, topic_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (text_key) DO UPDATE SET body = EXCLUDED.body, uses = EXCLUDED.uses,
         operators = EXCLUDED.operators, topic_id = EXCLUDED.topic_id, last_seen_at = now()`,
      [newId(), key, body, g.n, g.authors.size, topic],
    );
    n++;
  }
  return n;
}

export interface ImprovementRun {
  proposals: number;
  templates: number;
}

/** Анализ целиком: предложения (Д-098) и кандидаты в шаблоны (Д-099). Один запуск одновременно. */
export async function analyzeImprovements(pool: Pool, now = new Date()): Promise<ImprovementRun | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('improvements.analyze')) AS ok`,
    );
    if (!lock.rows[0]?.ok) {
      await client.query('ROLLBACK');
      return null;
    }
    const found = await findings(client, now);
    const templates = await templateCandidates(client, now);
    if (templates)
      found.push({
        rule: 'templates',
        subject: 'all',
        title: `Операторы часто пишут одинаковые ответы: ${templates} — сохраните их как шаблоны`,
        details: 'Список — на вкладке «Кандидаты в шаблоны»: «Сохранить шаблоном» или «Не нужно».',
        category: 'automation',
        frequency: templates,
        weight: 1,
      });
    await client.query(`UPDATE improvement_proposal SET is_current = false WHERE rule <> 'manual'`);
    for (const f of found)
      await client.query(
        `INSERT INTO improvement_proposal (id, rule, subject_key, title, details, category, topic_id, frequency, rating, metrics)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (rule, subject_key) DO UPDATE SET title = EXCLUDED.title, details = EXCLUDED.details,
           category = EXCLUDED.category, topic_id = EXCLUDED.topic_id, frequency = EXCLUDED.frequency,
           rating = EXCLUDED.rating, metrics = EXCLUDED.metrics, is_current = true, last_seen_at = now()`,
        [
          newId(),
          f.rule,
          f.subject,
          f.title,
          f.details,
          f.category,
          f.topicId ?? null,
          f.frequency,
          improvementRating(f.weight, f.frequency),
          JSON.stringify(f.metrics ?? {}),
        ],
      );
    await client.query(
      `INSERT INTO system_setting (key, value) VALUES ('improvements.last_run', to_jsonb($1::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [now.toISOString()],
    );
    await client.query('COMMIT');
    return { proposals: found.length, templates };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
