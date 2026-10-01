import { z } from 'zod';

/**
 * Ф13 — отзывы с карт через интегратора Rocket Data (M-CH-10) и синхронизация справочника объектов (M-ORG-06).
 *
 * Обмен — по описаниям заказчика (01.10, В-32 и В-42; `mvp/docs/интеграции-rocketdata-и-объекты.md`):
 * Rocket Data сама присылает отзыв POST-запросом на адрес канала (`/rd/<id канала>`), ответ оператора уходит
 * POST-запросом на адрес сервиса ответов Rocket Data; отзыв сопоставляется АЗС по GUID объекта (`StationGuid` =
 * `objguid` справочника АСУ НПО ЭК). Форматы внешних систем — в адаптерах (`apps/connector-rocketdata/src/
 * rocketdata-api.ts`, `packages/domain/src/objects-sync.ts`); контракт внутри системы (эти схемы) от них не зависит.
 */

/** Площадки отзывов и их названия в интерфейсе; неизвестная площадка показывается как есть. */
export const REVIEW_PLATFORMS: Record<string, string> = {
  google: 'Google Карты',
  yandex: 'Яндекс Карты',
  '2gis': '2ГИС',
};
export const reviewPlatformName = (p: string | null | undefined) => (p ? (REVIEW_PLATFORMS[p] ?? p) : '—');

/** Площадка по полю «Сайт» Rocket Data (yandex.ru, maps.google.com, 2gis.by …); неизвестный сайт — как есть. */
export function reviewPlatformOf(site: string | null | undefined): string {
  const s = (site ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('yandex') || s.includes('яндекс')) return 'yandex';
  if (s.includes('google')) return 'google';
  if (s.includes('2gis') || s.includes('2гис')) return '2gis';
  return s.slice(0, 40);
}

/**
 * Экземпляр канала «Отзыв» — подключение Rocket Data. Отзывы Rocket Data присылает сама на адрес канала
 * (`<адрес КЦ>/rd/<id канала>`, показывается в «Каналах»); здесь — куда отправлять ответы операторов.
 */
export const RocketDataChannelConfigSchema = z
  .object({
    /**
     * Адрес сервиса ответов Rocket Data (POST JSON `{Review_id, DateAnswer, Text}`). Не задан — ответы не
     * отправляются (статус «не доставлено»): так тестовый стенд не может случайно ответить клиенту на площадке.
     */
    answer_url: z.union([z.string().url(), z.literal('')]).nullish(),
    /** Отзывы с оценкой не выше этой — срочные (если Rocket Data передаёт оценку). 0 — не выделять. */
    low_rating_max: z.coerce.number().int().min(0).max(5).default(2),
    // Прежняя схема (опрос API по контракту-заглушке) — поля больше не используются, остаются необязательными.
    api_url: z.string().nullish(),
    api_token: z.string().nullish(),
    poll_interval_s: z.coerce.number().nullish(),
    initial_days: z.coerce.number().nullish(),
    skip_answered: z.boolean().nullish(),
  })
  .passthrough();
export type RocketDataChannelConfig = z.infer<typeof RocketDataChannelConfigSchema>;

/**
 * Сведения об отзыве во входящем сообщении канала «Отзыв» (`InboundMessage.meta.review`) и в обращении
 * (`conversation.channel_meta.review`) — для карточки оператора, ответа и отчёта по отзывам.
 */
export const ReviewMetaSchema = z.object({
  /** Идентификатор отзыва в Rocket Data — адрес ответа. */
  id: z.string().min(1).max(200),
  /** Площадка: google, yandex, … */
  platform: z.string().max(40),
  /** Оценка 1–5 (у площадки может не быть оценки — null). */
  rating: z.number().int().min(1).max(5).nullable(),
  author: z.string().max(300).nullable(),
  url: z.string().max(2000).nullable(),
  publishedAt: z.string().nullable(),
  /** Идентификатор и код точки (филиала) в Rocket Data — по ним отзыв сопоставляется объекту справочника. */
  locationId: z.string().max(200).nullable(),
  locationCode: z.string().max(200).nullable(),
  /** На отзыв уже ответили на площадке (не из системы). */
  answered: z.boolean().default(false),
  /** Низкая оценка — обращение срочное (настройка канала low_rating_max). */
  urgent: z.boolean().default(false),
  /** Пропускать уже отвеченные на площадке (настройка канала skip_answered). */
  skipAnswered: z.boolean().default(true),
  /** Реквизиты АЗС из отзыва (Rocket Data): тип, номер и предприятие — для оператора, если АЗС не найдена. */
  stationType: z.string().max(200).nullish(),
  emitent: z.string().max(300).nullish(),
});
export type ReviewMeta = z.infer<typeof ReviewMetaSchema>;

