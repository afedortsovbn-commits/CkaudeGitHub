import {
  ActionIcon,
  AppShell,
  Badge,
  Burger,
  Button,
  Divider,
  Group,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconChevronRight,
  IconExternalLink,
  IconChevronsLeft,
  IconChevronsRight,
  IconWorld,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, NavLink as RouterLink, Outlet, useLocation } from 'react-router';
import { BrowserWarning } from '../components/BrowserWarning';
import { NotificationBell } from '../components/NotificationBell';
import { SupervisorNotices } from '../components/SupervisorNotices';
import { UpdateBanner } from '../components/UpdateBanner';
import { SoftphoneCall, SoftphoneStatus } from '../components/Softphone';
import { useRealtime } from '../lib/realtime';
import { softphone } from '../lib/softphone';
import { useAuth, type Me } from '../lib/auth';
import { applyRoleFavicon } from '../lib/favicon';
import { t } from '../lib/i18n';
import { buildMenu, groupMenu, MENU, MENU_GROUPS, type MenuItem } from '../lib/nav';

/** Меню из небольшого числа пунктов — без групп (оператору группы только мешают). */
const FLAT_MAX = 8;

/** Настройки меню этого браузера (свёрнуто ли, закрытые группы) — удобство, не данные: ошибки хранилища не мешают. */
const pref = {
  get<T>(k: string, def: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? def : (JSON.parse(v) as T);
    } catch {
      return def;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* приватный режим и т.п. */
    }
  },
};

/** Пункты меню сотрудника: разделы по правам и интерфейсу роли + внешние приложения. */
export function useMenu(me: Me | null): MenuItem[] {
  return useMemo(() => {
    const items = buildMenu(MENU, me?.ui, me?.permissions ?? []);
    const apps: MenuItem[] = (me?.apps ?? []).map((a) => ({
      to: a.mode === 'tab' ? a.url : `/apps/${a.id}`,
      label: a.name,
      group: 'apps',
      icon: IconWorld,
      external: a.mode === 'tab',
    }));
    return [...items, ...apps];
  }, [me]);
}

const isActive = (m: MenuItem, path: string) => !m.external && (path === m.to || path.startsWith(`${m.to}/`));

function Item({ m, path, compact }: { m: MenuItem; path: string; compact: boolean }) {
  const Icon = m.icon;
  const icon = Icon ? <Icon size={20} stroke={1.6} /> : null;
  const link = m.external ? (
    <NavLink
      component="a"
      href={m.to}
      target="_blank"
      rel="noopener"
      label={compact ? undefined : m.label}
      aria-label={m.label}
      leftSection={icon}
      rightSection={compact ? undefined : <IconExternalLink size={14} />}
    />
  ) : (
    <NavLink
      component={RouterLink}
      to={m.to}
      label={compact ? undefined : m.label}
      aria-label={m.label}
      leftSection={icon}
      active={isActive(m, path)}
    />
  );
  return compact ? (
    <Tooltip label={m.label} position="right" withArrow openDelay={150}>
      <div>{link}</div>
    </Tooltip>
  ) : (
    link
  );
}

function Menu({ items, path, compact }: { items: MenuItem[]; path: string; compact: boolean }) {
  // По умолчанию раскрыты «Работа с обращениями» и «Приложения», остальные группы — заголовками (у администратора
  // десятки разделов). Группа открытого раздела раскрыта всегда. Выбор сотрудника запоминается в браузере.
  const [closed, setClosed] = useState<string[]>(() =>
    pref.get(
      'cc.nav.closedGroups',
      MENU_GROUPS.map((g) => g.id).filter((id) => id !== 'work' && id !== 'apps'),
    ),
  );
  const toggle = (id: string) => {
    const next = closed.includes(id) ? closed.filter((x) => x !== id) : [...closed, id];
    setClosed(next);
    pref.set('cc.nav.closedGroups', next);
  };
  const groups = groupMenu(items);
  if (items.length <= FLAT_MAX || groups.length <= 1)
    return (
      <>
        {items.map((m) => (
          <Item key={m.to} m={m} path={path} compact={compact} />
        ))}
      </>
    );
  if (compact)
    return (
      <>
        {groups.map((g, i) => (
          <div key={g.group?.id ?? 'loose'}>
            {i > 0 && <Divider my={4} />}
            {g.items.map((m) => (
              <Item key={m.to} m={m} path={path} compact />
            ))}
          </div>
        ))}
      </>
    );
  return (
    <>
      {groups.map((g) =>
        !g.group ? (
          g.items.map((m) => <Item key={m.to} m={m} path={path} compact={false} />)
        ) : (
          <NavLink
            key={g.group.id}
            component="button"
            label={g.group.label}
            leftSection={<g.group.icon size={20} stroke={1.6} />}
            rightSection={<IconChevronRight size={14} />}
            fw={600}
            childrenOffset={14}
            opened={!closed.includes(g.group.id)}
            onChange={() => toggle(g.group!.id)}
            data-testid={`nav-group-${g.group.id}`}
          >
            {g.items.map((m) => (
              <Item key={m.to} m={m} path={path} compact={false} />
            ))}
          </NavLink>
        ),
      )}
    </>
  );
}

