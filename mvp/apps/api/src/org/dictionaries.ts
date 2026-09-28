import { z, type ZodTypeAny } from 'zod';
import type { ScopeColumns } from '@cc/auth';

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
  writePerm: string;
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
      f('kind', z.enum(['webchat', 'app', 'telegram', 'email', 'api'])),
      f('name', name),
      f('queueId', uuid.nullable().optional()),
      f(
        'config',
        z
          .object({
            public_key: z.string().min(8).max(64).optional(),
            allowed_origins: z.array(z.string().max(200)).optional(),
            consent_text: z.string().max(4000).optional(),
            consent_version: z.string().max(32).optional(),
            greeting: z.string().max(1000).optional(),
            max_file_mb: z.number().int().min(1).max(50).optional(),
            app_secret: z.string().min(16).max(200).optional(),
          })
          .passthrough()
          .default({}),
        { json: true },
      ),
    ],
    orderBy: 'kind, name',
    search: ['name'],
    writePerm: 'admin.directories',
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
