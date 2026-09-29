import { z, type ZodTypeAny } from 'zod';
import type { ScopeColumns } from '@cc/auth';
import { maskChannelRow, prepareChannelConfig } from './channel-config';
import {
  IntegrationAuthSchema,
  IntegrationInputsSchema,
  IntegrationOutputsSchema,
  maskIntegration,
  prepareIntegration,
} from '../ivr/integrations';

export interface FieldSpec {
  api: string;
  col: string;
  schema: ZodTypeAny;
  /** jsonb-массив/объект — сериализуется явно. */
  json?: boolean;
  /** Разрешён как фильтр ?api=значение. */
  filter?: boolean;
}

export interface DictSpec {
  table: string;
  title: string;
  fields: FieldSpec[];
  orderBy: string;
  search: string[];
  /** Столбцы строки для областей видимости (алиас таблицы — t). */
  scope?: ScopeColumns;
  /** Право на изменение (любое из перечисленных). */
  writePerm: string | string[];
  /** Подготовка данных к записи (проверка, шифрование секретов); before — текущая строка при изменении. */
  prepare?: (
    data: Record<string, unknown>,
    before: Record<string, unknown> | null,
    secretsKey: string | undefined,
  ) => Record<string, unknown>;
  /** Представление строки в ответах и журнале аудита (маскирование секретов). */
  present?: <T extends Record<string, unknown> | null>(row: T) => T;
}

const code = z.string().trim().min(1).max(64);
const name = z.string().trim().min(1).max(300);
const optText = z.string().trim().max(300).nullable().optional();
const uuid = z.string().uuid();
const email = z.string().trim().email().max(200).nullable().optional();

const f = (api: string, schema: ZodTypeAny, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  api,
  col: api.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
  schema,
  ...extra,
});

const timeRanges = z.array(z.tuple([z.string().regex(/^\d\d:\d\d$/), z.string().regex(/^\d\d:\d\d$/)]));
const scopeRule = z.object({
  enterpriseIds: z.array(uuid).nullable(),
  departmentIds: z.array(uuid).nullable(),
  topicIds: z.array(uuid).nullable(),
});

