import { t } from './i18n';

/** Пункт меню: адрес раздела, название, права (любое из них открывает пункт; без прав — виден всем). */
export interface MenuItem {
  to: string;
  label: string;
  perms?: string[];
}

/**
 * Разделы системы в стандартном порядке. Один источник для меню слева и для редактора интерфейса роли
 * («Роли и права» → «Интерфейс»).
 */
export const MENU: MenuItem[] = [
  { to: '/', label: t.nav.home },
  { to: '/workspace', label: t.layout.rabocheeMestoOperatora, perms: ['conversations.work'] },
  { to: '/supervisor', label: t.layout.supervizor, perms: ['supervisor.monitor'] },
  { to: '/reports', label: t.layout.otchety, perms: ['reports.view'] },
  { to: '/tickets', label: t.layout.kabinet2YLinii, perms: ['tickets.work'] },
  { to: '/tickets-control', label: t.layout.kontrol2YLinii, perms: ['supervisor.approvals', 'admin.matrix'] },
  { to: '/channels', label: t.layout.kanaly, perms: ['channels.manage'] },
  { to: '/ivr', label: t.layout.stsenariiIvr, perms: ['ivr.manage', 'supervisor.monitor'] },
  { to: '/ivr-audio', label: t.layout.audiobiblioteka, perms: ['ivr.manage'] },
  { to: '/bots', label: t.layout.boty, perms: ['bots.manage', 'supervisor.monitor'] },
  { to: '/templates', label: t.layout.shablonyOtvetov, perms: ['conversations.work', 'templates.manage'] },
  { to: '/kb', label: t.layout.bazaZnaniy, perms: ['conversations.work', 'kb.manage', 'supervisor.monitor'] },
  { to: '/auto-replies', label: t.layout.avtootvety, perms: ['autoreplies.manage'] },
  { to: '/assist', label: t.layout.podskazkiProvaydery, perms: ['assist.manage'] },
  {
    to: '/announcements',
    label: t.layout.obyavleniyaOSboyakh,
    perms: ['announcements.manage', 'supervisor.monitor'],
  },
  { to: '/integrations', label: t.layout.integratsii, perms: ['integrations.manage'] },
  { to: '/api-keys', label: t.layout.klyuchiApi, perms: ['apikeys.manage'] },
  { to: '/webhooks', label: 'Webhooks', perms: ['webhooks.manage'] },
  { to: '/external-bots', label: t.layout.vneshniyBotBotGateway, perms: ['webhooks.manage'] },
  {
    to: '/api-docs',
    label: t.layout.dokumentatsiyaApi,
    perms: ['apikeys.manage', 'webhooks.manage', 'integrations.manage'],
  },
  { to: '/config-transfer', label: t.layout.eksportIImport, perms: ['config.transfer'] },
  { to: '/enterprises', label: t.nav.enterprises, perms: ['org.manage'] },
  { to: '/departments', label: t.nav.departments, perms: ['org.manage'] },
  { to: '/topics', label: t.nav.topics, perms: ['org.manage'] },
  { to: '/objects', label: t.nav.objects, perms: ['objects.manage', 'supervisor.monitor'] },
  { to: '/objects-sync', label: t.reviews.syncNav, perms: ['objects.manage'] },
  { to: '/users', label: t.nav.users, perms: ['admin.users'] },
  { to: '/roles', label: t.roles.navTitle, perms: ['admin.users'] },
  { to: '/matrix', label: t.nav.matrix, perms: ['admin.matrix', 'matrix.view'] },
  { to: '/dictionaries', label: t.nav.dictionaries, perms: ['dictionaries.manage'] },
  { to: '/settings', label: t.nav.settings, perms: ['settings.manage'] },
  { to: '/audit', label: t.nav.audit, perms: ['admin.audit'] },
  {
    to: '/privacy',
    label: t.layout.personalnyeDannye,
    perms: ['admin.audit', 'settings.manage', 'admin.users'],
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

/** Вкладки по интерфейсу роли: в заданном порядке, только известные; пусто или не задано — все как есть. */
export function orderTabs<T extends { value: string }>(tabs: T[], order: string[] | undefined): T[] {
  if (!order?.length) return tabs;
  const out = order.map((v) => tabs.find((x) => x.value === v)).filter((x): x is T => !!x);
  return out.length ? out : tabs;
}
