import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { FormModal } from '../components/FormModal';
import { patch, post } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

const TOPIC_FIELDS = [
  { key: 'name', label: t.topics.nazvanie, required: true },
  { key: 'code', label: t.topics.kod },
  { key: 'isImportant', label: t.topics.osoboVazhnayaBystryyFiltr, type: 'switch' as const },
  {
    key: 'defaultResponseDays',
    label: t.topics.srokOtveta2Y,
    type: 'number' as const,
    description: t.topics.pustoNasleduetsyaOtRoditelskoy,
  },
  { key: 'sortOrder', label: t.topics.poryadok, type: 'number' as const },
];

const FIELD_TYPES = [
  { value: 'text', label: t.topics.tekst },
  { value: 'number', label: t.topics.chislo },
  { value: 'date', label: t.topics.data },
  { value: 'select', label: t.topics.spisok },
  { value: 'phone', label: t.topics.telefon },
  { value: 'email', label: 'Email' },
];

function Fields({ topic }: { topic: Row }) {
  const list = useList(`/topics/${topic.id}/fields?active=all`);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const save = useAction((v: Record<string, unknown>) => {
    const body = {
      ...v,
      options:
        typeof v.options === 'string' && v.options
          ? String(v.options)
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
    };
    return editing === 'new'
      ? post(`/topics/${topic.id}/fields`, body)
      : patch(`/fields/${(editing as Row).id}`, body);
  });
  const toggle = useAction((f: Row) => patch(`/fields/${f.id}`, { isActive: !f.isActive }));
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>
          {t.topics.polyaKartochkiTemy}
          {String(topic.name)}»
        </Text>
        <Button size="xs" onClick={() => setEditing('new')}>
          {t.topics.dobavitPole}
        </Button>
      </Group>
      <Table>
        <Table.Tbody>
          {(list.data ?? []).map((f) => (
            <Table.Tr key={f.id} opacity={f.isActive ? 1 : 0.5}>
              <Table.Td>{String(f.label)}</Table.Td>
              <Table.Td>{FIELD_TYPES.find((x) => x.value === f.type)?.label}</Table.Td>
              <Table.Td>
                {f.requiredOnClose ? <Badge size="xs">{t.topics.obyazPriZakrytii}</Badge> : null}{' '}
                {f.requiredOnEscalate ? (
                  <Badge size="xs" color="orange">
                    {t.topics.obyazPriPeredache}
                  </Badge>
                ) : null}
              </Table.Td>
              <Table.Td>
                <Group gap="xs" justify="flex-end">
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() =>
                      setEditing({ ...f, options: ((f.options as string[] | null) ?? []).join('; ') })
                    }
                  >
                    {t.edit}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => toggle.mutate(f)}>
                    {f.isActive ? t.deactivate : t.activate}
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed">
        {t.topics.polyaNasleduyutsyaPodtemamiObyazatel}
      </Text>
      <FormModal
        opened={editing !== null}
        title={t.topics.poleKartochki}
        isCreate={editing === 'new'}
        initial={editing && editing !== 'new' ? editing : { type: 'text' }}
        fields={[
          { key: 'key', label: t.topics.klyuchLatinitsa, required: true, createOnly: true },
          { key: 'label', label: t.topics.nazvanie, required: true },
          { key: 'type', label: t.topics.tip, type: 'select', required: true, options: FIELD_TYPES },
          { key: 'mask', label: t.topics.maskaVvoda, placeholder: '0000 0000 0000 0000' },
          { key: 'options', label: t.topics.variantyDlyaSpiskaCherez },
          { key: 'requiredOnClose', label: t.topics.obyazatelnoPriZakrytii, type: 'switch' },
          { key: 'requiredOnEscalate', label: t.topics.obyazatelnoPriPeredacheNa, type: 'switch' },
          { key: 'sortOrder', label: t.topics.poryadok, type: 'number' },
        ]}
        loading={save.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(v) => save.mutate(v, { onSuccess: () => setEditing(null) })}
      />
    </Paper>
  );
}

