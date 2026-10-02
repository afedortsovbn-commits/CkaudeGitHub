import {
  ActionIcon,
  Badge,
  Button,
  Alert,
  Group,
  Modal,
  Paper,
  Popover,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { audioDevices, type DeviceNotice } from '../lib/audio-devices';
import { AudioSettings } from './AudioSettings';
import { errorText, post } from '../lib/api';
import { options, type Row, useList } from '../lib/data';
import { useAuth } from '../lib/auth';
import { softphone, type SupervisorMode, useSoftphone } from '../lib/softphone';
import { t } from '../lib/i18n';

const REG = {
  off: { color: 'gray', label: t.softphoneUi.telefonVyklyuchen },
  connecting: { color: 'yellow', label: t.softphoneUi.telefonPodklyuchenie },
  registered: { color: 'green', label: t.softphoneUi.telefonGotov },
  error: { color: 'red', label: t.softphoneUi.telefonOshibka },
} as const;

const QUALITY = {
  good: { color: 'green', label: t.softphoneUi.khoroshaya },
  fair: { color: 'yellow', label: t.softphoneUi.udovletvoritelnaya },
  poor: { color: 'red', label: t.softphoneUi.plokhaya },
} as const;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

async function command(callId: string | null, op: string, body?: unknown) {
  if (!callId) {
    notifications.show({ color: 'red', message: t.softphoneUi.zvonokEshcheNeSoedinen });
    return;
  }
  try {
    await post(`/calls/${callId}/${op}`, body);
  } catch (e) {
    notifications.show({ color: 'red', title: t.error, message: errorText(e) });
  }
}

/** Индикатор регистрации и набор номера — в шапке. */
const KIND_LABEL = {
  mic: t.softphoneUi.mikrofon,
  speaker: t.softphoneUi.dinamik,
  ringer: t.softphoneUi.ustroystvoZvonka,
} as const;

function noticeText(n: DeviceNotice): string {
  if (n.type === 'returned') return t.softphoneUi.snovaIspolzuetsya(KIND_LABEL[n.kind], n.device.label);
  return t.softphoneUi.otklyuchenPereklyuchenoNa(
    KIND_LABEL[n.kind],
    n.lost.label,
    n.now?.label ?? t.softphoneUi.netUstroystva,
  );
}

/** Горячие клавиши (M-OP-07 — если у гарнитуры нет кнопок): Ctrl+Alt+A / H / M. */
function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey) return;
      const c = softphone.getSnapshot().call;
      const k = e.code;
      if (k === 'KeyA' && c?.state === 'ringing' && c.direction === 'incoming') void softphone.answer();
      else if (k === 'KeyH' && c) {
        if (c.state === 'ringing' && c.direction === 'incoming') softphone.decline();
        else softphone.hangup();
      } else if (k === 'KeyM' && c?.state === 'active') softphone.toggleMute();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function SoftphoneStatus() {
  const s = useSoftphone();
  const [number, setNumber] = useState('');
  const [settings, setSettings] = useState(false);
  const r = REG[s.reg];
  useHotkeys();
  // Горячее подключение/отключение гарнитуры — уведомление (разговор продолжается на другом устройстве).
  useEffect(
    () =>
      audioDevices.onNotice((n) =>
        notifications.show({
          color: n.type === 'fallback' ? 'yellow' : 'blue',
          message: noticeText(n),
          autoClose: 8000,
        }),
      ),
    [],
  );
  return (
    <Group gap="xs">
      <Button size="xs" variant="subtle" onClick={() => setSettings(true)} data-testid="audio-settings">
        {t.softphoneUi.zvuk}
        {s.headset ? t.softphoneUi.garnitura : ''}
      </Button>
      {settings && <AudioSettings onClose={() => setSettings(false)} />}
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
            {t.softphoneUi.nabrat}
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
              {t.softphoneUi.pozvonit}
            </Button>
          </Group>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}

/** Перевод звонка или консультация перед переводом (Ф12b) — адресат выбирается одинаково. */
function Transfer({
  callId,
  consult = false,
  onClose,
}: {
  callId: string | null;
  consult?: boolean;
  onClose(): void;
}) {
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
    await command(callId, consult ? 'consult' : 'transfer', { target: t });
    onClose();
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title={consult ? t.softphoneUi.konsultatsiyaPeredPerevodom : t.softphoneUi.perevestiZvonok}
    >
      <Stack>
        <Select
          label={t.softphoneUi.kuda}
          data={[
            { value: 'user', label: t.softphoneUi.operatoru },
            { value: 'queue', label: t.softphoneUi.vOchered },
            { value: 'department', label: t.softphoneUi.vPodrazdeleniePredpriyatiya },
          ]}
          value={kind}
          onChange={(v) => (setKind(v), setTarget(null))}
          data-testid="transfer-kind"
        />
        {consult && (
          <Text size="xs" c="dimmed">
            {t.softphoneUi.klientBudetNaUderzhanii}
          </Text>
        )}
        {kind === 'department' && (
          <Select
            label={t.softphoneUi.predpriyatie}
            data={options(enterprises.data)}
            value={ent}
            onChange={setEnt}
            searchable
          />
        )}
        <Select
          label={
            kind === 'user'
              ? t.softphoneUi.operator
              : kind === 'queue'
                ? t.softphoneUi.ochered
                : t.softphoneUi.podrazdelenie
          }
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
            {t.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={!target} data-testid="transfer-submit">
            {consult ? t.softphoneUi.pozvonitAdresatu : t.softphoneUi.perevesti}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Супервизор в разговоре (Ф14, M-TEL-10): прослушивание → суфлирование (слышит только оператор) → вмешательство
 * (слышат оба) и обратно без переподключения; перехват — звонок переходит к супервизору.
 */
function SupervisorControls({
  callId,
  mode,
  can,
}: {
  callId: string | null;
  mode: SupervisorMode;
  can(...perms: string[]): boolean;
}) {
  const modes = [
    { value: 'listen', label: t.softphoneUi.rezhimProslushivanie },
    ...(can('calls.whisper') ? [{ value: 'whisper', label: t.softphoneUi.rezhimSuflirovanie }] : []),
    ...(can('calls.barge') ? [{ value: 'barge', label: t.softphoneUi.rezhimVmeshatelstvo }] : []),
  ];
  return (
    <Stack gap={4} data-testid="supervisor-controls" data-mode={mode}>
      {modes.length > 1 && (
        <SegmentedControl
          size="xs"
          fullWidth
          data={modes}
          value={mode}
          onChange={(v) => void command(callId, 'supervise', { mode: v })}
          data-testid="supervisor-mode"
        />
      )}
      <Text size="xs" c="dimmed">
        {mode === 'whisper'
          ? t.softphoneUi.vasSlyshitTolkoOperator
          : mode === 'barge'
            ? t.softphoneUi.vasSlyshatOba
            : t.softphoneUi.vasNiktoNeSlyshit}
      </Text>
      {mode !== 'listen' && (
        <Button size="xs" variant="light" onClick={() => softphone.toggleMute()} data-testid="call-mute">
          {softphone.getSnapshot().call?.muted ? t.softphoneUi.mikrofonVykl : t.softphoneUi.mikrofon}
        </Button>
      )}
      {can('conversations.takeover') && (
        <Button
          size="xs"
          color="orange"
          variant="light"
          onClick={() => void command(callId, 'takeover')}
          data-testid="supervisor-takeover"
        >
          {t.softphoneUi.perekhvatitZvonok}
        </Button>
      )}
    </Stack>
  );
}

/** Панель текущего звонка (M-OP-05): ответ/отбой, удержание с музыкой, микрофон, тональный набор, перевод. */
export function SoftphoneCall() {
  const { call } = useSoftphone();
  const { can } = useAuth();
  const [now, setNow] = useState(Date.now());
  const [transfer, setTransfer] = useState<false | 'transfer' | 'consult'>(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!call) return null;
  const talking = call.state === 'active';
  const title = call.listen
    ? call.supervisorMode === 'whisper'
      ? t.softphoneUi.suflirovanie
      : call.supervisorMode === 'barge'
        ? t.softphoneUi.vmeshatelstvo
        : t.softphoneUi.proslushivanieRazgovora
    : call.consultOf
      ? t.softphoneUi.konsultatsiyaKollegi
      : call.direction === 'incoming'
        ? t.softphoneUi.vkhodyashchiyZvonok
        : t.softphoneUi.iskhodyashchiyZvonok;
  const consult = call.consult;
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
              ? t.softphoneUi.zvonit
              : call.state === 'connecting'
                ? t.softphoneUi.soedinenie
                : call.state === 'ended'
                  ? t.softphoneUi.zavershen
                  : call.onHold
                    ? t.softphoneUi.naUderzhanii
                    : t.softphoneUi.razgovor(
                        call.startedAt ? fmt(Math.floor((now - call.startedAt) / 1000)) : '',
                      )}
          </Badge>
        </Group>
        {talking && (call.reconnecting || call.quality) && (
          <Badge
            variant="light"
            color={call.reconnecting ? 'orange' : QUALITY[call.quality!.level].color}
            data-testid="call-quality"
            title={
              call.quality
                ? t.softphoneUi.zaderzhkaMsDzhitterMs(
                    Math.round(call.quality.rttMs ?? 0),
                    Math.round(call.quality.jitterMs ?? 0),
                    (call.quality.lossPct ?? 0).toFixed(1),
                  )
                : ''
            }
          >
            {call.reconnecting
              ? t.softphoneUi.svyazPrervalasVosstanavlivaem
              : t.softphoneUi.svyaz(QUALITY[call.quality!.level].label)}
          </Badge>
        )}
        <Text size="sm" data-testid="softphone-remote">
          {call.remoteName || call.remote}
          {call.remoteName && call.remote && call.remoteName !== call.remote ? ` · ${call.remote}` : ''}
        </Text>
        {talking && !call.listen && call.supervisorMode && (
          <Alert
            p={6}
            color={call.supervisorMode === 'barge' ? 'orange' : 'grape'}
            data-testid="supervisor-banner"
            data-mode={call.supervisorMode}
          >
            <Text size="sm">
              {call.supervisorMode === 'barge'
                ? t.softphoneUi.supervizorVRazgovore
                : t.softphoneUi.supervizorPodskazyvaet}
            </Text>
          </Alert>
        )}
        {talking && call.listen && (
          <SupervisorControls callId={call.callId} mode={call.supervisorMode ?? 'listen'} can={can} />
        )}
        {call.state === 'ringing' && call.direction === 'incoming' && (
          <Group grow>
            <Button color="green" onClick={() => void softphone.answer()} data-testid="call-answer">
              {t.softphoneUi.otvetit}
            </Button>
            <Button
              color="red"
              variant="light"
              onClick={() => softphone.decline()}
              data-testid="call-decline"
            >
              {t.softphoneUi.otklonit}
            </Button>
          </Group>
        )}
        {talking && consult && (
          <Paper withBorder p={6} data-testid="consult-panel" data-state={consult.state}>
            <Text size="sm" fw={600}>
              {t.softphoneUi.konsultatsiya}
              {consult.label}
            </Text>
            <Text size="xs" c="dimmed" mb={4}>
              {consult.state === 'dialing'
                ? t.softphoneUi.zvonimAdresatuKlientNa
                : t.softphoneUi.razgovorSAdresatomKlient}
            </Text>
            <Group grow gap={6}>
              <Button
                size="xs"
                color="green"
                disabled={consult.state !== 'talking'}
                onClick={() => void command(call.callId, 'consult_complete')}
                data-testid="consult-complete"
              >
                {t.softphoneUi.soedinit}
              </Button>
              <Button
                size="xs"
                variant="light"
                onClick={() => void command(call.callId, 'consult_cancel')}
                data-testid="consult-cancel"
              >
                {t.softphoneUi.vernutsyaKKlientu}
              </Button>
            </Group>
          </Paper>
        )}
        {talking && !call.listen && !consult && (
          <Group gap={6}>
            {!call.consultOf && (
              <Button
                size="xs"
                variant={call.onHold ? 'filled' : 'light'}
                color="yellow"
                onClick={() => void command(call.callId, call.onHold ? 'unhold' : 'hold')}
                data-testid="call-hold"
              >
                {call.onHold ? t.softphoneUi.snyatSUderzhaniya : t.softphoneUi.uderzhanie}
              </Button>
            )}
            <Button
              size="xs"
              variant={call.muted ? 'filled' : 'light'}
              onClick={() => softphone.toggleMute()}
              data-testid="call-mute"
            >
              {call.muted ? t.softphoneUi.mikrofonVykl : t.softphoneUi.mikrofon}
            </Button>
            <Popover withArrow>
              <Popover.Target>
                <Button size="xs" variant="light">
                  {t.softphoneUi.klaviatura}
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
            {!call.consultOf && (
              <>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => setTransfer('transfer')}
                  data-testid="call-transfer"
                >
                  {t.softphoneUi.perevesti}
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => setTransfer('consult')}
                  data-testid="call-consult"
                >
                  {t.softphoneUi.konsultatsiya2}
                </Button>
              </>
            )}
          </Group>
        )}
        {call.state !== 'ended' && !(call.state === 'ringing' && call.direction === 'incoming') && (
          <Button color="red" onClick={() => softphone.hangup()} data-testid="call-hangup">
            {t.softphoneUi.zavershit}
          </Button>
        )}
      </Stack>
      {transfer && (
        <Transfer callId={call.callId} consult={transfer === 'consult'} onClose={() => setTransfer(false)} />
      )}
    </Paper>
  );
}
