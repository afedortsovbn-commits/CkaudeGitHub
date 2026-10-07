import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Grid,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { type HandleProps, SortableList } from '../components/SortableList';
import { api, get, post, put } from '../lib/api';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';
import { allowed, MENU, type MenuItem, type RoleUi } from '../lib/nav';

interface PermInfo {
  code: string;
  title: string;
  description: string;
}
interface Catalog {
  groups: { code: string; title: string; permissions: PermInfo[] }[];
  umbrellas: Record<string, string[]>;
}
interface RoleRow {
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  ui: RoleUi | null;
  users: number;
}
interface Draft {
  code: string | null;
  name: string;
  description: string;
  permissions: string[];
  ui: RoleUi | null;
  isSystem: boolean;
  users: number;
}
interface Entry {
  key: string;
  label: string;
  visible: boolean;
}

/** Вкладки рабочего места оператора (значения — как в WorkspacePage). */
const LIST_TABS = [
  { value: 'mine', label: t.workspace.moi },
  { value: 'queue', label: t.workspace.ochered },
  { value: 'bot', label: t.workspace.uBota },
  { value: 'active', label: t.workspace.vseOtkrytye, perm: 'supervisor.monitor' },
  { value: 'closed', label: t.workspace.zakrytye },
];
const RIGHT_TABS = [
  { value: 'card', label: t.workspace.obrashchenie },
  { value: 'contact', label: t.workspace.klient },
  { value: 'calls', label: t.workspace.zvonki },
];

const toDraft = (r: RoleRow, codes: Set<string>): Draft => ({
  code: r.code,
  name: r.name,
  description: r.description ?? '',
  // Общие права приходят раскрытыми; в редакторе — только разделы каталога (сервер свернёт при записи).
  permissions: r.permissions.filter((p) => codes.has(p)),
  ui: r.ui ?? null,
  isSystem: r.isSystem,
  users: r.users,
});

/** Пункты списка в порядке настройки; новые (не упомянутые) — в конце, видимыми. */
function entriesOf(
  all: { value: string; label: string }[],
  saved: { key: string; visible: boolean }[] | null,
): Entry[] {
  if (!saved) return all.map((x) => ({ key: x.value, label: x.label, visible: true }));
  const byKey = new Map(all.map((x) => [x.value, x]));
  const out: Entry[] = [];
  for (const s of saved) {
    const x = byKey.get(s.key);
    if (!x || out.some((o) => o.key === s.key)) continue;
    out.push({ key: s.key, label: x.label, visible: s.visible });
  }
  for (const x of all)
    if (!out.some((o) => o.key === x.value)) out.push({ key: x.value, label: x.label, visible: true });
  return out;
}

