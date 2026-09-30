import { Badge, Button, Group, Stack, Table, Tabs, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { post } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';

const dt = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' }) : '—';

/**
 * Персональные данные (M-NFR-07, Ф12): реестр согласий клиентов с версиями текстов и обезличивание клиента по
 * запросу субъекта ПДн. Срок хранения записей разговоров — в «Настройках».
 */
export function PrivacyPage() {
  return (
    <Stack>
      <Title order={3}>Персональные данные</Title>
      <Tabs defaultValue="consents">
        <Tabs.List mb="md">
          <Tabs.Tab value="consents">Реестр согласий</Tabs.Tab>
          <Tabs.Tab value="texts">Тексты согласий</Tabs.Tab>
          <Tabs.Tab value="erase">Обезличивание клиента</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="consents">
          <ConsentRegistry />
        </Tabs.Panel>
        <Tabs.Panel value="texts">
          <ConsentTexts />
        </Tabs.Panel>
        <Tabs.Panel value="erase">
          <EraseContact />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function ConsentRegistry() {
  const [q, setQ] = useState('');
  const list = useList<Row>(`/admin/consents${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  return (
    <Stack>
      <TextInput
        maw={320}
        placeholder="Клиент: имя, телефон, email"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      <Table striped data-testid="consent-registry">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Дата</Table.Th>
            <Table.Th>Клиент</Table.Th>
            <Table.Th>Канал</Table.Th>
            <Table.Th>Версия текста</Table.Th>
            <Table.Th>IP</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>{dt(r.acceptedAt)}</Table.Td>
              <Table.Td>
                {String(r.contactName ?? '—')}{' '}
                {r.contactAnonymized ? <Badge color="gray">обезличен</Badge> : null}
              </Table.Td>
              <Table.Td>{String(r.channelName)}</Table.Td>
              <Table.Td>{String(r.textVersion)}</Table.Td>
              <Table.Td>{String(r.ip ?? '—')}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function ConsentTexts() {
  const list = useList<Row>('/admin/consent-texts');
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Текст согласия задаётся в настройках канала (веб-чат, чат в приложении). Изменённый текст сохраняется
        только с новой версией — прежние версии хранятся, чтобы было видно, с каким текстом согласился клиент.
      </Text>
      <Table data-testid="consent-texts">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Канал</Table.Th>
            <Table.Th>Версия</Table.Th>
            <Table.Th>Текст</Table.Th>
            <Table.Th>С</Table.Th>
            <Table.Th>Согласий</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>{String(r.channelName)}</Table.Td>
              <Table.Td>{String(r.version)}</Table.Td>
              <Table.Td maw={420}>{String(r.text)}</Table.Td>
              <Table.Td>{dt(r.createdAt)}</Table.Td>
              <Table.Td>{String(r.accepted)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function EraseContact() {
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const list = useList<Row>(`/admin/contacts?q=${encodeURIComponent(q)}`);
  const erase = useAction(
    (id: string) => post(`/contacts/${id}/anonymize`, { confirm: true, reason }),
    'Клиент обезличен',
  );
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        По запросу клиента стираются его имя, телефон, email, идентификаторы в каналах, тексты его сообщений,
        вложения и записи разговоров (в том числе в журнале событий). Обращения, их темы и результаты остаются
        для отчётов. Действие необратимо и записывается в журнал аудита с основанием.
      </Text>
      <TextInput
        maw={320}
        placeholder="Имя, телефон, email (от 2 символов)"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        data-testid="erase-search"
      />
      <Textarea
        maw={520}
        label="Основание (например, номер и дата заявления)"
        value={reason}
        onChange={(e) => setReason(e.currentTarget.value)}
        data-testid="erase-reason"
      />
      <Table>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>{String(r.displayName ?? '—')}</Table.Td>
              <Table.Td>{String(r.phone ?? '')}</Table.Td>
              <Table.Td>{String(r.email ?? '')}</Table.Td>
              <Table.Td>обращений: {String(r.conversations)}</Table.Td>
              <Table.Td>
                {r.anonymizedAt ? (
                  <Badge color="gray">обезличен</Badge>
                ) : (
                  <Group>
                    <Button
                      size="xs"
                      color="red"
                      variant="outline"
                      disabled={reason.trim().length < 3}
                      onClick={() => {
                        if (window.confirm('Обезличить клиента? Действие необратимо.')) erase.mutate(r.id);
                      }}
                    >
                      Обезличить
                    </Button>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
