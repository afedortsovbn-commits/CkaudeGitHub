import { z } from 'zod';

/** События оператора (Ф10): журнал статусов для отчёта «Загрузка и статусы операторов» (M-REP-03). */
export const AGENT_EVENTS = {
  status: 'agent.status_changed',
} as const;

export interface AgentStatusEventData {
  userId: string;
  status: 'ready' | 'break' | 'wrap_up' | 'offline';
  prevStatus: string | null;
  reasonId: string | null;
  [k: string]: unknown;
}

/**
 * Отчёты M-REP-03 (упрощённая аналитика, Ф10). Отчёт по отзывам с карт — Ф13.
 * Все, кроме реестра просроченных и отчёта по отзывам, строятся по журналу `event` (M-REP-01).
 */
export const REPORT_KINDS = [
  'conversations',
  'service-level',
  'handling',
  'first-response',
  'agents',
  'csat',
  'second-line',
  'overdue',
  'reviews',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_GROUPS = [
  'channel',
  'queue',
  'operator',
  'topic',
  'subtopic',
  'result',
  'enterprise',
  'department',
  'object',
  'day',
  'assignee',
  // Ф13: разрезы отчёта по отзывам.
  'rating',
  'platform',
] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

/** Название отчёта и допустимые разрезы (первый — по умолчанию). */
export const REPORT_CATALOG: Record<ReportKind, { title: string; groups: ReportGroup[] }> = {
  conversations: {
    title: 'Обращения по каналам, темам и результатам',
    groups: ['channel', 'topic', 'subtopic', 'result', 'enterprise', 'department', 'object', 'day'],
  },
  'service-level': {
    title: 'Уровень обслуживания (SL) и пропущенные',
    groups: ['queue', 'channel', 'day'],
  },
  handling: {
    title: 'Время ожидания и обработки (ASA/AHT)',
    groups: ['operator', 'queue', 'channel', 'day'],
  },
  'first-response': {
    title: 'Время первого ответа в чатах',
    groups: ['channel', 'queue', 'operator', 'day'],
  },
  agents: { title: 'Загрузка и статусы операторов', groups: ['operator'] },
  csat: { title: 'Оценка обслуживания (CSAT)', groups: ['operator', 'channel', 'topic', 'day'] },
  'second-line': {
    title: '2-я линия по предприятиям и подразделениям',
    groups: ['department', 'enterprise', 'assignee'],
  },
  overdue: { title: 'Реестр просроченных тикетов', groups: [] },
  reviews: {
    title: 'Отзывы с карт: оценки и доля отвеченных',
    groups: ['object', 'enterprise', 'rating', 'platform', 'day'],
  },
};

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата ГГГГ-ММ-ДД');
const optional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());

/**
 * Фильтры отчёта (query-строка). Период — календарные даты по часовому поясу системы (Europe/Minsk),
 * `to` включительно. `important=true` — быстрый фильтр «Особо важные».
 */
export const ReportFilterSchema = z.object({
  from: optional(date),
  to: optional(date),
  channel: optional(z.string().max(40)),
  queueId: optional(uuid),
  enterpriseId: optional(uuid),
  departmentId: optional(uuid),
  /** Тема или подтема: попадают обращения всего поддерева. */
  topicId: optional(uuid),
  objectId: optional(uuid),
  operatorId: optional(uuid),
  /** Ответственный или куратор тикета 2-й линии. */
  assigneeId: optional(uuid),
  important: optional(z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')),
  groupBy: optional(z.enum(REPORT_GROUPS)),
  format: optional(z.enum(['json', 'csv'])),
});
export type ReportFilter = z.infer<typeof ReportFilterSchema>;

export type ReportColumnType = 'text' | 'int' | 'num' | 'pct' | 'dur' | 'date' | 'datetime';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

export interface ReportResult {
  kind: ReportKind;
  title: string;
  /** Итоговый период (локальные даты) и часовой пояс, по которому считались сутки. */
  from: string;
  to: string;
  timezone: string;
  groupBy: ReportGroup | null;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown> | null;
  /** Пояснения к расчёту (пороги SL, что не учитывается). */
  notes: string[];
}

/** Пороги панели супервизора и отчётов (настройки `supervisor.thresholds`, `report.*`; без перезапуска). */
export const SupervisorThresholdsSchema = z.object({
  /** Ожидание в очереди, с: жёлтый / красный. */
  waitWarnS: z.number().int().min(1).max(86400).default(60),
  waitCritS: z.number().int().min(1).max(86400).default(180),
  /** Число ожидающих в очереди: жёлтый / красный. */
  queueWarn: z.number().int().min(1).max(10000).default(5),
  queueCrit: z.number().int().min(1).max(10000).default(15),
  /** Длительность перерыва оператора, с — подсветка. */
  breakWarnS: z.number().int().min(60).max(86400).default(900),
  /** Цель SL за сегодня, % — ниже подсвечивается. */
  slTargetPct: z.number().min(1).max(100).default(80),
});
export type SupervisorThresholds = z.infer<typeof SupervisorThresholdsSchema>;

/** Формат CSV отчёта: разделитель «;», BOM и десятичная запятая — открывается в Excel с русской локалью. */
export function reportToCsv(r: Pick<ReportResult, 'columns' | 'rows' | 'totals'>): string {
  const cell = (v: unknown, type: ReportColumnType): string => {
    if (v === null || v === undefined) return '';
    let s: string;
    if (typeof v === 'number') {
      const n = type === 'int' || type === 'dur' ? Math.round(v) : Math.round(v * 100) / 100;
      s = String(n).replace('.', ',');
    } else if (typeof v === 'boolean') s = v ? 'да' : 'нет';
    else s = String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [r.columns.map((c) => cell(c.label, 'text')).join(';')];
  for (const row of r.rows) lines.push(r.columns.map((c) => cell(row[c.key], c.type)).join(';'));
  if (r.totals) lines.push(r.columns.map((c) => cell(r.totals![c.key], c.type)).join(';'));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
