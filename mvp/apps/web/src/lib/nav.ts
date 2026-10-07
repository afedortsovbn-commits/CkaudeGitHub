import {
  type Icon,
  IconApps,
  IconBook,
  IconBooks,
  IconBroadcast,
  IconBuildingSkyscraper,
  IconBulb,
  IconCalendarTime,
  IconChartBar,
  IconChecklist,
  IconDeviceDesktopAnalytics,
  IconFileCode,
  IconGasStation,
  IconHeadset,
  IconHierarchy,
  IconHistory,
  IconInbox,
  IconKey,
  IconListTree,
  IconLock,
  IconMessageBolt,
  IconMessageChatbot,
  IconPlug,
  IconRefresh,
  IconRobot,
  IconServer,
  IconSettings,
  IconShieldLock,
  IconSitemap,
  IconSpeakerphone,
  IconTable,
  IconTemplate,
  IconTransfer,
  IconUsers,
  IconVolume,
  IconWebhook,
} from '@tabler/icons-react';
import { t } from './i18n';

/** Пункт меню: адрес раздела, название, группа, иконка, права (любое из них открывает пункт). */
export interface MenuItem {
  to: string;
  label: string;
  perms?: string[];
  group?: string;
  icon?: Icon;
  /** Внешнее приложение, открываемое в новой вкладке (не в окне системы). */
  external?: boolean;
}

/** Группы меню — в порядке показа: сначала ежедневная работа, затем контроль, настройка и администрирование. */
export const MENU_GROUPS: { id: string; label: string; icon: Icon }[] = [
  { id: 'work', label: t.nav.groupWork, icon: IconHeadset },
  { id: 'apps', label: t.nav.groupApps, icon: IconApps },
  { id: 'control', label: t.nav.groupControl, icon: IconChartBar },
  { id: 'channels', label: t.nav.groupChannels, icon: IconSitemap },
  { id: 'org', label: t.nav.groupOrg, icon: IconBuildingSkyscraper },
  { id: 'integrations', label: t.nav.groupIntegrations, icon: IconPlug },
  { id: 'admin', label: t.nav.groupAdmin, icon: IconSettings },
];

/**
 * Разделы системы в стандартном порядке. Один источник для меню слева и для редактора интерфейса роли
 * («Роли и права» → «Интерфейс»).
 */
export const MENU: MenuItem[] = [
  // Работа с обращениями
  {
    to: '/workspace',
    label: t.layout.rabocheeMestoOperatora,
    perms: ['conversations.work'],
    group: 'work',
    icon: IconHeadset,
  },
  { to: '/tickets', label: t.layout.kabinet2YLinii, perms: ['tickets.work'], group: 'work', icon: IconInbox },
  {
    to: '/kb',
    label: t.layout.bazaZnaniy,
    perms: ['conversations.work', 'kb.manage', 'supervisor.monitor'],
    group: 'work',
    icon: IconBook,
  },
  {
    to: '/templates',
    label: t.layout.shablonyOtvetov,
    perms: ['conversations.work', 'templates.manage', 'tickets.work'],
    group: 'work',
    icon: IconTemplate,
  },
  // Контроль и отчёты
  {
    to: '/supervisor',
    label: t.layout.supervizor,
    perms: ['supervisor.monitor'],
    group: 'control',
    icon: IconDeviceDesktopAnalytics,
  },
  {
    to: '/tickets-control',
    label: t.layout.kontrol2YLinii,
    perms: ['supervisor.approvals', 'admin.matrix'],
    group: 'control',
    icon: IconChecklist,
  },
  { to: '/reports', label: t.layout.otchety, perms: ['reports.view'], group: 'control', icon: IconChartBar },
  {
    to: '/schedule',
    label: t.schedule.title,
    perms: ['schedule.manage'],
    group: 'control',
    icon: IconCalendarTime,
  },
  {
    to: '/resources',
    label: t.resources.title,
    perms: ['settings.manage', 'supervisor.monitor', 'admin.users'],
    group: 'control',
    icon: IconServer,
  },
  // Каналы и сценарии
  {
    to: '/channels',
    label: t.layout.kanaly,
    perms: ['channels.manage'],
    group: 'channels',
    icon: IconBroadcast,
  },
  {
    to: '/ivr',
    label: t.layout.stsenariiIvr,
    perms: ['ivr.manage', 'supervisor.monitor'],
    group: 'channels',
    icon: IconSitemap,
  },
  {
    to: '/bots',
    label: t.layout.boty,
    perms: ['bots.manage', 'supervisor.monitor'],
    group: 'channels',
    icon: IconRobot,
  },
  {
    to: '/ivr-audio',
    label: t.layout.audiobiblioteka,
    perms: ['ivr.manage'],
    group: 'channels',
    icon: IconVolume,
  },
  {
    to: '/announcements',
    label: t.layout.obyavleniyaOSboyakh,
    perms: ['announcements.manage', 'supervisor.monitor'],
    group: 'channels',
    icon: IconSpeakerphone,
  },
  {
    to: '/auto-replies',
    label: t.layout.avtootvety,
    perms: ['autoreplies.manage'],
    group: 'channels',
    icon: IconMessageBolt,
  },
  {
    to: '/assist',
    label: t.layout.podskazkiProvaydery,
    perms: ['assist.manage'],
    group: 'channels',
    icon: IconBulb,
  },
  // Оргструктура и справочники
  {
    to: '/enterprises',
    label: t.nav.enterprises,
    perms: ['org.manage'],
    group: 'org',
    icon: IconBuildingSkyscraper,
  },
  { to: '/departments', label: t.nav.departments, perms: ['org.manage'], group: 'org', icon: IconHierarchy },
  { to: '/topics', label: t.nav.topics, perms: ['org.manage'], group: 'org', icon: IconListTree },
  {
    to: '/matrix',
    label: t.nav.matrix,
    perms: ['admin.matrix', 'matrix.view'],
    group: 'org',
    icon: IconTable,
  },
  {
    to: '/objects',
    label: t.nav.objects,
    perms: ['objects.manage', 'supervisor.monitor'],
    group: 'org',
    icon: IconGasStation,
  },
  {
    to: '/objects-sync',
    label: t.reviews.syncNav,
    perms: ['objects.manage'],
    group: 'org',
    icon: IconRefresh,
  },
  {
    to: '/dictionaries',
    label: t.nav.dictionaries,
    perms: ['dictionaries.manage'],
    group: 'org',
    icon: IconBooks,
  },
  // Интеграции
  {
    to: '/integrations',
    label: t.layout.integratsii,
    perms: ['integrations.manage'],
    group: 'integrations',
    icon: IconPlug,
  },
  {
    to: '/api-keys',
    label: t.layout.klyuchiApi,
    perms: ['apikeys.manage'],
    group: 'integrations',
    icon: IconKey,
  },
  {
    to: '/webhooks',
    label: 'Webhooks',
    perms: ['webhooks.manage'],
    group: 'integrations',
    icon: IconWebhook,
  },
  {
    to: '/external-bots',
    label: t.layout.vneshniyBotBotGateway,
    perms: ['webhooks.manage'],
    group: 'integrations',
    icon: IconMessageChatbot,
  },
  {
    to: '/api-docs',
    label: t.layout.dokumentatsiyaApi,
    perms: ['apikeys.manage', 'webhooks.manage', 'integrations.manage'],
    group: 'integrations',
    icon: IconFileCode,
  },
  {
    to: '/config-transfer',
    label: t.layout.eksportIImport,
    perms: ['config.transfer'],
    group: 'integrations',
    icon: IconTransfer,
  },
  // Администрирование
  { to: '/users', label: t.nav.users, perms: ['admin.users'], group: 'admin', icon: IconUsers },
  { to: '/roles', label: t.roles.navTitle, perms: ['admin.users'], group: 'admin', icon: IconShieldLock },
  {
    to: '/external-apps',
    label: t.extApps.navTitle,
    perms: ['settings.manage'],
    group: 'admin',
    icon: IconApps,
  },
  { to: '/settings', label: t.nav.settings, perms: ['settings.manage'], group: 'admin', icon: IconSettings },
  { to: '/audit', label: t.nav.audit, perms: ['admin.audit'], group: 'admin', icon: IconHistory },
  {
    to: '/privacy',
    label: t.layout.personalnyeDannye,
    perms: ['admin.audit', 'settings.manage', 'admin.users'],
    group: 'admin',
    icon: IconLock,
  },
];

