import { Badge, Button, NumberInput, Select, Stack, Switch, Table, TextInput, Title } from '@mantine/core';
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
  // Только изменённые значения: в system_setting есть и служебные ключи (например, отметка дня рассылки),
  // которые сервер не принимает на запись.
  const save = useAction(() =>
    patch(
      '/settings',
      Object.fromEntries(
        Object.entries(v).filter(([k, x]) => JSON.stringify(x) !== JSON.stringify(s.data?.[k])),
      ),
    ),
  );
  const thresholds = (v['supervisor.thresholds'] ?? {}) as Record<string, number>;
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
      <TextInput
        label="Автосообщение клиенту при передаче на 2-ю линию"
        description="Уходит в текстовых каналах; пусто — не отправлять"
        value={String(v['ticket.transfer_message'] ?? '')}
        onChange={(e) => setV({ ...v, 'ticket.transfer_message': e.currentTarget.value })}
      />
      <Title order={5} mt="md">
        Панель супервизора и отчёты
      </Title>
      {(
        [
          ['waitWarnS', 'Ожидание в очереди — внимание, с', 60],
          ['waitCritS', 'Ожидание в очереди — критично, с', 180],
          ['queueWarn', 'Ожидающих в очереди — внимание', 5],
          ['queueCrit', 'Ожидающих в очереди — критично', 15],
          ['breakWarnS', 'Подсвечивать перерыв оператора дольше, с', 900],
          ['slTargetPct', 'Цель SL за сегодня, %', 80],
        ] as const
      ).map(([k, label, def]) => (
        <NumberInput
          key={k}
          label={label}
          min={1}
          value={Number(thresholds[k] ?? def)}
          onChange={(x) => setV({ ...v, 'supervisor.thresholds': { ...thresholds, [k]: Number(x) } })}
          data-testid={`setting-${k}`}
        />
      ))}
      {(
        [
          ['report.sl_voice_s', 'SL: ответ на звонок в пределах, с', 20],
          ['report.sl_text_s', 'SL: ответ в текстовом канале в пределах, с', 60],
          ['report.short_abandon_s', 'Короткий сброс (не считается пропущенным), с', 5],
          ['report.first_response_s', 'Первый ответ в чате вовремя, с', 120],
        ] as const
      ).map(([k, label, def]) => (
        <NumberInput
          key={k}
          label={label}
          min={0}
          value={Number(v[k] ?? def)}
          onChange={(x) => setV({ ...v, [k]: Number(x) })}
        />
      ))}
      <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
        {t.save}
      </Button>
      <ReleasePanel />
    </Stack>
  );
}

const RELEASE_STATUS: Record<string, [string, string]> = {
  started: ['идёт', 'blue'],
  succeeded: ['успешно', 'green'],
  failed: ['ошибка', 'red'],
  rolled_back: ['откат', 'orange'],
};

/**
 * Обновления без простоя (Ф11): фиче-флаги (новая функциональность включается после обновления всех
 * экземпляров) и журнал выпусков ops/release.sh. Изменения действуют без перезапуска.
 */
function ReleasePanel() {
  const flags = useList('/admin/feature-flags');
  const releases = useList('/admin/releases');
  const toggle = useAction((b: { key: string; enabled: boolean }) =>
    patch(`/admin/feature-flags/${encodeURIComponent(b.key)}`, { enabled: b.enabled }),
  );
  return (
    <>
      <Title order={4} mt="md">
        {t.release.flags}
      </Title>
      {(flags.data ?? []).map((f) => (
        <Switch
          key={String(f.key)}
          data-testid={`flag-${String(f.key)}`}
          label={String(f.key)}
          description={f.description ? String(f.description) : undefined}
          checked={Boolean(f.enabled)}
          onChange={(e) => toggle.mutate({ key: String(f.key), enabled: e.currentTarget.checked })}
        />
      ))}
      <Title order={4} mt="md">
        {t.release.log}
      </Title>
      <Table data-testid="release-log">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.release.tag}</Table.Th>
            <Table.Th>{t.release.started}</Table.Th>
            <Table.Th>{t.release.duration}</Table.Th>
            <Table.Th>{t.release.status}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(releases.data ?? []).map((r) => {
            const [label, color] = RELEASE_STATUS[String(r.status)] ?? [String(r.status), 'gray'];
            const ms = r.finishedAt
              ? new Date(String(r.finishedAt)).getTime() - new Date(String(r.startedAt)).getTime()
              : null;
            return (
              <Table.Tr key={String(r.id)}>
                <Table.Td>
                  {r.prevTag ? `${String(r.prevTag)} → ` : ''}
                  {String(r.tag)}
                </Table.Td>
                <Table.Td>
                  {new Date(String(r.startedAt)).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}
                </Table.Td>
                <Table.Td>{ms === null ? '—' : `${Math.round(ms / 1000)} с`}</Table.Td>
                <Table.Td>
                  <Badge color={color} variant="light">
                    {label}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </>
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
