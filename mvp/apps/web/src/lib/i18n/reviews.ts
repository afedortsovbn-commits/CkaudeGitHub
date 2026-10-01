/** Строки интерфейса: отзывы с карт (Rocket Data) и синхронизация объектов — Ф13 (M-NFR-08). */
export const reviews = {
  // Рабочее место оператора
  channel: 'Отзыв',
  platforms: { google: 'Google Карты', yandex: 'Яндекс Карты', '2gis': '2ГИС' } as Record<string, string>,
  ratingTitle: (n: unknown) => `Оценка ${n} из 5`,
  noRating: 'без оценки',
  openOnPlatform: 'Открыть на площадке ↗',
  noAuthor: 'Автор не указан',
  objectLabel: ' · объект: ',
  notMatched: (point: unknown) => `не сопоставлен (точка ${point})`,
  edited: ' · отзыв изменён автором',
  replyPlaceholder: 'Публичный ответ на отзыв — будет опубликован на площадке (только текст)…',
  // Каналы
  kindLabel: 'Отзывы с карт (Rocket Data)',
  apiUrl: 'Адрес API Rocket Data',
  apiUrlHint: 'Выход в интернет — только к этому адресу (прокси — переменная ROCKETDATA_PROXY коннектора)',
  apiToken: 'Токен API Rocket Data',
  pollS: 'Проверять новые отзывы раз в, с',
  initialDays: 'При подключении загрузить отзывы за последние, дней',
  lowRating: 'Срочные — отзывы с оценкой не выше',
  lowRatingHint: 'Срочные обращения идут первыми в очереди; 0 — не выделять',
  skipAnswered: 'Не создавать обращения по отзывам, на которые уже ответили на площадке',
  channelsNote:
    ' Отзывы с карт (Rocket Data) становятся обращениями предприятия объекта: точка Rocket Data сопоставляется объекту по идентификатору «rocketdata» или коду объекта; ответ оператора публикуется на площадке.',
  // Объекты
  sources: { manual: 'вручную', import: 'импорт CSV', sync: 'синхронизация' } as Record<string, string>,
  rocketdataPoint: 'Точка Rocket Data',
  rocketdataId: 'Идентификатор точки в Rocket Data',
  rocketdataIdHint: 'По нему отзыв с карт сопоставляется объекту (иначе — по коду объекта)',
  // Отчёты
  byRating: 'по оценкам',
  byPlatform: 'по площадкам',
  // Синхронизация объектов
  syncNav: 'Синхронизация объектов',
  syncTitle: 'Синхронизация объектов',
  syncIntro:
    'Справочник объектов (АЗС, ЭЗС) ежедневно загружается из внешней системы: новые объекты добавляются, изменённые обновляются, исчезнувшие из выгрузки или закрытые — деактивируются. Названия, адреса, предприятия и внешние идентификаторы синхронизируемых объектов вручную не меняются. Если выгрузка деактивировала бы слишком много объектов (или пришла пустой), запуск останавливается без изменений.',
  syncEnabled: 'Ежедневная синхронизация включена',
  syncUrl: 'Адрес выгрузки справочника (HTTP GET)',
  formatCsv: 'CSV (как ручной импорт)',
  token: 'Токен (Authorization: Bearer)',
  tokenSet: 'Задан; оставьте пустым, чтобы не менять',
  tokenNotSet: 'Не задан',
  time: 'Время запуска (Europe/Minsk)',
  maxShare: 'Предельная доля деактивации, %',
  save: 'Сохранить',
  saved: 'Настройки синхронизации сохранены',
  dryRun: 'Проверить (без изменений)',
  runNow: 'Синхронизировать сейчас',
  dryDone: 'Проверка выполнена',
  runDone: 'Синхронизация выполнена',
  ok: 'успешно',
  error: 'ошибка',
  running: 'выполняется',
  dryBadge: 'проверка без изменений',
  summary: (r: {
    total: number;
    added: number;
    updated: number;
    deactivated: number;
    reactivated: number;
    skipped: number;
  }) =>
    `в выгрузке ${r.total}: добавлено ${r.added}, изменено ${r.updated}, деактивировано ${r.deactivated}, снова активно ${r.reactivated}, пропущено ${r.skipped}`,
  problems: (n: number) => `Замечания к выгрузке (${n})`,
  changes: (n: number) => `Изменения (${n})`,
  line: (n: unknown) => `строка ${n}`,
  actions: {
    added: 'добавлен',
    updated: 'изменён',
    deactivated: 'деактивирован',
    reactivated: 'снова активен',
  } as Record<string, string>,
  fields: {
    name: 'название',
    address: 'адрес',
    enterpriseId: 'предприятие',
    externalIds: 'внешние идентификаторы',
    source: 'источник',
  } as Record<string, string>,
  runsTitle: 'Журнал запусков',
  colStart: 'Начало',
  colTrigger: 'Запуск',
  colResult: 'Итог',
  colAdded: 'Добавлено',
  colUpdated: 'Изменено',
  colDeactivated: 'Деактивировано',
  colSkipped: 'Пропущено',
  bySchedule: 'по расписанию',
  manual: (who: unknown) => `вручную${who ? ` (${who})` : ''}`,
  dryMark: ' · проверка',
  details: 'Подробнее',
  runModal: 'Запуск синхронизации',
};
