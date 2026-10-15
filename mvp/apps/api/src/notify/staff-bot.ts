import { expandPermissions, type Principal, type ScopeRule } from '@cc/auth';
import { REPORT_CATALOG, type ReportKind, reportToCsv, SupervisorThresholdsSchema } from '@cc/contracts';
import { loadStaffTelegram, type StaffKeyboardButton, StaffTelegramApi, type StaffUpdate } from '@cc/domain';
import type { Logger } from '@cc/service-kit';
import type { PoolClient } from 'pg';
import { evaluateWallboard, wallboard } from '../chat/wallboard';
import type { AppContext } from '../context';
import { one } from '../lib/db';
import { buildReport, todayServiceLevel } from '../reports/reports';

const OFFSET_KEY = 'notify.telegram.offset';
const BTN_PANEL = 'Панель';
const BTN_REPORTS = 'Отчёты';
const BTN_BACK = 'Назад';
const BTN_OPEN = 'Открыть панель';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Бот Telegram для сотрудников (Д-010, Д-012): привязка по коду из профиля («/start КОД»), кнопка «Панель» —
 * сводка экрана мониторинга текстом, «Отчёты» — отчёты за последние 7 дней файлом CSV, кнопка мини-приложения
 * (если задан публичный адрес). Права — как в интерфейсе: панель и отчёты видит только тот, у кого есть права, в
 * своей области видимости. Опрос ведёт один экземпляр api (advisory lock), смещение хранится в настройке.
 * Уведомления сотрудникам шлёт worker из очереди `notification`.
 */
export class StaffBot {
  private readonly abort = new AbortController();
  private loop?: Promise<void>;

