import { AppShell, Badge, Button, Group, NavLink, ScrollArea, Text } from '@mantine/core';
import { useEffect } from 'react';
import { NavLink as RouterLink, Outlet, useLocation } from 'react-router';
import { BrowserWarning } from '../components/BrowserWarning';
import { NotificationBell } from '../components/NotificationBell';
import { UpdateBanner } from '../components/UpdateBanner';
import { SoftphoneCall, SoftphoneStatus } from '../components/Softphone';
import { useRealtime } from '../lib/realtime';
import { softphone } from '../lib/softphone';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

const MENU: { to: string; label: string; perms?: string[] }[] = [
  { to: '/', label: t.nav.home },
  { to: '/workspace', label: t.layout.rabocheeMestoOperatora, perms: ['conversations.work'] },
  { to: '/supervisor', label: t.layout.supervizor, perms: ['supervisor.monitor'] },
  { to: '/reports', label: t.layout.otchety, perms: ['reports.view'] },
  { to: '/tickets', label: t.layout.kabinet2YLinii, perms: ['tickets.work'] },
  { to: '/tickets-control', label: t.layout.kontrol2YLinii, perms: ['supervisor.approvals', 'admin.matrix'] },
  { to: '/channels', label: t.layout.kanaly, perms: ['admin.directories'] },
  { to: '/ivr', label: t.layout.stsenariiIvr, perms: ['admin.directories', 'supervisor.monitor'] },
  { to: '/ivr-audio', label: t.layout.audiobiblioteka, perms: ['admin.directories'] },
  { to: '/bots', label: t.layout.boty, perms: ['admin.directories', 'supervisor.monitor'] },
  { to: '/templates', label: t.layout.shablonyOtvetov, perms: ['conversations.work', 'admin.directories'] },
  {
    to: '/kb',
    label: t.layout.bazaZnaniy,
    perms: ['conversations.work', 'admin.directories', 'supervisor.monitor'],
  },
  { to: '/auto-replies', label: t.layout.avtootvety, perms: ['admin.directories'] },
  { to: '/assist', label: t.layout.podskazkiProvaydery, perms: ['admin.directories'] },
  {
    to: '/announcements',
    label: t.layout.obyavleniyaOSboyakh,
    perms: ['admin.directories', 'supervisor.monitor'],
  },
  { to: '/integrations', label: t.layout.integratsii, perms: ['admin.directories'] },
  { to: '/api-keys', label: t.layout.klyuchiApi, perms: ['admin.settings'] },
  { to: '/webhooks', label: 'Webhooks', perms: ['admin.settings'] },
  { to: '/external-bots', label: t.layout.vneshniyBotBotGateway, perms: ['admin.settings'] },
  { to: '/api-docs', label: t.layout.dokumentatsiyaApi, perms: ['admin.settings', 'admin.directories'] },
  { to: '/config-transfer', label: t.layout.eksportIImport, perms: ['admin.settings'] },
  { to: '/enterprises', label: t.nav.enterprises, perms: ['admin.directories'] },
  { to: '/departments', label: t.nav.departments, perms: ['admin.directories'] },
  { to: '/topics', label: t.nav.topics, perms: ['admin.directories'] },
  { to: '/objects', label: t.nav.objects, perms: ['admin.directories', 'supervisor.monitor'] },
  { to: '/users', label: t.nav.users, perms: ['admin.users'] },
  { to: '/matrix', label: t.nav.matrix, perms: ['admin.matrix', 'matrix.view'] },
  { to: '/dictionaries', label: t.nav.dictionaries, perms: ['admin.directories'] },
  { to: '/settings', label: t.nav.settings, perms: ['admin.settings'] },
  { to: '/audit', label: t.nav.audit, perms: ['admin.audit'] },
  {
    to: '/privacy',
    label: t.layout.personalnyeDannye,
    perms: ['admin.audit', 'admin.settings', 'admin.users'],
  },
];

export function Layout() {
  const { me, logout, can } = useAuth();
  const loc = useLocation();
  const phone = can('conversations.work', 'supervisor.monitor');
  // Софтфон работает на всех страницах, пока сотрудник в системе (входящий звонок не зависит от раздела).
  // Зависимость — только id: перечитанный профиль не должен перезапускать софтфон посреди разговора.
  const userId = me?.id;
  // Одно общее соединение: колокольчик и рабочее место получают события по нему.
  useRealtime(!!userId);
  useEffect(() => {
    if (phone && userId) void softphone.start(userId);
    return () => softphone.stop();
  }, [phone, userId]);
  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 250, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={700}>{t.appName}</Text>
          <Group>
            {phone && <SoftphoneStatus />}
            <NotificationBell />
            <Text
              size="sm"
              data-testid="current-user"
              component={RouterLink}
              to="/profile"
              title={t.nav.profile}
            >
              {me?.fullName}
            </Text>
            {me?.roles.map((r) => (
              <Badge key={r} variant="light">
                {r}
              </Badge>
            ))}
            <Button size="xs" variant="default" onClick={() => void logout()}>
              {t.signOut}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {MENU.filter((m) => !m.perms || can(...m.perms)).map((m) => (
            <NavLink
              key={m.to}
              component={RouterLink}
              to={m.to}
              label={m.label}
              active={loc.pathname === m.to || (m.to !== '/' && loc.pathname.startsWith(`${m.to}/`))}
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>
        <BrowserWarning />
        <UpdateBanner />
        <Outlet />
        {phone && <SoftphoneCall />}
      </AppShell.Main>
    </AppShell>
  );
}

export function HomePage() {
  const { me } = useAuth();
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
