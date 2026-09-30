import { Alert, Button, Group, Modal, Progress, Select, Stack, Switch, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { applySink, audioDevices, type DeviceKind, toneUrl, useAudioDevices } from '../lib/audio-devices';
import { webHidSupported } from '../lib/headset';
import { softphone, useSoftphone } from '../lib/softphone';
import { t } from '../lib/i18n';

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
        {t.audioSettingsUi.mikrofonNedostupen}
        {error}
      </Text>
    );
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {t.audioSettingsUi.skazhiteChtoNibudPolosa}
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
        ? { color: 'green', message: t.audioSettingsUi.garnituraPodklyuchenaKnopkiOtveta }
        : {
            color: 'yellow',
            message: t.audioSettingsUi.garnituraNeVybranaIli,
          },
    );
  };
  return (
    <Modal opened onClose={onClose} title={t.audioSettingsUi.nastroykiZvukaIGarnitury} size="lg">
      <Stack>
        {sel('mic', t.audioSettingsUi.mikrofon, d.inputs, 'device-mic')}
        <MicMeter deviceKey={`${d.effective.mic?.id}|${JSON.stringify(d.processing)}`} />
        {d.sinkSupported ? (
          <>
            <Group align="end" grow>
              {sel('speaker', t.audioSettingsUi.dinamikRazgovora, d.outputs, 'device-speaker')}
              <Button variant="light" onClick={() => void playTest('speaker')} data-testid="test-speaker">
                {t.audioSettingsUi.proveritDinamik}
              </Button>
            </Group>
            <Group align="end" grow>
              {sel('ringer', t.audioSettingsUi.zvonokRington, d.outputs, 'device-ringer')}
              <Button variant="light" onClick={() => void playTest('ringer')} data-testid="test-ringer">
                {t.audioSettingsUi.proveritZvonok}
              </Button>
            </Group>
          </>
        ) : (
          <Alert color="yellow">{t.audioSettingsUi.brauzerNePodderzhivaetVybor}</Alert>
        )}
        <Text fw={600} size="sm">
          {t.audioSettingsUi.obrabotkaZvuka}
        </Text>
        <Group>
          <Switch
            label={t.audioSettingsUi.podavlenieEkha}
            checked={d.processing.echoCancellation}
            onChange={(e) => audioDevices.setProcessing({ echoCancellation: e.currentTarget.checked })}
          />
          <Switch
            label={t.audioSettingsUi.shumopodavlenie}
            checked={d.processing.noiseSuppression}
            onChange={(e) => audioDevices.setProcessing({ noiseSuppression: e.currentTarget.checked })}
          />
          <Switch
            label={t.audioSettingsUi.avtousilenie}
            checked={d.processing.autoGainControl}
            onChange={(e) => audioDevices.setProcessing({ autoGainControl: e.currentTarget.checked })}
          />
        </Group>
        <Text fw={600} size="sm">
          {t.audioSettingsUi.knopkiGarnitury}
        </Text>
        {webHidSupported() ? (
          <Group>
            <Text size="sm" data-testid="headset-name">
              {phone.headset
                ? t.audioSettingsUi.podklyuchena(phone.headset)
                : t.audioSettingsUi.nePodklyuchena}
            </Text>
            <Button variant="light" size="xs" onClick={() => void connect()}>
              {phone.headset ? t.audioSettingsUi.vybratDruguyu : t.audioSettingsUi.podklyuchitGarnituru}
            </Button>
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            {t.audioSettingsUi.brauzerNePodderzhivaetWebhid}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {t.audioSettingsUi.goryachieKlavishiCtrlAlt}
        </Text>
      </Stack>
    </Modal>
  );
}