/** Ключ внешнего идентификатора объекта (service_object.external_ids) для точки Rocket Data (прежняя схема). */
export const ROCKETDATA_OBJECT_KEY = 'rocketdata';
/**
 * Ключ глобального идентификатора объекта (GUID АСУ НПО ЭК, `objguid`) в service_object.external_ids: по нему
 * синхронизируется справочник и сопоставляются отзывы (`StationGuid`).
 */
export const OBJECT_GUID_KEY = 'objguid';
/** GUID в одном виде: без дефисов и фигурных скобок, заглавными (в выгрузке АСУ — без дефисов, в отзыве — с ними). */
export const normalizeGuid = (v: string) => v.replace(/[\s{}-]/g, '').toUpperCase();

// ------------------------------------------------------------------ синхронизация объектов (M-ORG-06, В-42)

/** Настройки синхронизации объектов (system_setting `objects.sync`; «Администрирование → Синхронизация объектов»). */
export const ObjectSyncSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Адрес выгрузки справочника во внешней системе (HTTP GET). */
    url: z.string().url().nullable().default(null),
    /**
     * asu — выгрузка АЗС из АСУ НПО ЭК (Приложение 2 заказчика: objguid, name1, status, unitcode …);
     * json — массив объектов (или {items: [...]}) ; csv — те же поля, что у ручного импорта.
     */
    format: z.enum(['json', 'csv', 'asu']).default('json'),
    /** Токен (заголовок Authorization: Bearer); хранится зашифрованным. */
    token: z.string().max(2000).nullable().default(null),
    /** Время ежедневного запуска (часовой пояс системы). */
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('03:00'),
    /**
     * Защита от ошибочной выгрузки: если деактивировать пришлось бы большую долю синхронизируемых объектов, запуск
     * останавливается без изменений (ошибка в журнале). 1 — без защиты.
     */
    maxDeactivateShare: z.number().min(0).max(1).default(0.3),
    /**
     * Формат asu: код предприятия справочника, к которому относятся объекты выгрузки (все предприятия
     * нефтепродуктообеспечения — одно предприятие; не задано — «ПОН», `OBJECT_SYNC_DEFAULT_ENTERPRISE`).
     */
    enterpriseCode: z.string().trim().max(64).optional(),
    /** Формат asu: исключения — код предприятия выгрузки (`unitcode`) → код предприятия справочника. */
    enterpriseMap: z.record(z.string().trim().min(1).max(64)).optional(),
  })
  .strict();
export type ObjectSyncSettings = z.infer<typeof ObjectSyncSettingsSchema>;
/** Предприятие объектов выгрузки АСУ по умолчанию — предприятия нефтепродуктообеспечения (ПОН). */
export const OBJECT_SYNC_DEFAULT_ENTERPRISE = 'ПОН';

/** Строка выгрузки справочника объектов (после разбора JSON или CSV). */
export const ObjectFeedItemSchema = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(300),
  address: z.string().trim().max(300).nullable().default(null),
  /** Код предприятия (справочник «Предприятия»). */
  enterprise_code: z.string().trim().min(1).max(64),
  /** Внешние идентификаторы, в т.ч. `rocketdata` — точка в Rocket Data. */
  external_ids: z.record(z.string().max(200)).default({}),
  /** false — объект закрыт во внешней системе (деактивируется, как и отсутствующий в выгрузке). */
  is_active: z.boolean().default(true),
});
export type ObjectFeedItem = z.infer<typeof ObjectFeedItemSchema>;
