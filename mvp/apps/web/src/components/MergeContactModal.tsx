import { Button, Card, Group, Modal, Radio, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { post } from '../lib/api';
import { type Row, useAction, useList } from '../lib/data';

/**
 * Ручное слияние дублей клиентов (M-CARD-01): поиск второго клиента, выбор основного, подтверждение.
 * Идентификаторы, обращения и согласия дубля переходят к основному; дубль исчезает из поиска.
 */
export function MergeContactModal({
  contact,
  opened,
  onClose,
}: {
  contact: Row;
  opened: boolean;
  onClose(): void;
}) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [other, setOther] = useState<Row | null>(null);
  const [keep, setKeep] = useState<'this' | 'other'>('this');
  useEffect(() => {
    const h = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    if (!opened) {
      setQ('');
      setOther(null);
      setKeep('this');
    }
  }, [opened]);
  const found = useList(
    `/contacts?q=${encodeURIComponent(term)}&exclude=${String(contact.id)}`,
    opened && term.length >= 2,
  );
  const name = (c: Row) => String(c.displayName ?? c.phone ?? c.email ?? 'Клиент');
  const merge = useAction(() => {
    const main = keep === 'this' ? contact : other!;
    const dup = keep === 'this' ? other! : contact;
    return post(`/contacts/${main.id}/merge`, { duplicateId: dup.id });
  }, 'Клиенты объединены');
  return (
    <Modal opened={opened} onClose={onClose} title="Объединить клиентов" size="lg">
      <Stack gap="xs">
        <Text size="sm">
          Клиент: <b>{name(contact)}</b>
        </Text>
        <TextInput
          label="Найти дубль"
          placeholder="Имя, телефон, email или Telegram ID"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          data-testid="merge-search"
        />
        {term.length >= 2 && (found.data ?? []).length === 0 && (
          <Text size="sm" c="dimmed">
            Никого не найдено
          </Text>
        )}
        {(found.data ?? []).map((c) => (
          <Card
            key={c.id}
            withBorder
            padding="xs"
            style={{
              cursor: 'pointer',
              borderColor: other?.id === c.id ? 'var(--mantine-color-blue-5)' : undefined,
            }}
            onClick={() => setOther(c)}
            data-testid="merge-candidate"
          >
            <Text size="sm" fw={600}>
              {name(c)}
            </Text>
            <Text size="xs" c="dimmed">
              {[c.phone, c.email].filter(Boolean).join(' · ')} · обращений: {String(c.conversations ?? 0)}
            </Text>
          </Card>
        ))}
        {other && (
          <Radio.Group
            label="Основной клиент (останется в поиске)"
            value={keep}
            onChange={(v) => setKeep(v as 'this' | 'other')}
          >
            <Group mt={4}>
              <Radio value="this" label={name(contact)} />
              <Radio value="other" label={name(other)} data-testid="merge-keep-other" />
            </Group>
          </Radio.Group>
        )}
        <Text size="xs" c="dimmed">
          Идентификаторы в каналах, обращения, согласия и вложения второго клиента перейдут к основному; пустые
          поля основного дополнятся. Отменить слияние нельзя.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            color="orange"
            disabled={!other}
            loading={merge.isPending}
            onClick={() => merge.mutate(undefined, { onSuccess: onClose })}
            data-testid="merge-confirm"
          >
            Объединить
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
