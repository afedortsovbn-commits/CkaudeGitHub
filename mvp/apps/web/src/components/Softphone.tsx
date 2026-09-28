import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Popover,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { errorText, post } from '../lib/api';
import { options, type Row, useList } from '../lib/data';
import { softphone, useSoftphone } from '../lib/softphone';

const REG = {
  off: { color: 'gray', label: 'Телефон выключен' },
  connecting: { color: 'yellow', label: 'Телефон: подключение…' },
  registered: { color: 'green', label: 'Телефон готов' },
  error: { color: 'red', label: 'Телефон: ошибка' },
} as const;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

async function command(callId: string | null, op: string, body?: unknown) {
  if (!callId) {
    notifications.show({ color: 'red', message: 'Звонок ещё не соединён с КЦ — повторите через секунду' });
    return;
  }
  try {
    await post(`/calls/${callId}/${op}`, body);
  } catch (e) {
    notifications.show({ color: 'red', title: 'Ошибка', message: errorText(e) });
  }
}

/** Индикатор регистрации и набор номера — в шапке. */
export function SoftphoneStatus() {
  const s = useSoftphone();
  const [number, setNumber] = useState('');
  const r = REG[s.reg];
  return (
    <Group gap="xs">
      <Tooltip label={s.error ?? r.label} disabled={!s.error}>
        <Badge color={r.color} variant="dot" data-testid="softphone-status">
          {r.label}
        </Badge>
      </Tooltip>
      <Popover position="bottom-end" withArrow>
        <Popover.Target>
          <Button
            size="xs"
            variant="light"
            disabled={s.reg !== 'registered' || !!s.call}
            data-testid="dial-open"
          >
            Набрать
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Group gap="xs">
            <TextInput
              size="xs"
              placeholder="+375 29 123-45-67"
              value={number}
              onChange={(e) => setNumber(e.currentTarget.value)}
              data-testid="dial-number"
            />
            <Button size="xs" onClick={() => void softphone.call(number)} data-testid="dial-call">
              Позвонить
            </Button>
          </Group>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}

function Transfer({ callId, onClose }: { callId: string | null; onClose(): void }) {
  const [kind, setKind] = useState<string | null>('user');
  const [target, setTarget] = useState<string | null>(null);
  const [ent, setEnt] = useState<string | null>(null);
  const operators = useList('/operators');
  const queues = useList('/dict/queues');
  const enterprises = useList('/dict/enterprises');
  const deps = useList<Row>(`/enterprise-departments?enterpriseId=${ent ?? 'none'}`, !!ent);
  const submit = async () => {
    if (!target) return;
    const t =
      kind === 'user'
        ? { kind, userId: target }
        : kind === 'queue'
          ? { kind, queueId: target }
          : { kind: 'department', enterpriseId: ent, departmentId: target };
    await command(callId, 'transfer', { target: t });
    onClose();
  };
  return (
    <Modal opened onClose={onClose} title="Перевести звонок">
      <Stack>
        <Select
          label="Куда"
          data={[
            { value: 'user', label: 'Оператору' },
            { value: 'queue', label: 'В очередь' },
            { value: 'department', label: 'В подразделение предприятия' },
          ]}
          value={kind}
          onChange={(v) => (setKind(v), setTarget(null))}
          data-testid="transfer-kind"
        />
        {kind === 'department' && (
          <Select
            label="Предприятие"
            data={options(enterprises.data)}
            value={ent}
            onChange={setEnt}
            searchable
          />
        )}
        <Select
          label={kind === 'user' ? 'Оператор' : kind === 'queue' ? 'Очередь' : 'Подразделение'}
          data={
            kind === 'user'
              ? options(operators.data, 'fullName')
              : kind === 'queue'
                ? options(queues.data)
                : (deps.data ?? []).map((d) => ({
                    value: String(d.departmentId),
                    label: String(d.departmentName),
                  }))
          }
          value={target}
          onChange={setTarget}
          searchable
          data-testid="transfer-target"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={!target} data-testid="transfer-submit">
            Перевести
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Панель текущего звонка (M-OP-05): ответ/отбой, удержание с музыкой, микрофон, тональный набор, перевод. */
export function SoftphoneCall() {
  const { call } = useSoftphone();
  const [now, setNow] = useState(Date.now());
  const [transfer, setTransfer] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!call) return null;
  const talking = call.state === 'active';
  const title = call.listen
    ? 'Прослушивание разговора'
    : call.direction === 'incoming'
      ? 'Входящий звонок'
      : 'Исходящий звонок';
  return (
    <Paper
      shadow="lg"
      p="sm"
      radius="md"
      withBorder
      data-testid="softphone-call"
      data-state={call.state}
      style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 300, width: 330 }}
    >
      <Stack gap={6}>
        <Group justify="space-between">
          <Text fw={600}>{title}</Text>
          <Badge
            color={talking ? (call.onHold ? 'yellow' : 'green') : call.state === 'ended' ? 'gray' : 'blue'}
          >
            {call.state === 'ringing'
              ? 'звонит'
              : call.state === 'connecting'
                ? 'соединение'
                : call.state === 'ended'
                  ? 'завершён'
                  : call.onHold
                    ? 'на удержании'
                    : `разговор ${call.startedAt ? fmt(Math.floor((now - call.startedAt) / 1000)) : ''}`}
          </Badge>
        </Group>
        <Text size="sm" data-testid="softphone-remote">
          {call.remoteName || call.remote}
          {call.remoteName && call.remote && call.remoteName !== call.remote ? ` · ${call.remote}` : ''}
        </Text>
        {call.state === 'ringing' && call.direction === 'incoming' && (
          <Group grow>
            <Button color="green" onClick={() => void softphone.answer()} data-testid="call-answer">
              Ответить
            </Button>
            <Button
              color="red"
              variant="light"
              onClick={() => softphone.decline()}
              data-testid="call-decline"
            >
              Отклонить
            </Button>
          </Group>
        )}
        {talking && !call.listen && (
          <Group gap={6}>
            <Button
              size="xs"
              variant={call.onHold ? 'filled' : 'light'}
              color="yellow"
              onClick={() => void command(call.callId, call.onHold ? 'unhold' : 'hold')}
              data-testid="call-hold"
            >
              {call.onHold ? 'Снять с удержания' : 'Удержание'}
            </Button>
            <Button
              size="xs"
              variant={call.muted ? 'filled' : 'light'}
              onClick={() => softphone.toggleMute()}
              data-testid="call-mute"
            >
              {call.muted ? 'Микрофон выкл.' : 'Микрофон'}
            </Button>
            <Popover withArrow>
              <Popover.Target>
                <Button size="xs" variant="light">
                  Клавиатура
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <SimpleGrid cols={3} spacing={4}>
                  {'123456789*0#'.split('').map((d) => (
                    <ActionIcon key={d} variant="default" size="lg" onClick={() => softphone.dtmf(d)}>
                      {d}
                    </ActionIcon>
                  ))}
                </SimpleGrid>
              </Popover.Dropdown>
            </Popover>
            <Button size="xs" variant="light" onClick={() => setTransfer(true)} data-testid="call-transfer">
              Перевести
            </Button>
          </Group>
        )}
        {call.state !== 'ended' && !(call.state === 'ringing' && call.direction === 'incoming') && (
          <Button color="red" onClick={() => softphone.hangup()} data-testid="call-hangup">
            Завершить
          </Button>
        )}
      </Stack>
      {transfer && <Transfer callId={call.callId} onClose={() => setTransfer(false)} />}
    </Paper>
  );
}