/** Интерфейс по умолчанию для роли (хранится в роли, приходит в /auth/me). */
export interface RoleUi {
  v?: number;
  home?: string | null;
  menu?: { to: string; visible: boolean }[];
  workspace?: { listTabs?: string[]; rightTabs?: string[] };
}

/** Пункт доступен по правам (меню только упорядочивает и скрывает — доступ дают права). */
export const allowed = (m: MenuItem, perms: Iterable<string>): boolean => {
  if (!m.perms) return true;
  const set = new Set(perms);
  return m.perms.some((p) => set.has(p));
};

/**
 * Меню сотрудника: пункты, доступные по правам, в порядке из интерфейса роли; скрытые в роли — не показываются.
 * Пункты, которых в настройке роли нет (например, появились в новой версии), — в конце в стандартном порядке.
 */
export function buildMenu(
  items: MenuItem[],
  ui: RoleUi | null | undefined,
  perms: Iterable<string>,
): MenuItem[] {
  const permitted = items.filter((m) => allowed(m, [...perms]));
  if (!ui?.menu?.length) return permitted;
  const byTo = new Map(permitted.map((m) => [m.to, m]));
  const out: MenuItem[] = [];
  const seen = new Set<string>();
  for (const e of ui.menu) {
    const m = byTo.get(e.to);
    if (!m || seen.has(e.to)) continue;
    seen.add(e.to);
    if (e.visible) out.push(m);
  }
  for (const m of permitted) if (!seen.has(m.to)) out.push(m);
  return out;
}

/**
 * Пункты по группам (в порядке MENU_GROUPS; внутри группы — в порядке списка). Пункты без группы — в начале.
 */
export function groupMenu(
  items: MenuItem[],
): { group: (typeof MENU_GROUPS)[number] | null; items: MenuItem[] }[] {
  const out: { group: (typeof MENU_GROUPS)[number] | null; items: MenuItem[] }[] = [];
  const loose = items.filter((m) => !m.group);
  if (loose.length) out.push({ group: null, items: loose });
  for (const g of MENU_GROUPS) {
    const list = items.filter((m) => m.group === g.id);
    if (list.length) out.push({ group: g, items: list });
  }
  return out;
}

/** Вкладки по интерфейсу роли: в заданном порядке, только известные; пусто или не задано — все как есть. */
export function orderTabs<T extends { value: string }>(tabs: T[], order: string[] | undefined): T[] {
  if (!order?.length) return tabs;
  const out = order.map((v) => tabs.find((x) => x.value === v)).filter((x): x is T => !!x);
  return out.length ? out : tabs;
}