export function TopicsPage() {
  const [showInactive, setShowInactive] = useState(false);
  const list = useList(`/topics?active=${showInactive ? 'all' : 'true'}`);
  const [editing, setEditing] = useState<{ row?: Row; parentId?: string | null } | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  // Двухуровневый справочник: сначала видны темы, любую можно развернуть; поиск раскрывает найденное.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const toggleExp = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  const children = useMemo(() => {
    const m = new Map<string | null, Row[]>();
    for (const r of list.data ?? [])
      m.set((r.parentId as string | null) ?? null, [
        ...(m.get((r.parentId as string | null) ?? null) ?? []),
        r,
      ]);
    return m;
  }, [list.data]);
  const save = useAction((v: Record<string, unknown>) =>
    editing?.row
      ? patch(`/topics/${editing.row.id}`, v)
      : post('/topics', { ...v, parentId: editing?.parentId ?? null }),
  );
  const toggle = useAction((r: Row) => post(`/topics/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`));

  const norm = (v: string) => v.toLowerCase();
  const words = norm(q).split(/\s+/).filter(Boolean);
  const selfMatch = (r: Row) => words.every((w) => norm(String(r.name)).includes(w));
  const matchBelow = (id: string): boolean =>
    (children.get(id) ?? []).some((c) => selfMatch(c) || matchBelow(c.id));
  const render = (parent: string | null, depth: number, all = false): React.ReactNode =>
    (children.get(parent) ?? []).map((r) => {
      const self = all || !words.length || selfMatch(r);
      const below = words.length > 0 && matchBelow(r.id);
      if (!self && !below) return null;
      const kids = (children.get(r.id) ?? []).length;
      const open = expanded.has(r.id) || below;
      return (
        <Box key={r.id}>
          <Group
            gap="xs"
            pl={depth * 24}
            py={4}
            wrap="nowrap"
            align="flex-start"
            opacity={r.isActive ? 1 : 0.5}
            data-testid={`topic-${String(r.name)}`}
          >
            {kids ? (
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label={open ? t.tree.collapse : t.tree.expand}
                onClick={() => toggleExp(r.id)}
              >
                {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              </ActionIcon>
            ) : (
              <Box w={28} />
            )}
            <Group gap="xs" style={{ flex: 1 }}>
              <Text fw={depth === 0 ? 600 : 400} style={{ cursor: 'pointer' }} onClick={() => setSelected(r)}>
                {String(r.name)}
              </Text>
              {kids > 0 && !open ? (
                <Text size="xs" c="dimmed">
                  ({kids})
                </Text>
              ) : null}
              {r.isImportant ? (
                <Badge color="red" size="xs">
                  {t.topics.osoboVazhnaya}
                </Badge>
              ) : null}
              {r.defaultResponseDays ? (
                <Badge variant="outline" size="xs">
                  {t.topics.srok}
                  {String(r.defaultResponseDays)}
                  {t.topics.dn}
                </Badge>
              ) : null}
              {Number(r.fieldCount) > 0 && (
                <Badge variant="light" size="xs">
                  {t.topics.poley}
                  {String(r.fieldCount)}
                </Badge>
              )}
              {Number(r.level) < 3 && r.isActive ? (
                <ActionIcon
                  size="sm"
                  variant="light"
                  title={t.topics.dobavitPodtemu}
                  onClick={() => {
                    setEditing({ parentId: r.id });
                    setExpanded(new Set([...expanded, r.id]));
                  }}
                >
                  +
                </ActionIcon>
              ) : null}
              <Button size="compact-xs" variant="subtle" onClick={() => setEditing({ row: r })}>
                {t.edit}
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                color={r.isActive ? 'red' : 'green'}
                onClick={() => toggle.mutate(r)}
              >
                {r.isActive ? t.deactivate : t.activate}
              </Button>
            </Group>
          </Group>
          {open && render(r.id, depth + 1, all || (words.length > 0 && selfMatch(r)))}
        </Box>
      );
    });

  return (
    <>
      <Group justify="space-between" mb="md">
        <span />
        <Group>
          <TextInput
            placeholder={t.tree.search}
            leftSection={<IconSearch size={14} />}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            data-testid="topics-search"
          />
          <Switch
            label={t.showInactive}
            checked={showInactive}
            onChange={(e) => setShowInactive(e.currentTarget.checked)}
          />
          <Button onClick={() => setEditing({ parentId: null })}>{t.topics.dobavitTemu}</Button>
        </Group>
      </Group>
      <Group align="flex-start" grow>
        <Stack gap={0}>{render(null, 0)}</Stack>
        {selected ? (
          <Fields topic={selected} />
        ) : (
          <Text c="dimmed">{t.topics.vyberiteTemuChtobyNastroit}</Text>
        )}
      </Group>
      <FormModal
        opened={editing !== null}
        title={
          editing?.row
            ? t.topics.temaIzmenenie
            : editing?.parentId
              ? t.topics.novayaPodtema
              : t.topics.novayaTema
        }
        fields={TOPIC_FIELDS}
        initial={editing?.row ?? {}}
        isCreate={!editing?.row}
        loading={save.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(v) => save.mutate(v, { onSuccess: () => setEditing(null) })}
      />
    </>
  );
}
