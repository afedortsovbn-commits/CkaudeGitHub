import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Drawer,
  FileButton,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconHelp, IconMovie, IconFileText } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { get, put, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';
import { buildMenu, MENU, MENU_GROUPS, type MenuItem } from '../lib/nav';
import { AssetVideo } from '../pages/MyCoursesPage';

interface HelpPageData {
  module: string;
  empty: boolean;
  title?: string;
  body?: string;
  videoAssetId?: string | null;
  posterAssetId?: string | null;
  updatedAt?: string;
}

/** Раздел меню по адресу страницы: самый длинный совпадающий адрес пункта меню. */
export function helpModuleOf(pathname: string): MenuItem | null {
  let best: MenuItem | null = null;
  for (const m of MENU)
    if (!m.external && (pathname === m.to || pathname.startsWith(`${m.to}/`)))
      if (!best || m.to.length > best.to.length) best = m;
  return best;
}

/** **жирный** и `код` внутри строки. */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : part.startsWith('`') && part.endsWith('`') ? (
      <Code key={i}>{part.slice(1, -1)}</Code>
    ) : (
      part
    ),
  );
}

/** Текст инструкции: «## » — заголовок, «- » — пункт списка, пустая строка — новый абзац. */
export function HelpText({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (list.length)
      blocks.push(
        <List key={blocks.length} size="sm" spacing={4} withPadding>
          {list.map((x, i) => (
            <List.Item key={i}>{inline(x)}</List.Item>
          ))}
        </List>,
      );
    if (para.length)
      blocks.push(
        <Text key={blocks.length} size="sm">
          {inline(para.join(' '))}
        </Text>,
      );
    list = [];
    para = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) flush();
    else if (line.startsWith('## ')) {
      flush();
      blocks.push(
        <Title key={blocks.length} order={5} mt="xs">
          {line.slice(3)}
        </Title>,
      );
    } else if (line.startsWith('- ')) {
      if (para.length) flush();
      list.push(line.slice(2));
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return <Stack gap={8}>{blocks}</Stack>;
}

/** Инструкция раздела: видео и текст; нет — «пока не загружено»; администратор может заполнить. */
export function HelpContent({ module, title }: { module: string; title: string }) {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['/help/page', module],
    queryFn: () => get<HelpPageData>(`/help/page?module=${encodeURIComponent(module)}`),
  });
  const [editing, setEditing] = useState(false);
  const p = q.data;
  if (!p) return null;
  return (
    <Stack gap="sm" data-testid="help-content" data-module={module}>
      {editing ? (
        <HelpEditor page={p} title={title} onDone={() => setEditing(false)} />
      ) : p.empty || (!p.body && !p.videoAssetId) ? (
        <Alert color="gray" icon={<IconHelp />} data-testid="help-empty">
          <Text size="sm" fw={600}>
            {t.help.notLoadedTitle}
          </Text>
          <Text size="sm">{t.help.notLoaded(title)}</Text>
        </Alert>
      ) : (
        <>
          {p.videoAssetId && <AssetVideo id={p.videoAssetId} posterId={p.posterAssetId ?? undefined} />}
          {p.body && <HelpText body={p.body} />}
        </>
      )}
      {can('settings.manage') && !editing && (
        <Group>
          <Button size="xs" variant="subtle" onClick={() => setEditing(true)} data-testid="help-edit">
            {p.empty ? t.help.create : t.help.edit}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function HelpEditor({ page, title, onDone }: { page: HelpPageData; title: string; onDone(): void }) {
  const [v, setV] = useState({
    title: page.title ?? title,
    body: page.body ?? '',
    videoAssetId: page.videoAssetId ?? null,
    posterAssetId: page.posterAssetId ?? null,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const save = useAction(() => put('/help/page', { module: page.module, ...v }), t.help.saved);
  const up = async (f: File | null, key: 'videoAssetId' | 'posterAssetId') => {
    if (!f) return;
    setBusy(key);
    try {
      const r = await upload<{ id: string }>('/courses/assets', f);
      setV((x) => ({ ...x, [key]: r.id }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Stack gap="xs">
      <TextInput
        label={t.help.fTitle}
        value={v.title}
        onChange={(e) => setV({ ...v, title: e.currentTarget.value })}
      />
      <Textarea
        label={t.help.fBody}
        description={t.help.fBodyHint}
        autosize
        minRows={8}
        maxRows={24}
        value={v.body}
        onChange={(e) => setV({ ...v, body: e.currentTarget.value })}
      />
      <Group gap="xs">
        <FileButton accept="video/webm,video/mp4" onChange={(f) => void up(f, 'videoAssetId')}>
          {(props) => (
            <Button size="xs" variant="light" loading={busy === 'videoAssetId'} {...props}>
              {v.videoAssetId ? t.help.replaceVideo : t.help.uploadVideo}
            </Button>
          )}
        </FileButton>
        <FileButton accept="image/*" onChange={(f) => void up(f, 'posterAssetId')}>
          {(props) => (
            <Button size="xs" variant="light" loading={busy === 'posterAssetId'} {...props}>
              {t.help.uploadPoster}
            </Button>
          )}
        </FileButton>
        {v.videoAssetId && (
          <Button
            size="xs"
            variant="subtle"
            color="red"
            onClick={() => setV({ ...v, videoAssetId: null, posterAssetId: null })}
          >
            {t.help.removeVideo}
          </Button>
        )}
      </Group>
      <Group>
        <Button
          size="xs"
          loading={save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: onDone })}
        >
          {t.save}
        </Button>
        <Button size="xs" variant="subtle" color="gray" onClick={onDone}>
          {t.cancel}
        </Button>
      </Group>
    </Stack>
  );
}

/** Кнопка «?» в шапке: инструкция по текущему разделу. */
export function HelpButton() {
  const loc = useLocation();
  const [opened, setOpened] = useState(false);
  const [mod, setMod] = useState<MenuItem | null>(null);
  useEffect(() => {
    if (!opened) setMod(helpModuleOf(loc.pathname));
  }, [loc.pathname, opened]);
  return (
    <>
      <Tooltip label={t.help.button}>
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={() => setOpened(true)}
          aria-label={t.help.button}
          data-testid="help-open"
        >
          <IconHelp size={20} />
        </ActionIcon>
      </Tooltip>
      <Drawer
        opened={opened}
        onClose={() => setOpened(false)}
        position="right"
        size="xl"
        title={<Text fw={700}>{mod ? t.help.drawerTitle(mod.label) : t.help.button}</Text>}
      >
        {mod ? (
          <HelpContent module={mod.to} title={mod.label} />
        ) : (
          <Text size="sm" c="dimmed">
            {t.help.noModule}
          </Text>
        )}
        <Button
          component={Link}
          to="/help"
          variant="subtle"
          size="xs"
          mt="md"
          onClick={() => setOpened(false)}
        >
          {t.help.all}
        </Button>
      </Drawer>
    </>
  );
}

/** «Справка по программе»: все разделы меню сотрудника, у каждого — есть ли текст и видео. */
export function HelpPage() {
  const { me } = useAuth();
  const list = useQuery({
    queryKey: ['/help'],
    queryFn: () => get<{ module: string; title: string; hasText: boolean; hasVideo: boolean }[]>('/help'),
  });
  const [open, setOpen] = useState<MenuItem | null>(null);
  const menu = buildMenu(MENU, me?.ui, me?.permissions ?? []).filter((m) => !m.external && !m.screen);
  const byModule = new Map((list.data ?? []).map((x) => [x.module, x]));
  return (
    <Stack>
      <Title order={3}>{t.help.pageTitle}</Title>
      <Text size="sm" c="dimmed">
        {t.help.pageHint}
      </Text>
      {MENU_GROUPS.map((g) => {
        const items = menu.filter((m) => (m.group ?? 'work') === g.id);
        if (!items.length) return null;
        return (
          <Stack key={g.id} gap="xs">
            <Text fw={700} size="sm">
              {g.label}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="xs">
              {items.map((m) => {
                const h = byModule.get(m.to);
                const Icon = m.icon;
                return (
                  <Paper
                    key={m.to}
                    withBorder
                    p="xs"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setOpen(m)}
                    data-testid="help-module"
                    data-module={m.to}
                  >
                    <Group gap="xs" wrap="nowrap">
                      {Icon && <Icon size={18} />}
                      <Text size="sm" fw={500} style={{ flex: 1 }}>
                        {m.label}
                      </Text>
                      {h?.hasVideo && (
                        <Badge size="xs" color="grape" leftSection={<IconMovie size={10} />}>
                          {t.help.video}
                        </Badge>
                      )}
                      {h?.hasText && (
                        <Badge size="xs" color="teal" leftSection={<IconFileText size={10} />}>
                          {t.help.text}
                        </Badge>
                      )}
                      {!h?.hasText && !h?.hasVideo && (
                        <Badge size="xs" color="gray" variant="light">
                          {t.help.soon}
                        </Badge>
                      )}
                    </Group>
                  </Paper>
                );
              })}
            </SimpleGrid>
          </Stack>
        );
      })}
      <Drawer
        opened={!!open}
        onClose={() => setOpen(null)}
        position="right"
        size="xl"
        title={<Text fw={700}>{open ? t.help.drawerTitle(open.label) : ''}</Text>}
      >
        {open && <HelpContent module={open.to} title={open.label} />}
      </Drawer>
    </Stack>
  );
}
