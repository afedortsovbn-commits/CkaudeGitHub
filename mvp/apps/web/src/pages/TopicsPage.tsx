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
  Title,
} from '@mantine/core';
import { useMemo, useState } from 'react';
import { FormModal } from '../components/FormModal';
import { patch, post } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

const TOPIC_FIELDS = [
  { key: 'name', label: 'Название', required: true },
  { key: 'code', label: 'Код' },
  { key: 'isImportant', label: 'Особо важная (быстрый фильтр в списках и отчётах)', type: 'switch' as const },
  {
    key: 'defaultResponseDays',
    label: 'Срок ответа 2-й линии по умолчанию, дней',
    type: 'number' as const,
    description: 'Пусто — наследуется от родительской темы, иначе глобальная настройка (15 дней)',
  },
  { key: 'sortOrder', label: 'Порядок', type: 'number' as const },
];

const FIELD_TYPES = [
  { value: 'text', label: 'Текст' },
  { value: 'number', label: 'Число' },
  { value: 'date', label: 'Дата' },
  { value: 'select', label: 'Список' },
  { value: 'phone', label: 'Телефон' },
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
        <Text fw={600}>Поля карточки темы «{String(topic.name)}»</Text>
        <Button size="xs" onClick={() => setEditing('new')}>
          Добавить поле
        </Button>
      </Group>
      <Table>
        <Table.Tbody>
          {(list.data ?? []).map((f) => (
            <Table.Tr key={f.id} opacity={f.isActive ? 1 : 0.5}>
              <Table.Td>{String(f.label)}</Table.Td>
              <Table.Td>{FIELD_TYPES.find((x) => x.value === f.type)?.label}</Table.Td>
              <Table.Td>
                {f.requiredOnClose ? <Badge size="xs">обяз. при закрытии</Badge> : null}{' '}
                {f.requiredOnEscalate ? (
                  <Badge size="xs" color="orange">
                    обяз. при передаче
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
        Поля наследуются подтемами. Обязательность задаётся отдельно для закрытия и для передачи на 2-ю линию.
      </Text>
      <FormModal
        opened={editing !== null}
        title="Поле карточки"
        isCreate={editing === 'new'}
        initial={editing && editing !== 'new' ? editing : { type: 'text' }}
        fields={[
          { key: 'key', label: 'Ключ (латиница)', required: true, createOnly: true },
          { key: 'label', label: 'Название', required: true },
          { key: 'type', label: 'Тип', type: 'select', required: true, options: FIELD_TYPES },
          { key: 'mask', label: 'Маска ввода', placeholder: '0000 0000 0000 0000' },
          { key: 'options', label: 'Варианты для списка (через ;)' },
          { key: 'requiredOnClose', label: 'Обязательно при закрытии', type: 'switch' },
          { key: 'requiredOnEscalate', label: 'Обязательно при передаче на 2-ю линию', type: 'switch' },
          { key: 'sortOrder', label: 'Порядок', type: 'number' },
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

  const render = (parent: string | null, depth: number): React.ReactNode =>
    (children.get(parent) ?? []).map((r) => (
      <Box key={r.id}>
        <Group
          gap="xs"
          pl={depth * 24}
          py={4}
          opacity={r.isActive ? 1 : 0.5}
          data-testid={`topic-${String(r.name)}`}
        >
          <Text fw={depth === 0 ? 600 : 400} style={{ cursor: 'pointer' }} onClick={() => setSelected(r)}>
            {String(r.name)}
          </Text>
          {r.isImportant ? (
            <Badge color="red" size="xs">
              особо важная
            </Badge>
          ) : null}
          {r.defaultResponseDays ? (
            <Badge variant="outline" size="xs">
              срок {String(r.defaultResponseDays)} дн.
            </Badge>
          ) : null}
          {Number(r.fieldCount) > 0 && (
            <Badge variant="light" size="xs">
              полей: {String(r.fieldCount)}
            </Badge>
          )}
          {Number(r.level) < 3 && r.isActive ? (
            <ActionIcon
              size="sm"
              variant="light"
              title="Добавить подтему"
              onClick={() => setEditing({ parentId: r.id })}
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
        {render(r.id, depth + 1)}
      </Box>
    ));

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>{t.nav.topics}</Title>
        <Group>
          <Switch
            label={t.showInactive}
            checked={showInactive}
            onChange={(e) => setShowInactive(e.currentTarget.checked)}
          />
          <Button onClick={() => setEditing({ parentId: null })}>Добавить тему</Button>
        </Group>
      </Group>
      <Group align="flex-start" grow>
        <Stack gap={0}>{render(null, 0)}</Stack>
        {selected ? (
          <Fields topic={selected} />
        ) : (
          <Text c="dimmed">Выберите тему, чтобы настроить поля карточки.</Text>
        )}
      </Group>
      <FormModal
        opened={editing !== null}
        title={editing?.row ? 'Тема: изменение' : editing?.parentId ? 'Новая подтема' : 'Новая тема'}
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
