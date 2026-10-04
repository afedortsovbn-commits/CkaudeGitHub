import { AppShell, Badge, Burger, Button, Group, NavLink, ScrollArea, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useEffect } from 'react';
import { Navigate, NavLink as RouterLink, Outlet, useLocation } from 'react-router';
import { BrowserWarning } from '../components/BrowserWarning';
import { NotificationBell } from '../components/NotificationBell';
import { SupervisorNotices } from '../components/SupervisorNotices';
import { UpdateBanner } from '../components/UpdateBanner';
import { SoftphoneCall, SoftphoneStatus } from '../components/Softphone';
import { useRealtime } from '../lib/realtime';
import { softphone } from '../lib/softphone';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';
import { buildMenu, MENU } from '../lib/nav';

export function Layout() {
  const { me, logout, can } = useAuth();
  const loc = useLocation();
  const phone = can('conversations.work', 'supervisor.monitor');
  // Софтфон работает на всех страницах, пока сотрудник в системе (входящий звонок не зависит от раздела).
  // Зависимость — только id: перечитанный профиль не должен перезапускать софтфон посреди разговора.
  const userId = me?.id;
  // На телефоне меню свёрнуто под «бургер» (иначе оно закрывает весь экран вместе с панелью звонка).
  const [menuOpened, menu] = useDisclosure(false);
  // Рабочее место оператора: меню свёрнуто и на компьютере — всё место под разговор (открывается «бургером»).
  const focus = loc.pathname.startsWith('/workspace');
  useEffect(() => {
    menu.close();
  }, [loc.pathname]);
  // Одно общее соединение: колокольчик и рабочее место получают события по нему.
  useRealtime(!!userId);
  useEffect(() => {
    if (phone && userId) void softphone.start(userId);
    return () => softphone.stop();
  }, [phone, userId]);
  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: 250,
        breakpoint: 'sm',
        collapsed: { mobile: !menuOpened, desktop: focus && !menuOpened },
      }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Burger
              opened={menuOpened}
              onClick={menu.toggle}
              hiddenFrom={focus ? undefined : 'sm'}
              size="sm"
              data-testid="menu-toggle"
            />
            <Text fw={700} visibleFrom="xs">
              {t.appName}
            </Text>
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
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {buildMenu(MENU, me?.ui, me?.permissions ?? []).map((m) => (
            <NavLink
              key={m.to}
              component={RouterLink}
              to={m.to}
              label={m.label}
              active={loc.pathname === m.to || (m.to !== '/' && loc.pathname.startsWith(`${m.to}/`))}
            />
          ))}
          <Stack gap="xs" mt="md" hiddenFrom="sm">
            <NavLink component={RouterLink} to="/profile" label={me?.fullName ?? t.nav.profile} />
            <Button size="xs" variant="default" onClick={() => void logout()}>
              {t.signOut}
            </Button>
          </Stack>
        </ScrollArea>
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

export function HomePage() {
  const { me, can } = useAuth();
  // Стартовая страница из интерфейса роли (если раздел доступен по правам).
  const home = me?.ui?.home;
  const target = home && home !== '/' ? MENU.find((m) => m.to === home) : undefined;
  if (target && (!target.perms || can(...target.perms))) return <Navigate to={target.to} replace />;
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