  constructor(private readonly o: { ctx: AppContext; logger: Logger }) {}

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { signal } = this.abort;
    const { pool } = this.o.ctx;
    while (!signal.aborted) {
      const settings = await loadStaffTelegram(pool).catch(() => null);
      if (!settings?.botToken) {
        await sleep(15_000, signal);
        continue;
      }
      let client: PoolClient | null = null;
      try {
        client = await pool.connect();
        const lock = await client.query<{ ok: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext('staff-bot')) AS ok`,
        );
        if (!lock.rows[0]?.ok) {
          client.release();
          client = null;
          await sleep(15_000, signal);
          continue;
        }
        this.o.logger.info('бот Telegram для сотрудников: опрос начат');
        await this.poll(settings.botToken, settings.apiRoot);
      } catch (err) {
        this.o.logger.warn({ err: String(err) }, 'бот Telegram для сотрудников: ошибка, повтор через 10 с');
        await sleep(10_000, signal);
      } finally {
        if (client) {
          await client.query(`SELECT pg_advisory_unlock_all()`).catch(() => undefined);
          client.release();
        }
      }
    }
  }

  private async poll(token: string, apiRoot: string): Promise<void> {
    const { signal } = this.abort;
    const { pool } = this.o.ctx;
    const api = new StaffTelegramApi(token, apiRoot);
    const saved = await one<{ value: number }>(pool, `SELECT value FROM system_setting WHERE key = $1`, [
      OFFSET_KEY,
    ]);
    let offset = Number(saved?.value ?? 0) || 0;
    let checked = Date.now();
    while (!signal.aborted) {
      if (Date.now() - checked > 60_000) {
        const s = await loadStaffTelegram(pool);
        if (s.botToken !== token || s.apiRoot !== apiRoot) return; // настройки сменились — перезапуск опроса
        checked = Date.now();
      }
      let updates: StaffUpdate[];
      try {
        updates = await api.getUpdates(offset, 20, signal);
      } catch (err) {
        if (signal.aborted) return;
        this.o.logger.warn({ err: String(err) }, 'бот Telegram для сотрудников: getUpdates');
        await sleep(5_000, signal);
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        await this.handle(api, u).catch((err: unknown) =>
          this.o.logger.warn({ err: String(err) }, 'бот Telegram для сотрудников: обработка сообщения'),
        );
      }
      if (updates.length)
        await pool.query(
          `INSERT INTO system_setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [OFFSET_KEY, JSON.stringify(offset)],
        );
    }
  }

  private async keyboard(p: Principal | null): Promise<StaffKeyboardButton[][]> {
    const rows: StaffKeyboardButton[][] = [];
    const main: StaffKeyboardButton[] = [];
    if (p?.permissions.has('supervisor.monitor')) main.push({ text: BTN_PANEL });
    if (p?.permissions.has('reports.view')) main.push({ text: BTN_REPORTS });
    if (main.length) rows.push(main);
    const s = await loadStaffTelegram(this.o.ctx.pool);
    if (s.miniAppUrl && p?.permissions.has('supervisor.monitor'))
      rows.push([{ text: BTN_OPEN, web_app: { url: s.miniAppUrl } }]);
    return rows;
  }

  private async handle(api: StaffTelegramApi, u: StaffUpdate): Promise<void> {
    const msg = u.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const { pool } = this.o.ctx;
    const say = async (t: string, p: Principal | null) => api.sendMessage(chatId, t, await this.keyboard(p));
    if (text.startsWith('/start')) {
      const code = text.split(/\s+/)[1];
      if (code) {
        const linked = await one<{ id: string; full_name: string }>(
          pool,
          `UPDATE app_user SET telegram_chat_id = $1, telegram_linked_at = now(), telegram_link_code = NULL, updated_at = now()
            WHERE telegram_link_code = $2 AND is_active AND can_login RETURNING id, full_name`,
          [chatId, code],
        );
        if (linked) {
          // Один чат — один сотрудник: прежняя привязка этого чата к другому сотруднику снимается.
          await pool.query(
            `UPDATE app_user SET telegram_chat_id = NULL WHERE telegram_chat_id = $1 AND id <> $2`,
            [chatId, linked.id],
          );
          const p = await this.principalFor(linked.id);
          await say(
            `Telegram привязан: ${linked.full_name}. Сюда будут приходить уведомления, которые вы включили в профиле.`,
            p,
          );
          return;
        }
        await say(
          'Код не найден или уже использован. Получите новый код: «Профиль → Уведомления → Привязать Telegram».',
          null,
        );
        return;
      }
    }
    const user = await one<{ id: string; full_name: string }>(
      pool,
      `SELECT id, full_name FROM app_user WHERE telegram_chat_id = $1 AND is_active AND can_login`,
      [chatId],
    );
    if (!user) {
      await say(
        'Это бот контакт-центра для сотрудников. Чтобы привязать Telegram, откройте «Профиль → Уведомления», получите код и отправьте сюда: /start КОД',
        null,
      );
      return;
    }
    const p = await this.principalFor(user.id);
    if (!p) return;
    if (text === BTN_PANEL || text === '/panel') {
      if (!p.permissions.has('supervisor.monitor'))
        return void (await say('Нет доступа к панели мониторинга.', p));
      await say(await this.panelText(p), p);
      return;
    }
    if (text === BTN_REPORTS || text === '/reports') {
      if (!p.permissions.has('reports.view')) return void (await say('Нет доступа к отчётам.', p));
      const titles = Object.values(REPORT_CATALOG).map((r) => [{ text: r.title }]);
      await api.sendMessage(chatId, 'Какой отчёт прислать (за последние 7 дней, файл CSV)?', [
        ...titles,
        [{ text: BTN_BACK }],
      ]);
      return;
    }
    if (text === BTN_BACK) return void (await say('Главное меню.', p));
    const kind = (Object.keys(REPORT_CATALOG) as ReportKind[]).find((k) => REPORT_CATALOG[k].title === text);
    if (kind) {
      if (!p.permissions.has('reports.view')) return void (await say('Нет доступа к отчётам.', p));
      const r = await buildReport(kind, { db: pool, principal: p, filter: {} });
      await api.sendDocument(
        chatId,
        {
          filename: `${kind}-${r.from}-${r.to}.csv`,
          contentType: 'text/csv',
          body: Buffer.from(reportToCsv(r), 'utf8'),
        },
        `${r.title} · ${r.from} — ${r.to}`,
      );
      return;
    }
    await say(
      `${user.full_name}, доступны кнопки ниже. Уведомления настраиваются в профиле («Профиль → Уведомления»).`,
      p,
    );
  }

  /** Сводка экрана мониторинга текстом (как плитки и проблемы на экране). */
  private async panelText(p: Principal): Promise<string> {
    const { pool } = this.o.ctx;
    const thRow = await one<{ value: unknown }>(
      pool,
      `SELECT value FROM system_setting WHERE key = 'supervisor.thresholds'`,
    );
    const parsed = SupervisorThresholdsSchema.safeParse(thRow?.value ?? {});
    const th = parsed.success ? parsed.data : SupervisorThresholdsSchema.parse({});
    const sl = await todayServiceLevel(pool, p);
    const answered = sl.reduce((a, s) => a + s.answered, 0);
    const abandoned = sl.reduce((a, s) => a + s.abandoned, 0);
    const offered = sl.filter((s) => s.slPct !== null);
    const weight = (s: (typeof sl)[number]) => s.answered + s.abandoned;
    const wsum = offered.reduce((a, s) => a + weight(s), 0);
    const slPct = wsum ? offered.reduce((a, s) => a + (s.slPct ?? 0) * weight(s), 0) / wsum : null;
    const raw = await wallboard(pool, p);
    const n = raw.now;
    const ev = evaluateWallboard({
      operators: raw.operators.map((o) => ({ status: o.status, onCall: o.on_call, inChat: o.in_chat })),
      now: {
        talking: n.talking ?? 0,
        ivr: n.ivr ?? 0,
        qVoice: n.q_voice ?? 0,
        qText: n.q_text ?? 0,
        oldestWaitS: n.oldest ?? 0,
        chats: n.chats ?? 0,
        bot: n.bot ?? 0,
        overdue: n.overdue ?? 0,
        unclosedCards: n.unclosed_cards ?? 0,
      },
      buckets: raw.buckets.map((b) => ({
        at: new Date(b.at).toISOString(),
        received: b.received,
        usual: Number(b.usual),
        maxWaitS: b.max_wait ?? 0,
        lost: b.lost,
      })),
      today: { received: 0, answered, abandoned, slPct, asaS: null },
      resources: [],
      th,
    });
    const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const level = ev.level === 'ok' ? 'всё в норме' : ev.level === 'warn' ? 'внимание' : 'проблема';
    const at = new Date().toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Minsk',
      hour: '2-digit',
      minute: '2-digit',
    });
    const lines = [
      `OMNI · ${at} — ${level}`,
      ...ev.problems.map((x) => `• ${x.text}`),
      '',
      `Сейчас: звонков в очереди ${n.q_voice ?? 0}, чатов в очереди ${n.q_text ?? 0}, дольше всех ждёт ${
        (n.q_voice ?? 0) + (n.q_text ?? 0) ? mmss(n.oldest ?? 0) : '—'
      }`,
      `Идут разговоры: ${n.talking ?? 0}, чатов в работе: ${n.chats ?? 0}, в голосовом меню: ${n.ivr ?? 0}`,
      `Операторы на линии: ${ev.operators.online} (свободны ${ev.operators.free}, заняты ${ev.operators.busy}, постобработка ${ev.operators.wrapUp}, перерыв ${ev.operators.onBreak})`,
      `Сегодня: принято ${answered}, не дождались ${abandoned}, уровень сервиса ${slPct === null ? '—' : `${Math.round(slPct)} %`}`,
    ];
    return lines.join('\n');
  }

  /** Сотрудник как субъект прав (без сессии): роли, права и область видимости — как у входа в интерфейс. */
  private async principalFor(userId: string): Promise<Principal | null> {
    const { pool } = this.o.ctx;
    const u = await one<{
      id: string;
      full_name: string;
      email: string;
      roles: string[] | null;
      permissions: string[] | null;
      sees_unclassified: boolean | null;
    }>(
      pool,
      `SELECT u.id, u.full_name, u.email, u.sees_unclassified,
              array_remove(array_agg(DISTINCT ur.role_code), NULL) AS roles,
              (SELECT array_agg(DISTINCT p) FROM user_role ur2 JOIN role r ON r.code = ur2.role_code,
                      unnest(r.permissions) p WHERE ur2.user_id = u.id) AS permissions
         FROM app_user u LEFT JOIN user_role ur ON ur.user_id = u.id
        WHERE u.id = $1 AND u.is_active AND u.can_login GROUP BY u.id`,
      [userId],
    );
    if (!u) return null;
    const permissions = expandPermissions(u.permissions ?? []);
    const scopes = await pool.query<{
      enterprise_ids: string[] | null;
      department_ids: string[] | null;
      topic_ids: string[] | null;
    }>('SELECT enterprise_ids, department_ids, topic_ids FROM access_scope WHERE user_id = $1', [userId]);
    const rules: ScopeRule[] = scopes.rows.map((r) => ({
      enterpriseIds: r.enterprise_ids,
      departmentIds: r.department_ids,
      topicIds: r.topic_ids,
    }));
    return {
      id: u.id,
      sessionId: 'telegram-bot',
      fullName: u.full_name,
      email: u.email,
      roles: u.roles ?? [],
      permissions,
      scope: {
        all: permissions.has('scope.all'),
        rules,
        unclassified: u.sees_unclassified ?? permissions.has('scope.unclassified'),
      },
    };
  }
}