export function Layout() {
  const { me, logout, can } = useAuth();
  const loc = useLocation();
  const phone = can('conversations.work', 'supervisor.monitor');
  // Софтфон работает на всех страницах, пока сотрудник в системе (входящий звонок не зависит от раздела).
  // Зависимость — только id: перечитанный профиль не должен перезапускать софтфон посреди разговора.
  const userId = me?.id;
  // На телефоне меню свёрнуто под «бургер» (иначе оно закрывает весь экран вместе с панелью звонка).
  const [menuOpened, menu] = useDisclosure(false);
  // Узкое меню (только иконки): только по кнопке сотрудника, одинаково во всех разделах; запоминается в браузере.
  const [railPref, setRailPref] = useState<boolean>(() => pref.get('cc.nav.rail', false));
  const compact = railPref && !menuOpened;
  const items = useMenu(me);
  useEffect(() => {
    menu.close();
  }, [loc.pathname]);
  // Текущий раздел: заголовок вкладки браузера и название со значком в шапке рядом с «Контакт-центр».
  const cur = items.find((m) => isActive(m, loc.pathname));
  useEffect(() => {
    document.title = cur ? `${cur.label} — ${t.appName}` : t.appName;
  }, [cur]);
  const CurIcon = cur?.icon;
  // Значок вкладки — по роли (свои роли без стандартного кода — по правам).
  const roleKey = [
    ...(me?.roles ?? []),
    ...(can('admin.users', 'settings.manage') ? ['admin'] : []),
    ...(can('supervisor.monitor') ? ['supervisor'] : []),
    ...(can('tickets.work') ? ['responsible'] : []),
  ].join(',');
  useEffect(() => {
    if (roleKey) applyRoleFavicon(roleKey.split(','));
  }, [roleKey]);
  // Одно общее соединение: колокольчик и рабочее место получают события по нему.
  useRealtime(!!userId);
  useEffect(() => {
    if (phone && userId) void softphone.start(userId);
    return () => softphone.stop();
  }, [phone, userId]);
  const toggleRail = () => {
    setRailPref(!railPref);
    pref.set('cc.nav.rail', !railPref);
  };
  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: { base: 270, sm: compact ? 64 : 270 },
        breakpoint: 'sm',
        collapsed: { mobile: !menuOpened, desktop: false },
      }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Burger
              opened={menuOpened}
              onClick={menu.toggle}
              hiddenFrom="sm"
              size="sm"
              data-testid="menu-toggle"
            />
            <Text fw={700} visibleFrom="xs">
              {t.appName}
            </Text>
            {cur && (
              <Group
                gap={6}
                wrap="nowrap"
                pl="sm"
                ml={4}
                visibleFrom="sm"
                data-testid="section-title"
                style={{ borderLeft: '1px solid var(--mantine-color-gray-4)' }}
              >
                {CurIcon ? <CurIcon size={20} stroke={1.6} color="var(--mantine-color-blue-6)" /> : null}
                <Text fw={600} c="blue.7" truncate>
                  {cur.label}
                </Text>
              </Group>
            )}
          </Group>
          <Group gap="xs" wrap="nowrap">
            {phone && <SoftphoneStatus />}
            <NotificationBell />
            <Text
              size="sm"
              visibleFrom="sm"
              data-testid="current-user"
              component={RouterLink}
              to="/profile"
              title={t.nav.profile}
            >
              {me?.fullName}
            </Text>
            {me?.roles.map((r) => (
              <Badge key={r} variant="light" visibleFrom="md">
                {t.layout.roleName[r as keyof typeof t.layout.roleName] ?? me?.roleNames?.[r] ?? r}
              </Badge>
            ))}
            <Button size="xs" variant="default" onClick={() => void logout()} visibleFrom="sm">
              {t.signOut}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p={compact ? 6 : 'xs'}>
        {/* Свернуть/развернуть меню — стрелка справа вверху (на телефоне меню открывается «бургером»). */}
        <AppShell.Section visibleFrom="sm">
          <Group justify={compact ? 'center' : 'flex-end'} mb={4}>
            <Tooltip label={compact ? t.nav.expand : t.nav.collapse} position="right" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={toggleRail}
                aria-label={compact ? t.nav.expand : t.nav.collapse}
                data-testid="nav-rail-toggle"
              >
                {compact ? <IconChevronsRight size={18} /> : <IconChevronsLeft size={18} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </AppShell.Section>
        <AppShell.Section grow component={ScrollArea}>
          <Menu items={items} path={loc.pathname} compact={compact} />
          <Stack gap="xs" mt="md" hiddenFrom="sm">
            <NavLink component={RouterLink} to="/profile" label={me?.fullName ?? t.nav.profile} />
            <Button size="xs" variant="default" onClick={() => void logout()}>
              {t.signOut}
            </Button>
          </Stack>
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main>
        <BrowserWarning />
        <UpdateBanner />
        <Outlet />
        {phone && <SoftphoneCall />}
        {phone && userId && <SupervisorNotices userId={userId} />}
      </AppShell.Main>
    </AppShell>
  );
}

/**
 * Главная страница не нужна: сразу открывается стартовая страница роли (интерфейс роли), иначе — первый раздел
 * меню. Приветствие — только если разделов нет совсем.
 */
export function HomePage() {
  const { me, can } = useAuth();
  const items = useMenu(me).filter((m) => !m.external);
  const home = me?.ui?.home;
  const target =
    (home && home !== '/' ? MENU.find((m) => m.to === home && (!m.perms || can(...m.perms))) : undefined) ??
    items[0];
  if (target) return <Navigate to={target.to} replace />;
  return (
    <>
      <Text size="xl" fw={600} mb="sm">
        {t.layout.zdravstvuyte}
        {me?.fullName}!
      </Text>
      <Text c="dimmed">{t.layout.razdelyVMenyuSleva}</Text>
    </>
  );
}
