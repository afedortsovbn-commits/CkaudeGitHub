import { Alert, Button, Group, Modal, Progress, Select, Stack, Switch, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { applySink, audioDevices, type DeviceKind, toneUrl, useAudioDevices } from '../lib/audio-devices';
import { webHidSupported } from '../lib/headset';
import { softphone, useSoftphone } from '../lib/softphone';

/** Индикатор уровня микрофона (тест микрофона, M-OP-06). */
function MicMeter({ deviceKey }: { deviceKey: string }) {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioDevices.micConstraints() });
        ctx = new AudioContext();
        // Контекст мог создаться «приостановленным» (правила автовоспроизведения) — запускаем явно.
        await ctx.resume().catch(() => undefined);
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          if (stop) return;
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(100, Math.round((peak / 128) * 160)));
          requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [deviceKey]);
  if (error)
    return (
      <Text c="red" size="xs">
        Микрофон недоступен: {error}
      </Text>
    );
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        Скажите что-нибудь — полоса должна двигаться
      </Text>
      <Progress
        value={level}
        color={level > 5 ? 'green' : 'gray'}
        data-testid="mic-level"
        data-level={level}
      />
    </Stack>
  );
}

async function playTest(kind: 'speaker' | 'ringer') {
  const a = new Audio(toneUrl(kind === 'ringer' ? 'ring' : 'test'));
  await applySink(a, audioDevices.sinkId(kind));
  await a.play().catch(() => undefined);
  setTimeout(() => a.pause(), kind === 'ringer' ? 3000 : 1500);
}

/** Настройки звука и гарнитуры оператора (M-OP-06/07, 02-архитектура 8.2). */
export function AudioSettings({ onClose }: { onClose(): void }) {
  const d = useAudioDevices();
  const phone = useSoftphone();
  useEffect(() => {
    if (!d.labelsVisible) void audioDevices.requestLabels();
  }, [d.labelsVisible]);
  const opts = (list: { id: string; label: string }[]) => list.map((x) => ({ value: x.id, label: x.label }));
  const sel = (kind: DeviceKind, label: string, list: { id: string; label: string }[], testid: string) => (
    <Select
      label={label}
      data={opts(list)}
      value={d.effective[kind]?.id ?? null}
      onChange={(v) => v && audioDevices.select(kind, v)}
      allowDeselect={false}
      data-testid={testid}
    />
  );
  const connect = async () => {
    const ok = await softphone.attachHeadset(true);
    notifications.show(
      ok
        ? { color: 'green', message: 'Гарнитура подключена: кнопки ответа, отбоя и микрофона работают' }
        : {
            color: 'yellow',
            message: 'Гарнитура не выбрана или не поддерживает стандартные кнопки телефонии (HID Telephony)',
          },
    );
  };
  return (
    <Modal opened onClose={onClose} title="Настройки звука и гарнитуры" size="lg">
      <Stack>
        {sel('mic', 'Микрофон', d.inputs, 'device-mic')}
        <MicMeter deviceKey={`${d.effective.mic?.id}|${JSON.stringify(d.processing)}`} />
        {d.sinkSupported ? (
          <>
            <Group align="end" grow>
              {sel('speaker', 'Динамик разговора', d.outputs, 'device-speaker')}
              <Button variant="light" onClick={() => void playTest('speaker')} data-testid="test-speaker">
                Проверить динамик
              </Button>
            </Group>
            <Group align="end" grow>
              {sel('ringer', 'Звонок (рингтон)', d.outputs, 'device-ringer')}
              <Button variant="light" onClick={() => void playTest('ringer')} data-testid="test-ringer">
                Проверить звонок
              </Button>
            </Group>
          </>
        ) : (
          <Alert color="yellow">
            Браузер не поддерживает выбор динамика — звук идёт на устройство по умолчанию.
          </Alert>
        )}
        <Text fw={600} size="sm">
          Обработка звука
        </Text>
        <Group>
          <Switch
            label="Подавление эха"
            checked={d.processing.echoCancellation}
            onChange={(e) => audioDevices.setProcessing({ echoCancellation: e.currentTarget.checked })}
          />
          <Switch
            label="Шумоподавление"
            checked={d.processing.noiseSuppression}
            onChange={(e) => audioDevices.setProcessing({ noiseSuppression: e.currentTarget.checked })}
          />
          <Switch
            label="Автоусиление"
            checked={d.processing.autoGainControl}
            onChange={(e) => audioDevices.setProcessing({ autoGainControl: e.currentTarget.checked })}
          />
        </Group>
        <Text fw={600} size="sm">
          Кнопки гарнитуры
        </Text>
        {webHidSupported() ? (
          <Group>
            <Text size="sm" data-testid="headset-name">
              {phone.headset ? `Подключена: ${phone.headset}` : 'Не подключена'}
            </Text>
            <Button variant="light" size="xs" onClick={() => void connect()}>
              {phone.headset ? 'Выбрать другую' : 'Подключить гарнитуру'}
            </Button>
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            Браузер не поддерживает WebHID — используйте кнопки в интерфейсе и горячие клавиши.
          </Text>
        )}
        <Text size="xs" c="dimmed">
          Горячие клавиши: Ctrl+Alt+A — ответить, Ctrl+Alt+H — завершить/отклонить, Ctrl+Alt+M — микрофон.
          Bluetooth-гарнитура при захвате микрофона переходит в режим гарнитуры (узкая полоса) — это
          нормально; при её отключении звонок продолжится на другом устройстве.
        </Text>
      </Stack>
    </Modal>
  );
}