/** Роли и права (п.1 требований заказчика): права из каталога и интерфейс по умолчанию для роли. */
export function RolesPage() {
  const roles = useQuery({ queryKey: ['/roles'], queryFn: () => get<RoleRow[]>('/roles') });
  const catalog = useQuery({ queryKey: ['/roles/catalog'], queryFn: () => get<Catalog>('/roles/catalog') });
  const codes = useMemo(
    () => new Set((catalog.data?.groups ?? []).flatMap((g) => g.permissions.map((p) => p.code))),
    [catalog.data],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const pick = (r: RoleRow) => {
    setSelected(r.code);
    setDraft(toDraft(r, codes));
    setDirty(false);
  };
  // Первая роль открывается сразу; после сохранения — перечитанная с сервера.
  useEffect(() => {
    if (!roles.data || !codes.size) return;
    const cur = roles.data.find((r) => r.code === selected);
    if (cur && !dirty) setDraft(toDraft(cur, codes));
    else if (!selected && roles.data[0]) pick(roles.data[0]);
  }, [roles.data, codes]);

  const change = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  const save = useAction(async () => {
    if (!draft) return;
    const body = {
      name: draft.name,
      description: draft.description || null,
      permissions: draft.permissions,
      ui: draft.ui,
    };
    const r = draft.code
      ? await put<RoleRow>(`/roles/${draft.code}`, body)
      : await post<RoleRow>('/roles', body);
    setSelected(r.code);
    setDraft(toDraft(r, codes));
    setDirty(false);
  }, t.roles.saved);
  const remove = useAction(async () => {
    if (!draft?.code) return;
    await api('DELETE', `/roles/${draft.code}`);
    setSelected(null);
    setDraft(null);
    setDirty(false);
    setConfirmDelete(false);
  }, t.roles.removed);

  const startNew = (from?: Draft) => {
    setSelected(null);
    setDraft({
      code: null,
      name: from ? `${from.name}${t.roles.copySuffix}` : t.roles.newRole,
      description: from?.description ?? '',
      permissions: from ? [...from.permissions] : [],
      ui: from?.ui ?? null,
      isSystem: false,
      users: 0,
    });
    setDirty(true);
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t.roles.intro}
      </Text>
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 3 }}>
          <Stack gap={6}>
            <Button onClick={() => startNew()} data-testid="role-create">
              {t.roles.create}
            </Button>
            {(roles.data ?? []).map((r) => (
              <UnstyledButton key={r.code} onClick={() => pick(r)} data-testid={`role-item-${r.code}`}>
                <Paper
                  withBorder
                  p="xs"
                  style={{
                    borderColor: r.code === selected ? 'var(--mantine-color-blue-5)' : undefined,
                    background: r.code === selected ? 'var(--mantine-color-blue-0)' : undefined,
                  }}
                >
                  <Text fw={600} size="sm">
                    {r.name}
                  </Text>
                  <Group gap={6}>
                    {r.isSystem && (
                      <Badge size="xs" variant="light" color="gray">
                        {t.roles.system}
                      </Badge>
                    )}
                    <Text size="xs" c="dimmed">
                      {t.roles.users(r.users)}
                    </Text>
                  </Group>
                </Paper>
              </UnstyledButton>
            ))}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 9 }}>
          {!draft || !catalog.data ? (
            <Text c="dimmed">{t.roles.pickRole}</Text>
          ) : (
            <Paper withBorder p="md">
              <Stack gap="sm">
                <Group align="flex-end" wrap="wrap">
                  <TextInput
                    label={t.roles.name}
                    value={draft.name}
                    onChange={(e) => change({ name: e.currentTarget.value })}
                    style={{ flex: '1 1 260px' }}
                    data-testid="role-name"
                  />
                  <Button
                    onClick={() => save.mutate()}
                    loading={save.isPending}
                    disabled={!draft.name.trim()}
                    data-testid="role-save"
                  >
                    {t.roles.save}
                  </Button>
                  {draft.code && (
                    <Button variant="default" onClick={() => startNew(draft)} data-testid="role-copy">
                      {t.roles.copy}
                    </Button>
                  )}
                  {draft.code && !draft.isSystem && (
                    <Button
                      variant="subtle"
                      color="red"
                      onClick={() => setConfirmDelete(true)}
                      data-testid="role-delete"
                    >
                      {t.roles.remove}
                    </Button>
                  )}
                </Group>
                <Textarea
                  label={t.roles.description}
                  value={draft.description}
                  autosize
                  minRows={1}
                  onChange={(e) => change({ description: e.currentTarget.value })}
                />
                {dirty && (
                  <Text size="xs" c="orange.8">
                    {t.roles.unsaved}
                  </Text>
                )}
                <Tabs defaultValue="perms">
                  <Tabs.List>
                    <Tabs.Tab value="perms" data-testid="role-tab-perms">
                      {t.roles.tabPerms}
                    </Tabs.Tab>
                    <Tabs.Tab value="ui" data-testid="role-tab-ui">
                      {t.roles.tabUi}
                    </Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="perms" pt="sm">
                    <PermissionsEditor
                      catalog={catalog.data}
                      value={draft.permissions}
                      onChange={(permissions) => change({ permissions })}
                    />
                  </Tabs.Panel>
                  <Tabs.Panel value="ui" pt="sm">
                    <UiEditor perms={draft.permissions} value={draft.ui} onChange={(ui) => change({ ui })} />
                  </Tabs.Panel>
                </Tabs>
              </Stack>
            </Paper>
          )}
        </Grid.Col>
      </Grid>
      <Modal opened={confirmDelete} onClose={() => setConfirmDelete(false)} title={t.roles.remove}>
        <Stack>
          <Text>
            {draft && draft.users > 0 ? t.roles.removeInUse : t.roles.removeConfirm(draft?.name ?? '')}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmDelete(false)}>
              {t.roles.cancel}
            </Button>
            <Button
              color="red"
              onClick={() => remove.mutate()}
              loading={remove.isPending}
              disabled={!!draft && draft.users > 0}
              data-testid="role-delete-confirm"
            >
              {t.roles.remove}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function PermissionsEditor({
  catalog,
  value,
  onChange,
}: {
  catalog: Catalog;
  value: string[];
  onChange(v: string[]): void;
}) {
  const set = new Set(value);
  const toggle = (codes: string[], on: boolean) => {
    const next = new Set(value);
    for (const c of codes) {
      if (on) next.add(c);
      else next.delete(c);
    }
    onChange([...next].sort());
  };
  return (
    <Stack gap="sm">
      {value.length === 0 && (
        <Alert color="yellow" variant="light">
          {t.roles.noPerms}
        </Alert>
      )}
      {catalog.groups.map((g) => {
        const codes = g.permissions.map((p) => p.code);
        const n = codes.filter((c) => set.has(c)).length;
        return (
          <Paper key={g.code} withBorder p="sm">
            <Group justify="space-between" mb={6}>
              <Text fw={600}>{g.title}</Text>
              <Checkbox
                label={`${t.roles.allInGroup} · ${t.roles.selected(n, codes.length)}`}
                checked={n === codes.length}
                indeterminate={n > 0 && n < codes.length}
                onChange={(e) => toggle(codes, e.currentTarget.checked)}
                data-testid={`perm-group-${g.code}`}
              />
            </Group>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 8,
              }}
            >
              {g.permissions.map((p) => {
                const opens = MENU.filter((m) => m.to !== '/' && m.perms?.includes(p.code)).map(
                  (m) => m.label,
                );
                return (
                  <Checkbox
                    key={p.code}
                    checked={set.has(p.code)}
                    onChange={(e) => toggle([p.code], e.currentTarget.checked)}
                    label={p.title}
                    description={
                      <>
                        {p.description}
                        {opens.length > 0 && (
                          <Text span size="xs" c="blue.7" display="block">
                            {t.roles.opensSections}
                            {opens.join(', ')}
                          </Text>
                        )}
                      </>
                    }
                    data-testid={`perm-${p.code}`}
                  />
                );
              })}
            </Box>
          </Paper>
        );
      })}
    </Stack>
  );
}

