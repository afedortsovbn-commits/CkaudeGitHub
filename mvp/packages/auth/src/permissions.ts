/**
 * Каталог прав сотрудников (п.1 требований заказчика: роль собирается «из всего функционала»).
 *
 * Права дробные — по разделу. Прежние общие права «admin.directories» и «admin.settings» остаются и раскрываются
 * в дробные (expandPermissions): у ролей, где они были, доступ не меняется, а в новой роли можно отметить отдельные
 * разделы. Проверки в api и меню интерфейса — по дробным правам.
 */
export interface PermissionInfo {
  code: string;
  /** Название для администратора. */
  title: string;
  /** Что именно разрешает (подсказка в редакторе роли). */
  description: string;
  /** Раздел можно выдать «только на чтение» (Д-085): просмотр без изменений. */
  readOnly?: boolean;
}

export interface PermissionGroup {
  code: string;
  title: string;
  permissions: PermissionInfo[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    code: 'work',
    title: 'Работа с обращениями',
    permissions: [
      {
        code: 'conversations.work',
        title: '1-я линия (оператор)',
        description: 'Чаты и звонки, карточка обращения и клиента, шаблоны и база знаний (чтение), софтфон',
      },
      {
        code: 'contacts.merge',
        title: 'Слияние дублей клиентов',
        description: 'Объединение карточек клиентов',
      },
      {
        code: 'tickets.work',
        title: '2-я линия: работа с обращениями',
        description: 'Обращения, переданные на 2-ю линию: ответ клиенту, возврат, продление срока',
      },
    ],
  },
  {
    code: 'supervision',
    title: 'Супервизия и отчёты',
    permissions: [
      {
        code: 'supervisor.monitor',
        title: 'Панель супервизора',
        description:
          'Мониторинг очередей и операторов, все открытые обращения, просмотр сценариев IVR, ботов, объявлений и объектов',
      },
      {
        code: 'supervisor.approvals',
        title: '2-я линия: контроль',
        description: 'Согласования и контроль сроков 2-й линии',
      },
      {
        code: 'calls.whisper',
        title: 'Суфлирование',
        description: 'Подсказка голосом: слышит только оператор',
      },
      {
        code: 'calls.barge',
        title: 'Вмешательство в разговор',
        description: 'Супервизора слышат оба собеседника',
      },
      {
        code: 'conversations.takeover',
        title: 'Перехват обращения',
        description: 'Звонок или чат переходит к супервизору',
      },
      {
        code: 'conversations.hint',
        title: 'Подсказка оператору в чате',
        description: 'Скрытое сообщение, клиенту не уходит',
      },
      { code: 'reports.view', title: 'Отчёты', description: 'Все отчёты и выгрузки' },
      {
        code: 'schedule.manage',
        title: 'График работы',
        description:
          'Смены, потребность в операторах, пожелания сотрудников, составление и публикация графика',
        readOnly: true,
      },
      {
        code: 'staff.broadcast',
        title: 'Рассылка сотрудникам',
        description: 'Сообщения всем или ролям; видно, кто прочитал',
        readOnly: true,
      },
      {
        code: 'tests.manage',
        title: 'Тестирование сотрудников',
        description:
          'Тесты и вопросы по темам, назначение со сроком, результаты по сотрудникам и темам, рейтинг вопросов',
        readOnly: true,
      },
      {
        code: 'rating.view',
        title: 'Рейтинг операторов',
        description: 'Панель: места по оценкам клиентов, статус, обработанные обращения',
      },
    ],
  },
  {
    code: 'channels',
    title: 'Каналы, сценарии и тексты',
    permissions: [
      {
        code: 'channels.manage',
        title: 'Каналы',
        description: 'Веб-чат, Telegram, почта, телефония, отзывы',
        readOnly: true,
      },
      {
        code: 'ivr.manage',
        title: 'Сценарии IVR и аудиобиблиотека',
        description: 'Голосовые меню, записи и фразы',
        readOnly: true,
      },
      { code: 'bots.manage', title: 'Боты', description: 'Текстовые сценарии чат-ботов', readOnly: true },
      {
        code: 'announcements.manage',
        title: 'Объявления о сбоях',
        description: 'Сообщения клиентам о сбоях',
        readOnly: true,
      },
      {
        code: 'autoreplies.manage',
        title: 'Автоответы',
        description: 'Приветствие, «вы в очереди», «все заняты», нерабочее время',
        readOnly: true,
      },
      {
        code: 'templates.manage',
        title: 'Общие шаблоны ответов',
        description: 'Шаблоны для всех операторов',
        readOnly: true,
      },
      { code: 'kb.manage', title: 'База знаний', description: 'Статьи-подсказки и рубрики', readOnly: true },
      {
        code: 'assist.manage',
        title: 'Подсказки: провайдеры',
        description: 'Источники подсказок оператору',
        readOnly: true,
      },
      {
        code: 'integrations.manage',
        title: 'Интеграции',
        description: 'Запросы к внешним системам из сценариев',
        readOnly: true,
      },
    ],
  },
  {
    code: 'org',
    title: 'Оргструктура и справочники',
    permissions: [
      {
        code: 'org.manage',
        title: 'Предприятия, подразделения, темы',
        description: 'Оргструктура, темы и поля карточки',
        readOnly: true,
      },
      {
        code: 'objects.manage',
        title: 'Объекты (АЗС)',
        description: 'Справочник объектов и его синхронизация',
        readOnly: true,
      },
      {
        code: 'dictionaries.manage',
        title: 'Справочники',
        description: 'Очереди, расписания, навыки, теги, результаты, причины перерыва, маршрутизация',
        readOnly: true,
      },
      {
        code: 'admin.matrix',
        title: 'Матрица ответственности (изменение)',
        description: 'Назначение ответственных и кураторов',
      },
      { code: 'matrix.view', title: 'Матрица ответственности (просмотр)', description: 'Только просмотр' },
    ],
  },
  {
    code: 'admin',
    title: 'Администрирование',
    permissions: [
      {
        code: 'admin.users',
        title: 'Сотрудники и роли',
        description: 'Учётные записи, роли и права, области видимости',
        readOnly: true,
      },
      {
        code: 'settings.manage',
        title: 'Системные настройки',
        description: 'Параметры системы, обновления',
        readOnly: true,
      },
      {
        code: 'apikeys.manage',
        title: 'Ключи API',
        description: 'Доступ внешних систем по API',
        readOnly: true,
      },
      {
        code: 'webhooks.manage',
        title: 'Webhooks и внешний бот',
        description: 'Уведомления внешним системам, Bot Gateway',
        readOnly: true,
      },
      {
        code: 'config.transfer',
        title: 'Экспорт и импорт',
        description: 'Перенос конфигурации между стендами',
      },
      { code: 'admin.audit', title: 'Журнал аудита', description: 'Кто, что и когда изменил' },
      {
        code: 'data.import',
        title: 'Загрузка обращений',
        description: 'Шаблон Excel, пакетная загрузка истории и правка существующих обращений',
      },
      {
        code: 'system.update',
        title: 'Обновление системы',
        description: 'Установка файла обновления: перечень изменений, остановки блоков, ход обновления',
        readOnly: true,
      },
    ],
  },
  {
    code: 'scope',
    title: 'Видимость данных',
    permissions: [
      {
        code: 'scope.all',
        title: 'Все обращения',
        description: 'Видит обращения всех предприятий и тем (без ограничения областью видимости)',
      },
      {
        code: 'scope.unclassified',
        title: 'Неклассифицированные обращения',
        description: 'При ограниченной области видит и обращения без предприятия и темы',
      },
    ],
  },
];

