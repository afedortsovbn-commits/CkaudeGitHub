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
  notMatched: (point: unknown) => `не найден в справочнике (АЗС ${point})`,
  station: (station: string, emitent: string) => `АЗС в отзыве: ${station}${emitent ? `, ${emitent}` : ''}`,
  edited: ' · отзыв изменён автором',
  replyPlaceholder: 'Публичный ответ на отзыв — будет опубликован на площадке (только текст)…',
  // Каналы
  kindLabel: 'Отзывы с карт (Rocket Data)',
  answerUrl: 'Адрес сервиса ответов Rocket Data',
  answerUrlHint:
    'Сюда отправляются ответы операторов (POST {Review_id, DateAnswer, Text}). Пусто — ответы не отправляются (статус «не доставлено»). Выход в интернет — через прокси ROCKETDATA_PROXY коннектора',
  channelsNote:
    ' Отзывы с карт (Rocket Data): адрес приёма отзывов из колонки «Адрес» передаётся Rocket Data — она присылает каждый отзыв POST-запросом; отзыв становится обращением предприятия АЗС (АЗС — по GUID объекта), ответ оператора уходит на адрес сервиса ответов канала.',
  // Объекты
  sources: { manual: 'вручную', import: 'импорт CSV', sync: 'синхронизация' } as Record<string, string>,
  objectGuid: 'GUID объекта (АСУ НПО ЭК)',
  objectGuidHint:
    'Глобальный идентификатор объекта (objguid): по нему справочник синхронизируется из АСУ НПО ЭК, а отзыв Rocket Data (StationGuid) сопоставляется АЗС',
  // Отчёты
  byRating: 'по оценкам',
  byPlatform: 'по площадкам',
  // Синхронизация объектов
  syncNav: 'Синхронизация объектов',
  syncTitle: 'Синхронизация объектов',
  syncIntro:
    'Справочник объектов (АЗС) ежедневно загружается из АСУ НПО ЭК: новые объекты добавляются, изменённые обновляются, исчезнувшие из выгрузки или со статусом не «действующий» — деактивируются; ключ объекта — GUID (objguid). Названия, адреса, предприятия и внешние идентификаторы синхронизируемых объектов вручную не меняются. Если выгрузка деактивировала бы слишком много объектов (или пришла пустой), запуск останавливается без изменений.',
  syncEnabled: 'Ежедневная синхронизация включена',
  syncUrl: 'Адрес выгрузки справочника (HTTP GET)',
  formatCsv: 'CSV (как ручной импорт)',
  formatAsu: 'АСУ НПО ЭК (АЗС)',
  enterpriseCode: 'Предприятие объектов выгрузки',
  /** Код предприятия объектов выгрузки по умолчанию (как OBJECT_SYNC_DEFAULT_ENTERPRISE в contracts). */
  defaultEnterprise: 'ПОН',
  enterpriseCodeHint:
    'Все АЗС выгрузки относятся к этому предприятию (предприятия нефтепродуктообеспечения — «ПОН»), кроме исключений ниже',
  enterpriseMap: 'Исключения: код предприятия в выгрузке (unitcode) = код предприятия справочника',
  enterpriseMapHint: 'По одному в строке, например 20=MALANKA; пусто — исключений нет',
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