function SortRow({
  e,
  handle,
  onToggle,
  testId,
}: {
  e: Entry;
  handle: HandleProps;
  onToggle(v: boolean): void;
  testId: string;
}) {
  return (
    <Paper withBorder px="xs" py={4} style={{ background: 'var(--mantine-color-body)' }}>
      <Group gap="xs" wrap="nowrap">
        <Text
          {...handle}
          c="dimmed"
          title={t.roles.dragHint}
          style={{ ...handle.style, padding: '2px 6px', userSelect: 'none', fontSize: 18, lineHeight: 1 }}
        >
          ⠿
        </Text>
        <Switch
          size="xs"
          checked={e.visible}
          onChange={(ev) => onToggle(ev.currentTarget.checked)}
          data-testid={testId}
        />
        <Text size="sm" c={e.visible ? undefined : 'dimmed'} td={e.visible ? undefined : 'line-through'}>
          {e.label}
        </Text>
      </Group>
    </Paper>
  );
}

function SortableEntries({
  entries,
  onChange,
  testId,
  min = 0,
}: {
  entries: Entry[];
  onChange(e: Entry[]): void;
  testId: string;
  min?: number;
}) {
  return (
    <SortableList
      items={entries}
      keyOf={(e) => e.key}
      onReorder={onChange}
      testId={testId}
      renderRow={(e, handle) => (
        <SortRow
          e={e}
          handle={handle}
          testId={`${testId}-visible-${e.key}`}
          onToggle={(v) => {
            const next = entries.map((x) => (x.key === e.key ? { ...x, visible: v } : x));
            if (next.filter((x) => x.visible).length < min) return;
            onChange(next);
          }}
        />
      )}
    />
  );
}

