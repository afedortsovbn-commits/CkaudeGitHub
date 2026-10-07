import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { newId } from '@cc/contracts';
import type { Principal } from '@cc/auth';
import {
  type BreakRules,
  DEFAULT_BREAK_RULES,
  DEFAULT_SCHEDULE_RULES,
  dateToMonthMinute,
  generateMonth,
  monthDays,
  monthMinuteToDate,
  type PlannedBreak,
  type PlannedShift,
  planBreaks,
  type ScheduleRules,
  type StaffIn,
  type StaffRuleIn,
} from '@cc/domain';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { badRequest, notFound, parse } from '../lib/errors';

type Db = Pool | PoolClient;
const uuid = z.string().uuid();
const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Месяц вида ГГГГ-ММ');
const dayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата вида ГГГГ-ММ-ДД');
const minuteOfDay = z.number().int().min(0).max(1440);

const TemplateBody = z
  .object({
    code: z.string().trim().min(1).max(10),
    name: z.string().trim().min(1).max(100),
    startMin: z.number().int().min(0).max(1439),
    durationMin: z.number().int().min(60).max(1440),
    isNight: z.boolean(),
    color: z.string().max(20).nullable().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
const DemandBody = z
  .object({
    weekday: z.array(
      z.object({
        templateId: uuid,
        weekday: z.number().int().min(1).max(7),
        required: z.number().int().min(0).max(100),
      }),
    ),
    dates: z.array(z.object({ templateId: uuid, date: dayStr, required: z.number().int().min(0).max(100) })),
  })
  .strict();
const PrefsBody = z
  .object({
    shiftLengths: z.array(z.union([z.literal(8), z.literal(12)])).min(1),
    night: z.enum(['prefer', 'ok', 'no']),
    weekdays: z.record(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.enum(['prefer', 'avoid', 'off'])),
    maxHours: z.number().int().min(1).max(400).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
    /** Только на этот месяц (ГГГГ-ММ); пусто — постоянно. */
    month: monthStr.nullable().optional(),
    /** Сохраняются постоянно изменения этого месяца — изменение на месяц удаляется. */
    permanentFrom: monthStr.optional(),
  })
  .strict();
const RuleBody = z
  .object({
    kind: z.enum(['unavailable', 'preferred']),
    dateFrom: dayStr.nullable().optional(),
    dateTo: dayStr.nullable().optional(),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).nullable().optional(),
    timeFrom: minuteOfDay.nullable().optional(),
    timeTo: minuteOfDay.nullable().optional(),
    /** Только на этот месяц (ГГГГ-ММ); пусто — постоянно. */
    month: monthStr.nullable().optional(),
    comment: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((r) => !r.dateFrom || !r.dateTo || r.dateFrom <= r.dateTo, 'Период указан неверно')
  .refine(
    (r) => (r.timeFrom == null) === (r.timeTo == null),
    'Укажите время «с» и «по» или не указывайте совсем',
  );
const ShiftBody = z
  .object({ month: monthStr, userId: uuid, date: dayStr, templateId: uuid.nullable() })
  .strict();
const BreakBody = z.object({ startMin: minuteOfDay }).strict();

const firstDay = (month: string) => `${month}-01`;

const breakSet = z
  .object({ long: z.number().int().min(0).max(240), short: z.array(z.number().int().min(5).max(60)).max(6) })
  .strict();
/** Перерывы дневной и ночной смены, минуты. */
export const ScheduleBreaksSchema = z.object({ day: breakSet, night: breakSet }).strict();
/** Нормы трудового законодательства для составления графика. */
export const ScheduleRulesSchema = z
  .object({
    restFactor: z.number().min(0).max(5),
    maxConsecutiveDays: z.number().int().min(1).max(14),
    maxShiftHours: z.number().int().min(4).max(24),
    monthNormHours: z.number().int().min(1).max(400),
    normTolerancePct: z.number().int().min(0).max(100),
    breakLateMin: z.number().int().min(1).max(60),
  })
  .strict();

/**
 * График работы персонала: смены, потребность, пожелания сотрудников, автосоставление графика на месяц,
 * ручная правка и публикация; «мой график» для оператора.
 */
@Controller('api/v1/schedule')
export class ScheduleController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  // ---------- Смены (справочник) ----------

  @Get('templates')
  @RequirePerm('schedule.manage', 'conversations.work')
  async templates(@Query('active') active?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT * FROM shift_template WHERE ($1::boolean OR is_active) ORDER BY sort_order, start_min`,
      [active === 'all'],
    );
    return list.map((r) => toApi(r));
  }

  @Post('templates')
  @RequirePerm('schedule.manage')
  async createTemplate(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(TemplateBody, body);
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `INSERT INTO shift_template (id, code, name, start_min, duration_min, is_night, color, sort_order, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          b.code,
          b.name,
          b.startMin,
          b.durationMin,
          b.isNight,
          b.color ?? null,
          b.sortOrder ?? 0,
          b.isActive ?? true,
        ],
      );
      const row = await one(tx, 'SELECT * FROM shift_template WHERE id = $1', [id]);
      await audit(tx, p, 'create', 'shift_template', id, null, row);
      return toApi(row!);
    });
  }

  @Patch('templates/:id')
  @RequirePerm('schedule.manage')
  async patchTemplate(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(TemplateBody.partial(), body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, 'SELECT * FROM shift_template WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Смена');
      const cols: Record<string, unknown> = {
        code: b.code,
        name: b.name,
        start_min: b.startMin,
        duration_min: b.durationMin,
        is_night: b.isNight,
        color: b.color,
        sort_order: b.sortOrder,
        is_active: b.isActive,
      };
      const set = Object.entries(cols).filter(([, v]) => v !== undefined);
      if (set.length)
        await tx.query(
          `UPDATE shift_template SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
          [id, ...set.map(([, v]) => v)],
        );
      const after = await one(tx, 'SELECT * FROM shift_template WHERE id = $1', [id]);
      await audit(tx, p, 'update', 'shift_template', id, before, after);
      return toApi(after!);
    });
  }

  // ---------- Потребность ----------

  @Get('demand')
  @RequirePerm('schedule.manage')
  async demand(@Query('month') month?: string) {
    const list = await rows<Record<string, unknown>>(
      this.ctx.pool,
      `SELECT template_id, weekday, to_char(on_date, 'YYYY-MM-DD') AS date, required FROM schedule_demand
        WHERE on_date IS NULL OR $1::date IS NULL OR date_trunc('month', on_date) = $1::date ORDER BY on_date NULLS FIRST, weekday`,
      [month ? firstDay(parse(monthStr, month)) : null],
    );
    return {
      weekday: list.filter((r) => r.weekday != null).map((r) => toApi(r)),
      dates: list.filter((r) => r.date != null).map((r) => toApi(r)),
    };
  }

  @Put('demand')
  @RequirePerm('schedule.manage')
  async putDemand(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(DemandBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('DELETE FROM schedule_demand');
      for (const d of b.weekday)
        await tx.query(
          'INSERT INTO schedule_demand (id, template_id, weekday, required) VALUES ($1,$2,$3,$4)',
          [newId(), d.templateId, d.weekday, d.required],
        );
      for (const d of b.dates)
        await tx.query(
          'INSERT INTO schedule_demand (id, template_id, on_date, required) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [newId(), d.templateId, d.date, d.required],
        );
      await audit(tx, p, 'update', 'schedule_demand', null, null, b);
    });
    return this.demand();
  }

  // ---------- Сотрудники: пожелания и правила ----------

  /** Операторы для графика: право рабочего места, без прав супервизора и администратора. */
  private async staffList(db: Db) {
    return rows<{ id: string; full_name: string; email: string }>(
      db,
      `SELECT u.id, u.full_name, u.email FROM app_user u
        WHERE u.is_active AND u.can_login
          AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                       WHERE ur.user_id = u.id AND 'conversations.work' = ANY(r.permissions))
          AND NOT EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.code = ur.role_code
                           WHERE ur.user_id = u.id AND r.permissions && ARRAY['supervisor.monitor', 'admin.settings', 'admin.users'])
        ORDER BY u.full_name`,
    );
  }

  private async staffWithPrefs(db: Db, month: string) {
    const staff = await this.staffList(db);
    const prefs = await rows<Record<string, unknown>>(
      db,
      // Сначала изменение на месяц, затем постоянные.
      'SELECT * FROM staff_pref WHERE user_id = ANY($1) AND (month IS NULL OR month = $2::date) ORDER BY month NULLS LAST',
      [staff.map((s) => s.id), firstDay(month)],
    );
    const rules = await rows<Record<string, unknown>>(
      db,
      `SELECT id, user_id, kind, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to,
              weekdays, time_from, time_to, to_char(month, 'YYYY-MM') AS month, comment
         FROM staff_rule WHERE user_id = ANY($1) AND (month IS NULL OR month = $2::date) ORDER BY created_at`,
      [staff.map((s) => s.id), firstDay(month)],
    );
    return staff.map((s) => {
      const pr = prefs.find((x) => x.user_id === s.id);
      return {
        userId: s.id,
        name: s.full_name,
        email: s.email,
        prefs: {
          shiftLengths: (pr?.shift_lengths as number[] | undefined) ?? [8, 12],
          night: (pr?.night as string | undefined) ?? 'ok',
          weekdays: (pr?.weekdays as Record<string, string> | undefined) ?? {},
          maxHours: (pr?.max_hours as number | null | undefined) ?? null,
          note: (pr?.note as string | null | undefined) ?? null,
        },
        /** Пожелания изменены только на этот месяц. */
        prefsForMonth: pr?.month != null,
        rules: rules.filter((r) => r.user_id === s.id).map((r) => toApi(r)),
      };
    });
  }

  @Get('staff')
  @RequirePerm('schedule.manage')
  async staff(@Query('month') month: string) {
    return this.staffWithPrefs(this.ctx.pool, parse(monthStr, month));
  }

  @Put('staff/:userId/prefs')
  @RequirePerm('schedule.manage')
  async putPrefs(@CurrentUser() p: Principal, @Param('userId') userId: string, @Body() body: unknown) {
    const b = parse(PrefsBody, body);
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `INSERT INTO staff_pref (user_id, month, shift_lengths, night, weekdays, max_hours, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, COALESCE(month, DATE '1900-01-01')) DO UPDATE SET shift_lengths = EXCLUDED.shift_lengths,
           night = EXCLUDED.night, weekdays = EXCLUDED.weekdays, max_hours = EXCLUDED.max_hours, note = EXCLUDED.note,
           updated_at = now()`,
        [
          parse(uuid, userId),
          b.month ? firstDay(b.month) : null,
          b.shiftLengths,
          b.night,
          JSON.stringify(b.weekdays),
          b.maxHours ?? null,
          b.note ?? null,
        ],
      );
      // Сохранено постоянно — изменение на месяц (если было) больше не нужно.
      if (b.permanentFrom)
        await tx.query('DELETE FROM staff_pref WHERE user_id = $1 AND month = $2', [
          userId,
          firstDay(b.permanentFrom),
        ]);
      await audit(tx, p, 'update', 'staff_pref', userId, null, b);
    });
    return { ok: true };
  }

  /** Вернуть постоянные пожелания: удалить изменение на месяц. */
  @Delete('staff/:userId/prefs')
  @RequirePerm('schedule.manage')
  async resetPrefs(
    @CurrentUser() p: Principal,
    @Param('userId') userId: string,
    @Query('month') month: string,
  ) {
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query('DELETE FROM staff_pref WHERE user_id = $1 AND month = $2', [
        parse(uuid, userId),
        firstDay(parse(monthStr, month)),
      ]);
      await audit(tx, p, 'delete', 'staff_pref', userId, null, { month });
    });
    return { ok: true };
  }

  @Post('staff/:userId/rules')
  @RequirePerm('schedule.manage')
  async addRule(@CurrentUser() p: Principal, @Param('userId') userId: string, @Body() body: unknown) {
    const b = parse(RuleBody, body);
    const id = newId();
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query(
        `INSERT INTO staff_rule (id, user_id, kind, date_from, date_to, weekdays, time_from, time_to, month, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          parse(uuid, userId),
          b.kind,
          b.dateFrom ?? null,
          b.dateTo ?? null,
          b.weekdays?.length ? b.weekdays : null,
          b.timeFrom ?? null,
          b.timeTo ?? null,
          b.month ? firstDay(b.month) : null,
          b.comment ?? null,
        ],
      );
      await audit(tx, p, 'create', 'staff_rule', id, null, b);
    });
    return { id };
  }

  @Delete('rules/:id')
  @RequirePerm('schedule.manage')
  async deleteRule(@CurrentUser() p: Principal, @Param('id') id: string) {
    await withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query('DELETE FROM staff_rule WHERE id = $1', [parse(uuid, id)]);
      if (!r.rowCount) throw notFound('Правило');
      await audit(tx, p, 'delete', 'staff_rule', id, null, null);
    });
    return { ok: true };
  }

  /** Правило «только на этот месяц» — сохранить за сотрудником постоянно. */
  @Post('rules/:id/permanent')
  @HttpCode(200)
  @RequirePerm('schedule.manage')
  async makePermanent(@CurrentUser() p: Principal, @Param('id') id: string) {
    await withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query('UPDATE staff_rule SET month = NULL WHERE id = $1', [parse(uuid, id)]);
      if (!r.rowCount) throw notFound('Правило');
      await audit(tx, p, 'update', 'staff_rule', id, null, { month: null });
    });
    return { ok: true };
  }

  @Get('settings')
  @RequirePerm('schedule.manage')
  async getSettings() {
    return this.settings(this.ctx.pool);
  }

  @Put('settings')
  @RequirePerm('schedule.manage')
  async putSettings(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(z.object({ rules: ScheduleRulesSchema, breaks: ScheduleBreaksSchema }).strict(), body);
    await withTx(this.ctx.pool, async (tx) => {
      const before = await this.settings(tx);
      for (const [k, v] of [
        ['schedule.rules', b.rules],
        ['schedule.breaks', b.breaks],
      ] as const)
        await tx.query(
          `INSERT INTO system_setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [k, JSON.stringify(v)],
        );
      await audit(tx, p, 'update', 'system_setting', null, before, b);
    });
    return this.settings(this.ctx.pool);
  }

  // ---------- График на месяц ----------

  private async settings(db: Db): Promise<{ rules: ScheduleRules; breaks: BreakRules }> {
    const r = await rows<{ key: string; value: unknown }>(
      db,
      `SELECT key, value FROM system_setting WHERE key IN ('schedule.rules', 'schedule.breaks')`,
    );
    const v = Object.fromEntries(r.map((x) => [x.key, x.value]));
    return {
      rules: { ...DEFAULT_SCHEDULE_RULES, ...((v['schedule.rules'] as Partial<ScheduleRules>) ?? {}) },
      breaks: { ...DEFAULT_BREAK_RULES, ...((v['schedule.breaks'] as Partial<BreakRules>) ?? {}) },
    };
  }

  @Get('month')
  @RequirePerm('schedule.manage')
  async month(@Query('month') monthRaw: string) {
    const month = parse(monthStr, monthRaw);
    const m = await one<Record<string, unknown>>(
      this.ctx.pool,
      'SELECT * FROM schedule_month WHERE month = $1',
      [firstDay(month)],
    );
    const shifts = await rows<Record<string, unknown>>(
      this.ctx.pool,
      `SELECT s.id, s.user_id, to_char(s.on_date, 'YYYY-MM-DD') AS date, s.template_id, s.start_at, s.end_at, s.is_night,
              s.manual, t.code, t.color, t.duration_min,
              COALESCE((SELECT json_agg(json_build_object('id', b.id, 'kind', b.kind, 'startAt', b.start_at,
                          'endAt', b.end_at, 'manual', b.manual) ORDER BY b.start_at)
                          FROM schedule_break b WHERE b.shift_id = s.id), '[]') AS breaks
         FROM schedule_shift s JOIN shift_template t ON t.id = s.template_id
        WHERE s.month = $1 ORDER BY s.on_date, s.start_at`,
      [firstDay(month)],
    );
    const { rules, breaks } = await this.settings(this.ctx.pool);
    return {
      month,
      status: (m?.status as string | undefined) ?? 'none',
      normHours: (m?.norm_hours as number | null | undefined) ?? rules.monthNormHours,
      generatedAt: m?.generated_at ?? null,
      publishedAt: m?.published_at ?? null,
      warnings: (m?.warnings as string[] | undefined) ?? [],
      breakRules: breaks,
      staff: (await this.staffList(this.ctx.pool)).map((s) => ({ userId: s.id, name: s.full_name })),
      shifts: shifts.map((r) => toApi(r)),
      demand: await this.demand(month),
    };
  }

  /** Загрузить всё для расчёта и пересчитать перерывы месяца (поставленные вручную — сохраняются). */
  private async replanBreaks(tx: PoolClient, month: string): Promise<string[]> {
    const { breaks } = await this.settings(tx);
    const shifts = await rows<{
      id: string;
      user_id: string;
      date: string;
      start_at: Date;
      end_at: Date;
      is_night: boolean;
    }>(
      tx,
      `SELECT id, user_id, to_char(on_date, 'YYYY-MM-DD') AS date, start_at, end_at, is_night FROM schedule_shift WHERE month = $1`,
      [firstDay(month)],
    );
    await tx.query(
      `DELETE FROM schedule_break WHERE NOT manual AND shift_id IN (SELECT id FROM schedule_shift WHERE month = $1)`,
      [firstDay(month)],
    );
    const manual = await rows<{ shift_id: string; kind: 'long' | 'short'; start_at: Date; end_at: Date }>(
      tx,
      `SELECT b.shift_id, b.kind, b.start_at, b.end_at FROM schedule_break b JOIN schedule_shift s ON s.id = b.shift_id
        WHERE s.month = $1`,
      [firstDay(month)],
    );
    const planned: (PlannedShift & { id: string })[] = shifts.map((s) => ({
      id: s.id,
      userId: s.user_id,
      date: s.date,
      templateId: '',
      start: dateToMonthMinute(month, s.start_at),
      end: dateToMonthMinute(month, s.end_at),
      isNight: s.is_night,
    }));
    const fixed: PlannedBreak[] = manual.map((b) => {
      const s = shifts.find((x) => x.id === b.shift_id)!;
      return {
        userId: s.user_id,
        date: s.date,
        kind: b.kind,
        start: dateToMonthMinute(month, b.start_at),
        end: dateToMonthMinute(month, b.end_at),
        manual: true,
      };
    });
    const r = planBreaks(planned, breaks, fixed);
    for (const b of r.breaks) {
      if (b.manual) continue;
      const s = planned.find((x) => x.userId === b.userId && b.start >= x.start && b.end <= x.end);
      if (!s) continue;
      await tx.query(
        'INSERT INTO schedule_break (id, shift_id, kind, start_at, end_at) VALUES ($1,$2,$3,$4,$5)',
        [newId(), s.id, b.kind, monthMinuteToDate(month, b.start), monthMinuteToDate(month, b.end)],
      );
    }
    return r.warnings;
  }

  /** Сформировать график: смены, поставленные вручную, остаются; остальное — заново; затем перерывы. */
  @Post('month/generate')
  @HttpCode(200)
  @RequirePerm('schedule.manage')
  async generate(@CurrentUser() p: Principal, @Body() body: unknown) {
    const { month } = parse(z.object({ month: monthStr }).strict(), body);
    await withTx(this.ctx.pool, async (tx) => {
      const lock = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext('schedule:' || $1)) AS ok`, [
        month,
      ]);
      if (!lock.rows[0].ok) throw badRequest('График этого месяца уже формируется');
      const { rules, breaks } = await this.settings(tx);
      const tpl = await rows<{
        id: string;
        code: string;
        start_min: number;
        duration_min: number;
        is_night: boolean;
      }>(tx, 'SELECT id, code, start_min, duration_min, is_night FROM shift_template WHERE is_active');
      const dem = await rows<{
        template_id: string;
        weekday: number | null;
        date: string | null;
        required: number;
      }>(
        tx,
        `SELECT template_id, weekday, to_char(on_date, 'YYYY-MM-DD') AS date, required FROM schedule_demand`,
      );
      const staff = await this.staffWithPrefs(tx, month);
      await tx.query(
        `INSERT INTO schedule_month (month, norm_hours) VALUES ($1, $2) ON CONFLICT (month) DO NOTHING`,
        [firstDay(month), rules.monthNormHours],
      );
      const fixedRows = await rows<{
        user_id: string;
        date: string;
        template_id: string;
        start_at: Date;
        end_at: Date;
        is_night: boolean;
      }>(
        tx,
        `SELECT user_id, to_char(on_date, 'YYYY-MM-DD') AS date, template_id, start_at, end_at, is_night
           FROM schedule_shift WHERE month = $1 AND manual`,
        [firstDay(month)],
      );
      await tx.query(
        `DELETE FROM schedule_break WHERE shift_id IN (SELECT id FROM schedule_shift WHERE month = $1 AND NOT manual)`,
        [firstDay(month)],
      );
      await tx.query('DELETE FROM schedule_shift WHERE month = $1 AND NOT manual', [firstDay(month)]);
      const result = generateMonth({
        month,
        templates: tpl.map((t) => ({
          id: t.id,
          code: t.code,
          startMin: t.start_min,
          durationMin: t.duration_min,
          isNight: t.is_night,
        })),
        demand: (date, weekday, templateId) =>
          dem.find((d) => d.template_id === templateId && d.date === date)?.required ??
          dem.find((d) => d.template_id === templateId && d.weekday === weekday)?.required ??
          0,
        staff: staff.map(
          (s): StaffIn => ({
            userId: s.userId,
            name: s.name,
            shiftLengths: s.prefs.shiftLengths,
            night: s.prefs.night as StaffIn['night'],
            weekdays: s.prefs.weekdays as StaffIn['weekdays'],
            maxHours: s.prefs.maxHours,
          }),
        ),
        rules: staff.flatMap((s) =>
          (s.rules as Record<string, unknown>[]).map(
            (r): StaffRuleIn => ({
              userId: s.userId,
              kind: r.kind as StaffRuleIn['kind'],
              dateFrom: r.dateFrom as string | null,
              dateTo: r.dateTo as string | null,
              weekdays: r.weekdays as number[] | null,
              timeFrom: r.timeFrom as number | null,
              timeTo: r.timeTo as number | null,
            }),
          ),
        ),
        scheduleRules: rules,
        breakRules: breaks,
        fixed: fixedRows.map((f) => ({
          userId: f.user_id,
          date: f.date,
          templateId: f.template_id,
          start: dateToMonthMinute(month, f.start_at),
          end: dateToMonthMinute(month, f.end_at),
          isNight: f.is_night,
        })),
      });
      for (const s of result.shifts) {
        if (s.manual) continue;
        await tx.query(
          `INSERT INTO schedule_shift (id, month, user_id, on_date, template_id, start_at, end_at, is_night)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            newId(),
            firstDay(month),
            s.userId,
            s.date,
            s.templateId,
            monthMinuteToDate(month, s.start),
            monthMinuteToDate(month, s.end),
            s.isNight,
          ],
        );
      }
      const bw = await this.replanBreaks(tx, month);
      await tx.query(
        `UPDATE schedule_month SET generated_at = now(), warnings = $2, status = 'draft', updated_at = now() WHERE month = $1`,
        [firstDay(month), JSON.stringify([...result.warnings, ...bw])],
      );
      await audit(tx, p, 'generate', 'schedule_month', null, null, { month, shifts: result.shifts.length });
    });
    return this.month(month);
  }

  /** Ручная правка ячейки: поставить смену или выходной; перерывы месяца пересчитываются. */
  @Put('month/shift')
  @RequirePerm('schedule.manage')
  async setShift(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(ShiftBody, body);
    if (!monthDays(b.month).some((d) => d.date === b.date)) throw badRequest('Дата не из этого месяца');
    await withTx(this.ctx.pool, async (tx) => {
      await tx.query(`INSERT INTO schedule_month (month) VALUES ($1) ON CONFLICT (month) DO NOTHING`, [
        firstDay(b.month),
      ]);
      const old = await one<{ id: string }>(
        tx,
        'SELECT id FROM schedule_shift WHERE user_id = $1 AND on_date = $2',
        [b.userId, b.date],
      );
      if (old) {
        await tx.query('DELETE FROM schedule_break WHERE shift_id = $1', [old.id]);
        await tx.query('DELETE FROM schedule_shift WHERE id = $1', [old.id]);
      }
      if (b.templateId) {
        const t = await one<{ start_min: number; duration_min: number; is_night: boolean }>(
          tx,
          'SELECT start_min, duration_min, is_night FROM shift_template WHERE id = $1',
          [b.templateId],
        );
        if (!t) throw notFound('Смена');
        const idx = monthDays(b.month).findIndex((d) => d.date === b.date);
        const start = idx * 1440 + t.start_min;
        await tx.query(
          `INSERT INTO schedule_shift (id, month, user_id, on_date, template_id, start_at, end_at, is_night, manual)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
          [
            newId(),
            firstDay(b.month),
            b.userId,
            b.date,
            b.templateId,
            monthMinuteToDate(b.month, start),
            monthMinuteToDate(b.month, start + t.duration_min),
            t.is_night,
          ],
        );
      }
      await this.replanBreaks(tx, b.month);
      await audit(tx, p, 'update', 'schedule_shift', null, null, b);
    });
    return this.month(b.month);
  }

  /** Сдвинуть перерыв (время начала в течение дня смены) — дальше его не трогает автоматический пересчёт. */
  @Patch('breaks/:id')
  @RequirePerm('schedule.manage')
  async moveBreak(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(BreakBody, body);
    return withTx(this.ctx.pool, async (tx) => {
      const br = await one<{
        id: string;
        start_at: Date;
        end_at: Date;
        shift_start: Date;
        shift_end: Date;
        month: string;
      }>(
        tx,
        `SELECT b.id, b.start_at, b.end_at, s.start_at AS shift_start, s.end_at AS shift_end, to_char(s.month, 'YYYY-MM') AS month
           FROM schedule_break b JOIN schedule_shift s ON s.id = b.shift_id WHERE b.id = $1 FOR UPDATE OF b`,
        [parse(uuid, id)],
      );
      if (!br) throw notFound('Перерыв');
      const len = br.end_at.getTime() - br.start_at.getTime();
      // Новое начало — в тот же день смены, что и прежнее (по минскому времени); для ночной — может быть после полуночи.
      const base = new Date(br.start_at.getTime() + 3 * 3600_000);
      base.setUTCHours(0, 0, 0, 0);
      let start = new Date(base.getTime() - 3 * 3600_000 + b.startMin * 60_000);
      if (start < br.shift_start) start = new Date(start.getTime() + 86_400_000);
      if (start < br.shift_start || start.getTime() + len > br.shift_end.getTime())
        throw badRequest('Перерыв должен быть внутри смены');
      await tx.query('UPDATE schedule_break SET start_at = $2, end_at = $3, manual = true WHERE id = $1', [
        id,
        start,
        new Date(start.getTime() + len),
      ]);
      const clash = await one<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM schedule_break WHERE id <> $1 AND start_at < $3 AND end_at > $2`,
        [id, start, new Date(start.getTime() + len)],
      );
      await audit(tx, p, 'update', 'schedule_break', id, null, { start });
      return { ok: true, overlaps: clash?.n ?? 0 };
    });
  }

  @Post('month/publish')
  @HttpCode(200)
  @RequirePerm('schedule.manage')
  async publish(@CurrentUser() p: Principal, @Body() body: unknown) {
    const { month } = parse(z.object({ month: monthStr }).strict(), body);
    await withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE schedule_month SET status = 'published', published_at = now(), updated_at = now() WHERE month = $1`,
        [firstDay(month)],
      );
      if (!r.rowCount) throw badRequest('Сначала сформируйте график');
      await audit(tx, p, 'publish', 'schedule_month', null, null, { month });
    });
    return this.month(month);
  }

  // ---------- Мой график (оператор) ----------

  /** Опубликованные смены и перерывы сотрудника: вчера — на 35 дней вперёд. */
  @Get('me')
  @RequirePerm('conversations.work', 'schedule.manage')
  async me(@CurrentUser() p: Principal) {
    const list = await rows<Record<string, unknown>>(
      this.ctx.pool,
      `SELECT s.id, to_char(s.on_date, 'YYYY-MM-DD') AS date, s.start_at, s.end_at, s.is_night, t.code, t.name,
              COALESCE((SELECT json_agg(json_build_object('id', b.id, 'kind', b.kind, 'startAt', b.start_at,
                          'endAt', b.end_at) ORDER BY b.start_at) FROM schedule_break b WHERE b.shift_id = s.id), '[]') AS breaks
         FROM schedule_shift s JOIN shift_template t ON t.id = s.template_id
         JOIN schedule_month m ON m.month = s.month AND m.status = 'published'
        WHERE s.user_id = $1 AND s.end_at > now() - interval '1 day' AND s.start_at < now() + interval '35 days'
        ORDER BY s.start_at`,
      [p.id],
    );
    return list.map((r) => toApi(r));
  }
}
