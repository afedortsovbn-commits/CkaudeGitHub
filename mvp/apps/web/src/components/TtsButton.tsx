import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconVolume } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorText, get, postBlob, put, upload } from '../lib/api';
import { toIvrWav } from '../lib/audio-convert';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

interface TtsSettings {
  provider: 'off' | 'edge' | 'http';
  voice: string;
  rate: number;
  httpUrl: string | null;
  httpModel: string;
  httpVoice: string;
  edgeVoices: { value: string; label: string }[];
}

const useTtsSettings = () =>
  useQuery({ queryKey: ['/tts/settings'], queryFn: () => get<TtsSettings>('/tts/settings') });

/**
 * Кнопка «Озвучить текст» (Д-097): текст → звук выбранным движком синтеза → прослушать → сохранить в
 * аудиобиблиотеку (браузер приводит звук к формату IVR, как при загрузке файла). query — параметры загрузки
 * (например, фрагмент числа), onCreated — id нового файла (подставить в сценарий или объявление).
 */
export function TtsButton({
  defaultName = '',
  defaultText = '',
  query = '',
  onCreated,
  label = t.tts.button,
  size = 'xs',
  variant = 'light',
}: {
  defaultName?: string;
  defaultText?: string;
  query?: string;
  onCreated?(id: string): void;
  label?: string;
  size?: string;
  variant?: string;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Button
        size={size}
        variant={variant}
        leftSection={<IconVolume size={14} />}
        onClick={() => setOpened(true)}
        data-testid="tts-open"
      >
        {label}
      </Button>
      {opened && (
        <TtsDialog
          defaultName={defaultName}
          defaultText={defaultText}
          query={query}
          onClose={() => setOpened(false)}
          onCreated={(id) => {
            setOpened(false);
            onCreated?.(id);
          }}
        />
      )}
    </>
  );
}

