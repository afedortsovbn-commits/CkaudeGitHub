import { Badge, Button, Group, Stack, Table, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import { post } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';
import { t } from '../lib/i18n';

const dt = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' }) : '—';

/**
 * Персональные данные (M-NFR-07, Ф12): реестр согласий клиентов с версиями текстов и обезличивание клиента по
 * запросу субъекта ПДн. Срок хранения записей разговоров — в «Настройках».
 */
export function PrivacyPage() {
  return (
    <Stack>
      <Tabs defaultValue="consents">
        <Tabs.List mb="md">
          <Tabs.Tab value="consents">{t.privacy.reestrSoglasiy}</Tabs.Tab>
          <Tabs.Tab value="texts">{t.privacy.tekstySoglasiy}</Tabs.Tab>
          <Tabs.Tab value="erase">{t.privacy.obezlichivanieKlienta}</Tabs.Tab>
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
        placeholder={t.privacy.klientImyaTelefonEmail}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      <Table striped data-testid="consent-registry">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.privacy.data}</Table.Th>
            <Table.Th>{t.privacy.klient}</Table.Th>
            <Table.Th>{t.privacy.kanal}</Table.Th>
            <Table.Th>{t.privacy.versiyaTeksta}</Table.Th>
            <Table.Th>IP</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>{dt(r.acceptedAt)}</Table.Td>
              <Table.Td>
                {String(r.contactName ?? '—')}{' '}
                {r.contactAnonymized ? <Badge color="gray">{t.privacy.obezlichen}</Badge> : null}
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
        {t.privacy.tekstSoglasiyaZadaetsyaV}
      </Text>
      <Table data-testid="consent-texts">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t.privacy.kanal}</Table.Th>
            <Table.Th>{t.release.tag}</Table.Th>
            <Table.Th>{t.privacy.tekst}</Table.Th>
            <Table.Th>{t.privacy.s}</Table.Th>
            <Table.Th>{t.privacy.soglasiy}</Table.Th>
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
    t.privacy.klientObezlichen,
  );
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t.privacy.poZaprosuKlientaStirayutsya}
      </Text>
      <TextInput
        maw={320}
        placeholder={t.privacy.imyaTelefonEmailOt}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        data-testid="erase-search"
      />
      <Textarea
        maw={520}
        label={t.privacy.osnovanieNaprimerNomerI}
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
              <Table.Td>
                {t.privacy.obrashcheniy}
                {String(r.conversations)}
              </Table.Td>
              <Table.Td>
                {r.anonymizedAt ? (
                  <Badge color="gray">{t.privacy.obezlichen}</Badge>
                ) : (
                  <Group>
                    <Button
                      size="xs"
                      color="red"
                      variant="outline"
                      disabled={reason.trim().length < 3}
                      onClick={() => {
                        if (window.confirm(t.privacy.obezlichitKlientaDeystvieNeobratimo)) erase.mutate(r.id);
                      }}
                    >
                      {t.privacy.obezlichit}
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
