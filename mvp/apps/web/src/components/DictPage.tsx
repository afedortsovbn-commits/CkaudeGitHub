import { Badge, Button, Group, Switch, Table, TextInput, Title } from '@mantine/core';
import { type ReactNode, useMemo, useState } from 'react';
import { patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';
import { type FormField, FormModal } from './FormModal';

export interface Column {
  key: string;
  label: string;
  render?(row: Row): ReactNode;
}

interface Props {
  kind: string;
  title: string;
  columns: Column[];
  fields: FormField[];
  writePerm?: string | string[];
  toolbar?: ReactNode;
  /** Действия строки (например, «Предприятия» у подразделения). */
  rowActions?(row: Row): ReactNode;
  /** Подготовка значений формы редактирования. */
  toForm?(row: Row): Record<string, unknown>;
  /** Преобразование значений формы перед отправкой (например, сборка вложенного config). */
  fromForm?(values: Record<string, unknown>, editing: Row | null): Record<string, unknown>;
  hideTitle?: boolean;
  /** Начальные значения формы новой записи. */
  createDefaults?: Record<string, unknown>;
}

/** Страница простого справочника поверх /api/v1/dict/:kind. */
export function DictPage({
  kind,
  title,
  columns,
  fields,
  writePerm = 'admin.directories',
  toolbar,
  rowActions,
  toForm,
  fromForm,
  hideTitle,
  createDefaults,
}: Props) {
  const { can } = useAuth();
  const [showInactive, setShowInactive] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const list = useList(
    `/dict/${kind}?active=${showInactive ? 'all' : 'true'}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  );
  const save = useAction(async (raw: Record<string, unknown>) => {
    const vals = fromForm ? fromForm(raw, editing === 'new' ? null : editing) : raw;
    return editing === 'new'
      ? post(`/dict/${kind}`, vals)
      : patch(`/dict/${kind}/${(editing as Row).id}`, vals);
  });
  const toggle = useAction((r: Row) =>
    post(`/dict/${kind}/${r.id}/${r.isActive ? 'deactivate' : 'activate'}`),
  );
  const writable = can(...[writePerm].flat());
  const initial = useMemo(
    () => (editing && editing !== 'new' ? (toForm ? toForm(editing) : editing) : (createDefaults ?? {})),
    [editing, toForm, createDefaults],
  );

  return (
    <>
      <Group justify="space-between" mb="md">
        {!hideTitle && <Title order={3}>{title}</Title>}
        <Group>
          <TextInput placeholder={t.search} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          <Switch
            label={t.showInactive}
            checked={showInactive}
            onChange={(e) => setShowInactive(e.currentTarget.checked)}
          />
          {toolbar}
          {writable && <Button onClick={() => setEditing('new')}>{t.add}</Button>}
        </Group>
      </Group>
      <Table striped highlightOnHover data-testid={`dict-${kind}`}>
        <Table.Thead>
          <Table.Tr>
            {columns.map((c) => (
              <Table.Th key={c.key}>{c.label}</Table.Th>
            ))}
            <Table.Th>Статус</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              {columns.map((c) => (
                <Table.Td key={c.key}>{c.render ? c.render(r) : String(r[c.key] ?? '')}</Table.Td>
              ))}
              <Table.Td>
                {r.isActive ? (
                  <Badge color="green">{t.active}</Badge>
                ) : (
                  <Badge color="gray">{t.inactive}</Badge>
                )}
              </Table.Td>
              <Table.Td>
                <Group gap="xs" justify="flex-end">
                  {rowActions?.(r)}
                  {writable && (
                    <>
                      <Button size="xs" variant="light" onClick={() => setEditing(r)}>
                        {t.edit}
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        color={r.isActive ? 'red' : 'green'}
                        onClick={() => toggle.mutate(r)}
                      >
                        {r.isActive ? t.deactivate : t.activate}
                      </Button>
                    </>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <FormModal
        opened={editing !== null}
        title={editing === 'new' ? `${title}: новая запись` : `${title}: изменение`}
        fields={fields}
        initial={initial}
        isCreate={editing === 'new'}
        loading={save.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(v) => save.mutate(v, { onSuccess: () => setEditing(null) })}
      />
    </>
  );
}
