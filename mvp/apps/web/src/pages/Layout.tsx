import { AppShell, Badge, Button, Group, NavLink, ScrollArea, Text } from '@mantine/core';
import { NavLink as RouterLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

const MENU: { to: string; label: string; perms?: string[] }[] = [
  { to: '/', label: t.nav.home },
  { to: '/workspace', label: 'Рабочее место оператора', perms: ['conversations.work'] },
  { to: '/channels', label: 'Каналы', perms: ['admin.directories'] },
  { to: '/enterprises', label: t.nav.enterprises, perms: ['admin.directories'] },
  { to: '/departments', label: t.nav.departments, perms: ['admin.directories'] },
  { to: '/topics', label: t.nav.topics, perms: ['admin.directories'] },
  { to: '/objects', label: t.nav.objects, perms: ['admin.directories', 'supervisor.monitor'] },
  { to: '/users', label: t.nav.users, perms: ['admin.users'] },
  { to: '/matrix', label: t.nav.matrix, perms: ['admin.matrix', 'matrix.view'] },
  { to: '/dictionaries', label: t.nav.dictionaries, perms: ['admin.directories'] },
  { to: '/settings', label: t.nav.settings, perms: ['admin.settings'] },
  { to: '/audit', label: t.nav.audit, perms: ['admin.audit'] },
];

export function Layout() {
  const { me, logout, can } = useAuth();
  const loc = useLocation();
  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 250, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={700}>{t.appName}</Text>
          <Group>
            <Text size="sm" data-testid="current-user">
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
              active={loc.pathname === m.to}
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

export function HomePage() {
  const { me } = useAuth();
  return (
    <>
      <Text size="xl" fw={600} mb="sm">
        Здравствуйте, {me?.fullName}!
      </Text>
      <Text c="dimmed">
        Рабочие места оператора и второй линии появятся в следующих фазах. Сейчас доступны администрирование
        оргструктуры, прав и справочников.
      </Text>
    </>
  );
}