/** Прежние общие права — раскрываются в дробные. */
export const UMBRELLA_PERMISSIONS: Record<string, string[]> = {
  'admin.directories': [
    'channels.manage',
    'ivr.manage',
    'bots.manage',
    'announcements.manage',
    'autoreplies.manage',
    'templates.manage',
    'kb.manage',
    'assist.manage',
    'integrations.manage',
    'org.manage',
    'objects.manage',
    'dictionaries.manage',
  ],
  'admin.settings': ['settings.manage', 'apikeys.manage', 'webhooks.manage', 'config.transfer'],
};

export const CATALOG_CODES: string[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.code));

/**
 * Д-085. Раздел «только на чтение»: в роли пишется `<право>:read`. Такое право открывает раздел в меню и
 * пропускает запросы просмотра (GET) к API раздела; изменения (POST/PUT/PATCH/DELETE) — только с полным правом.
 */
export const READ_SUFFIX = ':read';
export const readCode = (code: string): string => `${code}${READ_SUFFIX}`;
export const READONLY_CODES: string[] = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.filter((p) => p.readOnly).map((p) => readCode(p.code)),
);

/** Права сотрудника с раскрытыми общими правами (общее право тоже остаётся в наборе). */
export function expandPermissions(perms: Iterable<string>): Set<string> {
  const out = new Set(perms);
  for (const [umbrella, children] of Object.entries(UMBRELLA_PERMISSIONS))
    if (out.has(umbrella)) for (const c of children) out.add(c);
  return out;
}

/**
 * Права роли к записи: если отмечены все разделы общего права — пишется общее право (новые разделы того же
 * общего права в будущих версиях достанутся роли автоматически), иначе — отмеченные разделы.
 */
export function compressPermissions(perms: Iterable<string>): string[] {
  const set = expandPermissions(perms);
  // Полное право перекрывает «только чтение» того же раздела.
  for (const c of [...set])
    if (c.endsWith(READ_SUFFIX) && set.has(c.slice(0, -READ_SUFFIX.length))) set.delete(c);
  for (const [umbrella, children] of Object.entries(UMBRELLA_PERMISSIONS)) {
    if (children.every((c) => set.has(c))) {
      set.add(umbrella);
      for (const c of children) set.delete(c);
    } else set.delete(umbrella);
  }
  return [...set].sort();
}
