import { Button, NumberInput, Select, Stack, Table, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, patch } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

export function SettingsPage() {
  const s = useQuery({ queryKey: ['/settings'], queryFn: () => get<Record<string, unknown>>('/settings') });
  const [v, setV] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (s.data) setV(s.data);
  }, [s.data]);
  const save = useAction(() => patch('/settings', v));
  return (
    <Stack maw={520}>
      <Title order={3}>{t.nav.settings}</Title>
      <NumberInput
        label="Срок ответа 2-й линии по умолчанию, календарных дней"
        description="Действует, если у темы и её родителей срок не задан"
        min={1}
        max={365}
        value={Number(v['ticket.default_response_days'] ?? 15)}
        onChange={(x) => setV({ ...v, 'ticket.default_response_days': Number(x) })}
      />
      <TextInput
        label="Время ежедневной рассылки по тикетам"
        description="Письма «осталось N дней / просрочено» — каждый день, включая выходные"
        value={String(v['ticket.daily_notification_time'] ?? '08:00')}
        onChange={(e) => setV({ ...v, 'ticket.daily_notification_time': e.currentTarget.value })}
      />
      <NumberInput
        label="Надбавка приоритета при эскалации по времени ожидания"
        description="Прибавляется к приоритету обращения один раз, когда истекает «Макс. ожидание» очереди (M-RT-04)"
        min={0}
        max={100000}
        value={Number(v['routing.escalation_boost'] ?? 1000)}
        onChange={(x) => setV({ ...v, 'routing.escalation_boost': Number(x) })}
      />
      <Select
        label="Кто согласует закрытие тикета"
        data={[
          { value: 'creator', label: 'Создатель тикета, его заместитель или супервизор' },
          { value: 'supervisor', label: 'Только супервизор' },
        ]}
        value={String(v['ticket.approval_mode'] ?? 'creator')}
        onChange={(x) => setV({ ...v, 'ticket.approval_mode': x })}
      />
      <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
        {t.save}
      </Button>
    </Stack>
  );
}

export function AuditPage() {
  const [entity, setEntity] = useState('');
  const list = useList<Row>(`/audit?limit=200${entity ? `&entity=${entity}` : ''}`);
  return (
    <>
      <Title order={3} mb="md">
        {t.nav.audit}
      </Title>
      <TextInput
        mb="md"
        maw={300}
        placeholder="Объект (например, topic, app_user)"
        value={entity}
        onChange={(e) => setEntity(e.currentTarget.value)}
      />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Когда</Table.Th>
            <Table.Th>Кто</Table.Th>
            <Table.Th>Действие</Table.Th>
            <Table.Th>Объект</Table.Th>
            <Table.Th>Было → стало</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td>{new Date(String(a.at)).toLocaleString('ru-RU')}</Table.Td>
              <Table.Td>{String(a.actorName ?? '')}</Table.Td>
              <Table.Td>{String(a.action)}</Table.Td>
              <Table.Td>
                {String(a.entity)} {a.entityId ? String(a.entityId).slice(0, 8) : ''}
              </Table.Td>
              <Table.Td style={{ fontSize: 11, maxWidth: 500, wordBreak: 'break-all' }}>
                {a.before ? JSON.stringify(a.before).slice(0, 200) : '—'} →{' '}
                {a.after ? JSON.stringify(a.after).slice(0, 200) : '—'}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