function UiEditor({
  perms,
  value,
  onChange,
}: {
  perms: string[];
  value: RoleUi | null;
  onChange(v: RoleUi | null): void;
}) {
  // Пункты меню, доступные по отмеченным правам: скрыть/упорядочить можно только их.
  const items: MenuItem[] = MENU.filter((m) => allowed(m, perms));
  const menu = entriesOf(
    items.map((m) => ({ value: m.to, label: m.label })),
    value?.menu ? value.menu.map((m) => ({ key: m.to, visible: m.visible })) : null,
  );
  const ws = perms.includes('conversations.work');
  const listAll = LIST_TABS.filter((x) => !x.perm || perms.includes(x.perm));
  const tabsEntries = (all: { value: string; label: string }[], saved: string[] | undefined) =>
    saved?.length
      ? entriesOf(all, [
          ...saved.map((k) => ({ key: k, visible: true })),
          ...all.filter((x) => !saved.includes(x.value)).map((x) => ({ key: x.value, visible: false })),
        ])
      : entriesOf(all, null);
  const listTabs = tabsEntries(listAll, value?.workspace?.listTabs);
  const rightTabs = tabsEntries(RIGHT_TABS, value?.workspace?.rightTabs);

  const write = (patch: { menu?: Entry[]; home?: string | null; list?: Entry[]; right?: Entry[] }) => {
    const m = patch.menu ?? menu;
    const l = patch.list ?? listTabs;
    const r = patch.right ?? rightTabs;
    onChange({
      v: 1,
      home: patch.home !== undefined ? patch.home : (value?.home ?? null),
      menu: m.map((e) => ({ to: e.key, visible: e.visible })),
      workspace: {
        listTabs: l.filter((e) => e.visible).map((e) => e.key),
        rightTabs: r.filter((e) => e.visible).map((e) => e.key),
      },
    });
  };
  const visibleMenu = menu.filter((e) => e.visible);

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t.roles.uiIntro}
      </Text>
      <Group>
        <Switch
          checked={!!value}
          onChange={(e) => (e.currentTarget.checked ? write({}) : onChange(null))}
          label={value ? t.roles.uiCustom : t.roles.uiStandard}
          data-testid="ui-custom"
        />
      </Group>
      {value && (
        <Grid gutter="md">
          <Grid.Col span={{ base: 12, md: 7 }}>
            <Stack gap="sm">
              <Select
                label={t.roles.home}
                placeholder={t.roles.homeDefault}
                data={items.filter((m) => m.to !== '/').map((m) => ({ value: m.to, label: m.label }))}
                value={value.home ?? null}
                onChange={(v) => write({ home: v })}
                clearable
                data-testid="ui-home"
              />
              <Text fw={600} size="sm">
                {t.roles.menu}
              </Text>
              {menu.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t.roles.menuEmpty}
                </Text>
              ) : (
                <SortableEntries entries={menu} onChange={(m) => write({ menu: m })} testId="ui-menu" />
              )}
              {ws && (
                <>
                  <Text fw={600} size="sm" mt="xs">
                    {t.roles.wsList}
                  </Text>
                  <SortableEntries
                    entries={listTabs}
                    onChange={(l) => write({ list: l })}
                    testId="ui-list-tabs"
                    min={1}
                  />
                  <Text fw={600} size="sm" mt="xs">
                    {t.roles.wsRight}
                  </Text>
                  <SortableEntries
                    entries={rightTabs}
                    onChange={(r) => write({ right: r })}
                    testId="ui-right-tabs"
                    min={1}
                  />
                  <Text size="xs" c="dimmed">
                    {t.roles.wsFirstOpens}
                  </Text>
                </>
              )}
              <Group>
                <Button variant="subtle" onClick={() => onChange(null)} data-testid="ui-reset">
                  {t.roles.uiReset}
                </Button>
              </Group>
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 5 }}>
            <Paper withBorder p="sm" bg="var(--mantine-color-gray-0)">
              <Text fw={600} size="sm" mb={6}>
                {t.roles.preview}
              </Text>
              <Stack gap={2} data-testid="ui-preview">
                {visibleMenu.map((e) => (
                  <Text
                    key={e.key}
                    size="sm"
                    px={8}
                    py={4}
                    style={{
                      borderRadius: 6,
                      background: e.key === (value.home ?? '/') ? 'var(--mantine-color-blue-1)' : undefined,
                    }}
                  >
                    {e.label}
                  </Text>
                ))}
              </Stack>
            </Paper>
          </Grid.Col>
        </Grid>
      )}
    </Stack>
  );
}
