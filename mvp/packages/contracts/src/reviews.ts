import { z } from 'zod';

/**
 * Ф13 — отзывы с карт через интегратора Rocket Data (M-CH-10) и синхронизация справочника объектов (M-ORG-06).
 *
 * Описание API Rocket Data и источника справочника объектов от заказчика ещё не получено (В-32, В-42): обмен
 * идёт по контракту-заглушке `mvp/docs/интеграции-rocketdata-и-объекты.md`. Всё, что зависит от формата внешней
 * системы, собрано в адаптерах (`apps/connector-rocketdata/src/rocketdata-api.ts`, `packages/domain/src/objects-sync.ts`
 * — разбор выгрузки); контракт внутри системы (эти схемы) при замене адаптера не меняется.
 */

/** Площадки отзывов и их названия в интерфейсе; неизвестная площадка показывается как есть. */
export const REVIEW_PLATFORMS: Record<string, string> = {
  google: 'Google Карты',
  yandex: 'Яндекс Карты',
  '2gis': '2ГИС',
};
export const reviewPlatformName = (p: string | null | undefined) => (p ? (REVIEW_PLATFORMS[p] ?? p) : '—');

/** Экземпляр канала «Отзыв» — подключение к API Rocket Data (одна учётная запись интегратора). */
export const RocketDataChannelConfigSchema = z
  .object({
    /** Адрес API Rocket Data (из контура — через прокси, если он нужен, см. HTTPS_PROXY коннектора). */
    api_url: z.string().url(),
    /** Токен доступа к API (хранится зашифрованным, в интерфейс не отдаётся). */
    api_token: z.string().min(1),
    /** Период опроса новых и изменённых отзывов, с. */
    poll_interval_s: z.coerce.number().int().min(10).max(86400).default(300),
    /** При первом подключении — загрузить отзывы за столько последних дней (0 — только новые). */
    initial_days: z.coerce.number().int().min(0).max(365).default(7),
    /** Отзывы с оценкой не выше этой — срочные (первыми в очереди). 0 — не выделять. */
    low_rating_max: z.coerce.number().int().min(0).max(5).default(2),
    /**
     * Отзывы, на которые уже ответили на площадке (до подключения или вне системы), не создают обращений.
     * Выключено — становятся обращениями как все.
     */
    skip_answered: z.boolean().default(true),
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
});
export type ReviewMeta = z.infer<typeof ReviewMetaSchema>;

/** Ключ внешнего идентификатора объекта (service_object.external_ids) для точки Rocket Data. */
export const ROCKETDATA_OBJECT_KEY = 'rocketdata';

// ------------------------------------------------------------------ синхронизация объектов (M-ORG-06, В-42)

/** Настройки синхронизации объектов (system_setting `objects.sync`; «Администрирование → Синхронизация объектов»). */
export const ObjectSyncSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Адрес выгрузки справочника во внешней системе (HTTP GET). */
    url: z.string().url().nullable().default(null),
    /** json — массив объектов (или {items: [...]}) ; csv — те же поля, что у ручного импорта. */
    format: z.enum(['json', 'csv']).default('json'),
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
  })
  .strict();
export type ObjectSyncSettings = z.infer<typeof ObjectSyncSettingsSchema>;

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
