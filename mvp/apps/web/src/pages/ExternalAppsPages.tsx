import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Group,
  Loader,
  MultiSelect,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconExternalLink, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { type HandleProps, SortableList } from '../components/SortableList';
import { get, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

interface App {
  id?: string;
  key: string;
  name: string;
  url: string;
  mode: 'embed' | 'tab';
  roles: string[];
}

/** Адрес без схемы — считаем https (так же нормализует сервер). */
const normalizeUrl = (v: string) => {
  const s = v.trim();
  return !s || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
};

/** Администрирование → «Внешние приложения»: список сторонних сайтов и PWA для меню сотрудников. */
export function ExternalAppsPage() {
  const data = useQuery({
    queryKey: ['/external-apps'],
    queryFn: () =>
      get<{ apps: Omit<App, 'key'>[]; roles: { code: string; name: string }[] }>('/external-apps'),
  });
  const [apps, setApps] = useState<App[]>([]);
  useEffect(() => {
    if (data.data) setApps(data.data.apps.map((a) => ({ ...a, key: a.id ?? Math.random().toString(36) })));
  }, [data.data]);
  const roleOptions = (data.data?.roles ?? []).map((r) => ({ value: r.code, label: r.name }));
  const set = (key: string, patch: Partial<App>) =>
    setApps((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const save = useAction(
    () =>
      put('/external-apps', {
        apps: apps.map(({ id, name, url, mode, roles }) => ({
          id,
          name,
          url: normalizeUrl(url),
          mode,
          roles,
        })),
      }),
    t.extApps.saved,
  );

  const row = (a: App, handle: HandleProps) => (
    <Paper withBorder p="sm">
      <Group align="flex-start" wrap="nowrap" gap="sm">
        <Text
          {...handle}
          c="dimmed"
          title={t.extApps.dragHint}
          style={{ ...handle.style, fontSize: 18, lineHeight: 1, padding: '28px 4px 0', userSelect: 'none' }}
        >
          ⠿
        </Text>
        <Box
          style={{
            flex: 1,
            display: 'grid',
            gap: 8,
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          }}
        >
          <TextInput
            label={t.extApps.name}
            value={a.name}
            onChange={(e) => set(a.key, { name: e.currentTarget.value })}
            data-testid="app-name"
          />
          <TextInput
            label={t.extApps.url}
            description={t.extApps.urlHint}
            value={a.url}
            onChange={(e) => set(a.key, { url: e.currentTarget.value })}
            onBlur={(e) => set(a.key, { url: normalizeUrl(e.currentTarget.value) })}
            placeholder="crm.example.by"
            data-testid="app-url"
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              {t.extApps.mode}
            </Text>
            <SegmentedControl
              size="xs"
              value={a.mode}
              onChange={(v) => set(a.key, { mode: v as App['mode'] })}
              data={[
                { value: 'embed', label: t.extApps.modeEmbed },
                { value: 'tab', label: t.extApps.modeTab },
              ]}
            />
          </Stack>
          <MultiSelect
            label={t.extApps.roles}
            placeholder={a.roles.length ? undefined : t.extApps.rolesAll}
            data={roleOptions}
            value={a.roles}
            onChange={(v) => set(a.key, { roles: v })}
            clearable
          />
        </Box>
        <ActionIcon
          variant="subtle"
          color="red"
          mt={26}
          title={t.extApps.remove}
          onClick={() => setApps((list) => list.filter((x) => x.key !== a.key))}
        >
          <IconTrash size={18} />
        </ActionIcon>
      </Group>
    </Paper>
  );

  return (
    <Stack gap="sm" maw={1100}>
      <Title order={3}>{t.extApps.title}</Title>
      <Text size="sm" c="dimmed">
        {t.extApps.intro}
      </Text>
      <Alert variant="light" color="blue">
        {t.extApps.embedNote}
      </Alert>
      {data.isLoading ? (
        <Loader size="sm" />
      ) : apps.length === 0 ? (
        <Text c="dimmed">{t.extApps.empty}</Text>
      ) : (
        <SortableList
          items={apps}
          keyOf={(a) => a.key}
          onReorder={setApps}
          renderRow={row}
          testId="apps-list"
        />
      )}
      <Group>
        <Button
          variant="default"
          onClick={() =>
            setApps((list) => [
              ...list,
              { key: Math.random().toString(36), name: t.extApps.newApp, url: '', mode: 'embed', roles: [] },
            ])
          }
          data-testid="app-add"
        >
          {t.extApps.add}
        </Button>
        <Button onClick={() => save.mutate(undefined)} loading={save.isPending} data-testid="apps-save">
          {t.extApps.save}
        </Button>
      </Group>
    </Stack>
  );
}

/** Внешнее приложение в окне системы (iframe на всю рабочую область). */
export function AppFramePage() {
  const { id } = useParams();
  const { me } = useAuth();
  const app = me?.apps?.find((a) => a.id === id);
  const [n, setN] = useState(0);
  if (!app) return <Text c="dimmed">{t.extApps.notFound}</Text>;
  return (
    <Stack gap={6} style={{ height: 'calc(100vh - 56px - 32px)' }}>
      <Group justify="space-between" wrap="nowrap">
        <Text fw={600}>{app.name}</Text>
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed" visibleFrom="md">
            {t.extApps.frameHint}
          </Text>
          <ActionIcon variant="default" title={t.extApps.reload} onClick={() => setN(n + 1)}>
            <IconRefresh size={16} />
          </ActionIcon>
          <Anchor href={app.url} target="_blank" rel="noopener" title={t.extApps.openTab}>
            <ActionIcon variant="default" component="span">
              <IconExternalLink size={16} />
            </ActionIcon>
          </Anchor>
        </Group>
      </Group>
      <iframe
        key={`${app.id}:${n}`}
        src={app.url}
        title={app.name}
        allow="clipboard-read; clipboard-write; microphone; camera; fullscreen; geolocation"
        style={{ flex: 1, width: '100%', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8 }}
        data-testid="app-frame"
      />
    </Stack>
  );
}