function TtsDialog({
  defaultName,
  defaultText,
  query,
  onClose,
  onCreated,
}: {
  defaultName: string;
  defaultText: string;
  query: string;
  onClose(): void;
  onCreated(id: string): void;
}) {
  const qc = useQueryClient();
  const s = useTtsSettings();
  const [name, setName] = useState(defaultName);
  const [text, setText] = useState(defaultText);
  const [voice, setVoice] = useState<string | null>(null);
  const [rate, setRate] = useState<number | ''>('');
  const [audio, setAudio] = useState<{ key: string; blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState<'listen' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (s.data && voice === null) {
      setVoice(s.data.voice);
      setRate(s.data.rate);
    }
  }, [s.data]);
  useEffect(() => () => void (audio && URL.revokeObjectURL(audio.url)), [audio]);
  const key = `${voice}|${rate}|${text.trim()}`;
  const synth = async () => {
    if (audio?.key === key) return audio.blob;
    const blob = await postBlob('/tts/synthesize', {
      text: text.trim(),
      ...(voice ? { voice } : {}),
      ...(rate !== '' ? { rate } : {}),
    });
    setAudio({ key, blob, url: URL.createObjectURL(blob) });
    return blob;
  };
  const run = async (what: 'listen' | 'save') => {
    if (!text.trim()) {
      setError(t.tts.emptyText);
      return;
    }
    if (what === 'save' && !name.trim()) {
      setError(t.tts.emptyName);
      return;
    }
    setBusy(what);
    setError(null);
    try {
      const blob = await synth();
      if (what === 'save') {
        const wav = await toIvrWav(blob);
        const n = name.trim();
        const r = await upload<{ id: string }>(
          `/ivr/audio?${query}${query ? '&' : ''}name=${encodeURIComponent(n)}`,
          new File([wav], `${n}.wav`, { type: 'audio/wav' }),
        );
        notifications.show({ color: 'green', message: t.tts.saved });
        void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/ivr/') });
        onCreated(r.id);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const off = s.data?.provider === 'off';
  return (
    <Modal opened onClose={onClose} title={t.tts.title} size="lg">
      <Stack gap="sm">
        {off ? (
          <Alert color="orange" data-testid="tts-off">
            {t.tts.offHint}
          </Alert>
        ) : (
          <Text size="xs" c="dimmed">
            {s.data?.provider === 'edge' ? t.tts.edgeNote : t.tts.httpNote}
          </Text>
        )}
        <TextInput
          label={t.tts.name}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          withAsterisk
          error={error === t.tts.emptyName}
          data-testid="tts-name"
        />
        <Textarea
          label={t.tts.text}
          description={t.tts.textHint}
          autosize
          minRows={3}
          maxRows={10}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          withAsterisk
          error={error === t.tts.emptyText}
          data-testid="tts-text"
        />
        <Group grow>
          {s.data?.provider === 'edge' && (
            <Select
              label={t.tts.voice}
              data={s.data.edgeVoices}
              value={voice}
              onChange={setVoice}
              allowDeselect={false}
            />
          )}
          <NumberInput
            label={t.tts.rate}
            min={-50}
            max={50}
            suffix=" %"
            value={rate}
            onChange={(v) => setRate(v === '' ? '' : Number(v))}
          />
        </Group>
        {audio && audio.key === key && <audio controls autoPlay src={audio.url} style={{ width: '100%' }} />}
        {error && error !== t.tts.emptyName && error !== t.tts.emptyText && (
          <Alert color="red" data-testid="tts-error">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button
            variant="light"
            onClick={() => void run('listen')}
            loading={busy === 'listen'}
            disabled={off}
            data-testid="tts-listen"
          >
            {t.tts.listen}
          </Button>
          <Button
            onClick={() => void run('save')}
            loading={busy === 'save'}
            disabled={off}
            data-testid="tts-save"
          >
            {t.tts.save}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Настройки синтеза речи: движок, голос, скорость, адрес локального движка. */
export function TtsSettingsCard() {
  const s = useTtsSettings();
  const [v, setV] = useState<Omit<TtsSettings, 'edgeVoices'> | null>(null);
  useEffect(() => {
    if (s.data) {
      setV({
        provider: s.data.provider,
        voice: s.data.voice,
        rate: s.data.rate,
        httpUrl: s.data.httpUrl,
        httpModel: s.data.httpModel,
        httpVoice: s.data.httpVoice,
      });
    }
  }, [s.data]);
  const save = useAction(() => put('/tts/settings', v), t.tts.settingsSaved);
  if (!v) return null;
  return (
    <Paper withBorder p="sm" mb="md" data-testid="tts-settings">
      <Stack gap="xs">
        <Text fw={600} size="sm">
          {t.tts.settingsTitle}
        </Text>
        <Group grow align="flex-start">
          <Select
            label={t.tts.provider}
            data={[
              { value: 'off', label: t.tts.providerOff },
              { value: 'edge', label: t.tts.providerEdge },
              { value: 'http', label: t.tts.providerHttp },
            ]}
            value={v.provider}
            onChange={(x) => x && setV({ ...v, provider: x as TtsSettings['provider'] })}
            allowDeselect={false}
            data-testid="tts-provider"
          />
          {v.provider === 'edge' && (
            <Select
              label={t.tts.voice}
              data={s.data?.edgeVoices ?? []}
              value={v.voice}
              onChange={(x) => x && setV({ ...v, voice: x })}
              allowDeselect={false}
            />
          )}
          <NumberInput
            label={t.tts.rate}
            min={-50}
            max={50}
            suffix=" %"
            value={v.rate}
            onChange={(x) => setV({ ...v, rate: Number(x) || 0 })}
          />
        </Group>
        {v.provider === 'http' && (
          <Group grow>
            <TextInput
              label={t.tts.httpUrl}
              placeholder="http://tts-local:8000/v1/audio/speech"
              value={v.httpUrl ?? ''}
              onChange={(e) => setV({ ...v, httpUrl: e.currentTarget.value || null })}
              withAsterisk
            />
            <TextInput
              label={t.tts.httpModel}
              value={v.httpModel}
              onChange={(e) => setV({ ...v, httpModel: e.currentTarget.value })}
            />
            <TextInput
              label={t.tts.httpVoice}
              value={v.httpVoice}
              onChange={(e) => setV({ ...v, httpVoice: e.currentTarget.value })}
            />
          </Group>
        )}
        <Text size="xs" c={v.provider === 'edge' ? 'orange.8' : 'dimmed'}>
          {v.provider === 'edge' ? t.tts.edgeNote : v.provider === 'http' ? t.tts.httpNote : t.tts.offNote}
        </Text>
        <Group>
          <Button
            size="xs"
            onClick={() => save.mutate(undefined)}
            loading={save.isPending}
            data-testid="tts-settings-save"
          >
            {t.save}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