/** Простые справочники: единый CRUD, аудит, деактивация вместо удаления (M-ORG-08). */
export const DICTIONARIES: Record<string, DictSpec> = {
  enterprises: {
    table: 'enterprise',
    title: 'Предприятие',
    fields: [f('code', code), f('name', name), f('email', email), f('phone', optText)],
    orderBy: 'name',
    search: ['code', 'name'],
    scope: { enterprise: 't.id' },
    writePerm: 'admin.directories',
  },
  departments: {
    table: 'department',
    title: 'Подразделение',
    fields: [f('code', code), f('name', name)],
    orderBy: 'name',
    search: ['code', 'name'],
    scope: { department: 't.id' },
    writePerm: 'admin.directories',
  },
  objects: {
    table: 'service_object',
    title: 'Объект',
    fields: [
      f('enterpriseId', uuid, { filter: true }),
      f('code', code),
      f('name', name),
      f('address', optText),
      f('externalIds', z.record(z.string()).default({}), { json: true }),
    ],
    orderBy: 'name',
    search: ['code', 'name', 'address'],
    scope: { enterprise: 't.enterprise_id' },
    writePerm: 'admin.directories',
  },
  dispositions: {
    table: 'disposition',
    title: 'Результат обработки',
    fields: [
      f('code', code),
      f('name', name),
      f('behavior', z.enum(['resolved', 'escalate', 'no_reply_needed', 'postponed', 'duplicate'])),
      f('sortOrder', z.number().int().default(0)),
    ],
    orderBy: 'sort_order, name',
    search: ['code', 'name'],
    writePerm: 'admin.directories',
  },
  'answer-methods': {
    table: 'answer_method',
    title: 'Способ ответа',
    fields: [f('code', code), f('name', name), f('sortOrder', z.number().int().default(0))],
    orderBy: 'sort_order, name',
    search: ['code', 'name'],
    writePerm: 'admin.directories',
  },
  tags: {
    table: 'tag',
    title: 'Тег',
    fields: [f('name', name)],
    orderBy: 'name',
    search: ['name'],
    writePerm: 'admin.directories',
  },
  'break-reasons': {
    table: 'break_reason',
    title: 'Причина перерыва',
    fields: [f('name', name)],
    orderBy: 'name',
    search: ['name'],
    writePerm: 'admin.directories',
  },
  skills: {
    table: 'skill',
    title: 'Навык',
    fields: [f('name', name), f('topicId', uuid.nullable().optional(), { filter: true })],
    orderBy: 'name',
    search: ['name'],
    writePerm: 'admin.directories',
  },
  queues: {
    table: 'queue',
    title: 'Очередь',
    fields: [
      f('name', name),
      f(
        'channels',
        z.array(z.enum(['voice', 'webchat', 'app', 'telegram', 'email', 'review', 'api'])).default([]),
      ),
      f('priority', z.number().int().min(0).max(100).default(0)),
      f('maxWaitS', z.number().int().min(1).nullable().optional()),
      f('strategy', z.enum(['least_recent', 'least_load']).default('least_recent')),
      f('overflowQueueId', uuid.nullable().optional()),
      f('overflowAfterS', z.number().int().min(1).nullable().optional()),
      f('offerTimeoutS', z.number().int().min(1).max(600).default(20)),
      f('wrapUpS', z.number().int().min(0).max(3600).default(15)),
    ],
    orderBy: 'priority DESC, name',
    search: ['name'],
    writePerm: 'admin.directories',
  },
  'routing-rules': {
    table: 'routing_rule',
    title: 'Правило маршрутизации текста',
    fields: [
      f('name', name),
      f(
        'channelKind',
        z.enum(['webchat', 'app', 'telegram', 'email', 'review', 'api', 'voice']).nullable().optional(),
      ),
      f('matchType', z.enum(['keyword', 'regex'])),
      f('pattern', z.string().trim().min(1).max(300)),
      f('queueId', uuid),
      f('priorityBoost', z.number().int().min(0).max(10000).default(0)),
      f('isUrgent', z.boolean().default(false)),
      f('sortOrder', z.number().int().default(0)),
    ],
    orderBy: 'sort_order, name',
    search: ['name', 'pattern'],
    writePerm: 'admin.directories',
  },
  'segment-priority': {
    table: 'segment_priority',
    title: 'Приоритет сегмента клиента',
    fields: [f('segment', code), f('boost', z.number().int().min(0).max(10000).default(0))],
    orderBy: 'segment',
    search: ['segment'],
    writePerm: 'admin.directories',
  },
  schedules: {
    table: 'schedule',
    title: 'Расписание',
    fields: [
      f('name', name),
      f('timezone', z.string().default('Europe/Minsk')),
      f('week', z.record(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), timeRanges).default({}), {
        json: true,
      }),
      f('holidays', z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([])),
    ],
    orderBy: 'name',
    search: ['name'],
    writePerm: 'admin.directories',
  },
  channels: {
    table: 'channel',
    title: 'Канал',
    fields: [
      f('kind', z.enum(['webchat', 'app', 'telegram', 'email', 'api', 'voice'])),
      f('name', name),
      f('queueId', uuid.nullable().optional()),
      // Проверка по типу канала и шифрование секретов — prepareChannelConfig (hooks.prepare).
      f('config', z.record(z.unknown()).default({}), { json: true }),
    ],
    orderBy: 'kind, name',
    search: ['name'],
    writePerm: 'admin.directories',
    prepare: (data, before, secretsKey) => {
      if (data.config === undefined && data.kind === undefined) return data;
      const kind = String(data.kind ?? before?.kind);
      const config = (data.config ?? before?.config ?? {}) as Record<string, unknown>;
      const prev = before && before.kind === kind ? (before.config as Record<string, unknown>) : null;
      return { ...data, config: prepareChannelConfig(kind, config, prev, secretsKey) };
    },
    present: maskChannelRow,
  },
  // Ф6: глобальные объявления о сбоях (M-IVR-04) — включает и выключает менеджер (супервизор) без правки сценария.
  announcements: {
    table: 'announcement',
    title: 'Объявление',
    fields: [
      f('name', name),
      f('audioId', uuid),
      f('startsAt', z.string().datetime({ offset: true }).nullable().optional()),
      f('endsAt', z.string().datetime({ offset: true }).nullable().optional()),
      f('flowIds', z.array(uuid).default([])),
      f('sortOrder', z.number().int().default(0)),
    ],
    orderBy: 'sort_order, name',
    search: ['name'],
    writePerm: ['admin.directories', 'supervisor.monitor'],
  },
  // Ф6: интеграционные операции (M-INT-03); секрет авторизации шифруется, в ответах — маска.
  integrations: {
    table: 'integration_op',
    title: 'Интеграционная операция',
    fields: [
      f('code', code),
      f('name', name),
      f('method', z.enum(['GET', 'POST', 'PUT']).default('GET')),
      f('url', z.string().trim().min(8).max(2000)),
      f('headers', z.record(z.string().max(2000)).default({}), { json: true }),
      f('auth', IntegrationAuthSchema.default({ type: 'none' }), { json: true }),
      f('body', z.string().max(20000).nullable().optional()),
      f('inputs', IntegrationInputsSchema.default([]), { json: true }),
      f('outputs', IntegrationOutputsSchema.default([]), { json: true }),
      f('timeoutMs', z.number().int().min(100).max(30000).default(3000)),
      f('fallback', z.record(z.string().max(2000)).default({}), { json: true }),
      f('showInCard', z.boolean().default(false)),
      f('cardInput', z.string().trim().max(64).nullable().optional()),
    ],
    orderBy: 'name',
    search: ['code', 'name'],
    writePerm: 'admin.directories',
    prepare: prepareIntegration,
    present: maskIntegration,
  },
  'scope-templates': {
    table: 'scope_template',
    title: 'Шаблон области',
    fields: [f('name', name), f('rules', z.array(scopeRule).default([]), { json: true })],
    orderBy: 'name',
    search: ['name'],
    writePerm: 'admin.users',
  },
};

export function createSchema(spec: DictSpec) {
  return z.object(Object.fromEntries(spec.fields.map((x) => [x.api, x.schema]))).strict();
}

export function updateSchema(spec: DictSpec) {
  return createSchema(spec).partial().strict();
}
