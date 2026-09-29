import { useSyncExternalStore } from 'react';

/**
 * Аудиоустройства оператора (M-OP-06, 02-архитектура 8.2): раздельный выбор микрофона, динамика разговора и
 * устройства для звонка-рингтона, настройки обработки звука, горячее подключение/отключение гарнитур.
 * Выбор хранится по deviceId и названию (deviceId у Bluetooth-гарнитуры может меняться между подключениями).
 */

export type DeviceKind = 'mic' | 'speaker' | 'ringer';

export interface DeviceRef {
  id: string;
  label: string;
}

export interface Processing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export interface AudioDevicesState {
  inputs: DeviceRef[];
  outputs: DeviceRef[];
  /** Предпочтение сотрудника (сохранено). */
  preferred: Partial<Record<DeviceKind, DeviceRef>>;
  /** Фактически используемые устройства (предпочтение, если доступно, иначе системное по умолчанию). */
  effective: Record<DeviceKind, DeviceRef | null>;
  processing: Processing;
  /** Названия устройств видны только после разрешения на микрофон. */
  labelsVisible: boolean;
  /** Выбор устройства вывода (setSinkId) поддерживается браузером. */
  sinkSupported: boolean;
}

export type DeviceNotice =
  | { type: 'fallback'; kind: DeviceKind; lost: DeviceRef; now: DeviceRef | null }
  | { type: 'returned'; kind: DeviceKind; device: DeviceRef };

const STORAGE_KEY = 'cc.audio';
export const DEFAULT_PROCESSING: Processing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Предпочтённое устройство, если оно подключено (по id, затем по названию), иначе системное по умолчанию. */
export function resolveDevice(list: DeviceRef[], preferred: DeviceRef | undefined): DeviceRef | null {
  if (!list.length) return null;
  if (preferred) {
    const byId = list.find((d) => d.id === preferred.id);
    if (byId) return byId;
    const byLabel = preferred.label ? list.find((d) => d.label === preferred.label) : undefined;
    if (byLabel) return byLabel;
  }
  return list.find((d) => d.id === 'default') ?? list[0]!;
}

/**
 * Что сообщить сотруднику после изменения списка устройств: используемое устройство пропало (разрядился
 * Bluetooth) — переключились на другое; предпочтённое снова появилось — вернулись к нему.
 */
export function diffDevices(
  before: Record<DeviceKind, DeviceRef | null>,
  after: Record<DeviceKind, DeviceRef | null>,
  preferred: Partial<Record<DeviceKind, DeviceRef>>,
  available: Record<DeviceKind, DeviceRef[]>,
): DeviceNotice[] {
  const out: DeviceNotice[] = [];
  for (const kind of ['mic', 'speaker', 'ringer'] as DeviceKind[]) {
    const b = before[kind];
    const a = after[kind];
    if (b && !available[kind].some((d) => d.id === b.id))
      out.push({ type: 'fallback', kind, lost: b, now: a });
    else if (
      b &&
      a &&
      b.id !== a.id &&
      preferred[kind] &&
      a.id === resolveDevice(available[kind], preferred[kind])?.id
    )
      out.push({ type: 'returned', kind, device: a });
  }
  return out;
}

function load(): { preferred: Partial<Record<DeviceKind, DeviceRef>>; processing: Processing } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      preferred?: Partial<Record<DeviceKind, DeviceRef>>;
      processing?: Partial<Processing>;
    };
    return { preferred: raw.preferred ?? {}, processing: { ...DEFAULT_PROCESSING, ...raw.processing } };
  } catch {
    return { preferred: {}, processing: DEFAULT_PROCESSING };
  }
}

class AudioDevices {
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(n: DeviceNotice) => void>();
  private started = false;
  private state: AudioDevicesState;

  constructor() {
    const saved =
      typeof localStorage !== 'undefined' ? load() : { preferred: {}, processing: DEFAULT_PROCESSING };
    this.state = {
      inputs: [],
      outputs: [],
      preferred: saved.preferred,
      effective: { mic: null, speaker: null, ringer: null },
      processing: saved.processing,
      labelsVisible: false,
      sinkSupported: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;
  onNotice(fn: (n: DeviceNotice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => void this.noticeListeners.delete(fn);
  }

  private set(patch: Partial<AudioDevicesState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ preferred: this.state.preferred, processing: this.state.processing }),
      );
    } catch {
      /* без сохранения выбор действует до перезагрузки */
    }
  }

  start(): void {
    if (this.started || typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    this.started = true;
    navigator.mediaDevices.addEventListener('devicechange', () => void this.refresh(true));
    void this.refresh(false);
  }

  /** Разрешение на микрофон — чтобы увидеть названия устройств (без него браузер их скрывает). */
  async requestLabels(): Promise<void> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      /* отказ — работаем с устройствами по умолчанию */
    }
    await this.refresh(false);
  }

  async refresh(notify: boolean): Promise<void> {
    const list = await navigator.mediaDevices.enumerateDevices();
    const map = (kind: MediaDeviceKind) =>
      list
        .filter((d) => d.kind === kind && d.deviceId)
        .map((d) => ({
          id: d.deviceId,
          label: d.label || (d.deviceId === 'default' ? 'По умолчанию' : 'Устройство'),
        }));
    const inputs = map('audioinput');
    const outputs = map('audiooutput');
    const available = { mic: inputs, speaker: outputs, ringer: outputs };
    const effective = {
      mic: resolveDevice(inputs, this.state.preferred.mic),
      speaker: resolveDevice(outputs, this.state.preferred.speaker),
      ringer: resolveDevice(outputs, this.state.preferred.ringer),
    };
    const notices = notify
      ? diffDevices(this.state.effective, effective, this.state.preferred, available)
      : [];
    this.set({ inputs, outputs, effective, labelsVisible: list.some((d) => !!d.label) });
    for (const n of notices) this.noticeListeners.forEach((l) => l(n));
  }

  select(kind: DeviceKind, id: string): void {
    const pool = kind === 'mic' ? this.state.inputs : this.state.outputs;
    const d = pool.find((x) => x.id === id);
    if (!d) return;
    this.set({
      preferred: { ...this.state.preferred, [kind]: d },
      effective: { ...this.state.effective, [kind]: d },
    });
    this.save();
  }

  setProcessing(patch: Partial<Processing>): void {
    this.set({ processing: { ...this.state.processing, ...patch } });
    this.save();
  }

  /** Ограничения getUserMedia для микрофона разговора. */
  micConstraints(): MediaTrackConstraints {
    const mic = this.state.effective.mic;
    return {
      ...(mic && mic.id !== 'default' ? { deviceId: { exact: mic.id } } : {}),
      ...this.state.processing,
    };
  }

  sinkId(kind: 'speaker' | 'ringer'): string {
    return this.state.effective[kind]?.id ?? 'default';
  }
}

export const audioDevices = new AudioDevices();

export function useAudioDevices(): AudioDevicesState {
  return useSyncExternalStore(audioDevices.subscribe, audioDevices.getSnapshot);
}

/** Вывести звук элемента на выбранное устройство (если браузер умеет). */
export async function applySink(el: HTMLMediaElement, deviceId: string): Promise<void> {
  const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (!withSink.setSinkId) return;
  try {
    await withSink.setSinkId(deviceId === 'default' ? '' : deviceId);
  } catch {
    /* устройство пропало — останется текущий вывод */
  }
}

/** Тон для звонка и теста динамика: WAV в памяти, без внешних файлов. */
export function toneUrl(pattern: 'ring' | 'test'): string {
  const rate = 16000;
  const seconds = pattern === 'ring' ? 3 : 1.2;
  const n = Math.round(rate * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // Звонок: два тона 425+480 Гц 1 с и пауза 2 с; тест: мягкий аккорд с затуханием.
    const on = pattern === 'ring' ? t < 1 : true;
    const env = pattern === 'ring' ? Math.min(1, t / 0.02, (1 - t) / 0.02) : Math.exp(-t * 2.5);
    const v = on
      ? pattern === 'ring'
        ? Math.sin(2 * Math.PI * 425 * t) * 0.5 + Math.sin(2 * Math.PI * 480 * t) * 0.5
        : Math.sin(2 * Math.PI * 523.25 * t) * 0.5 + Math.sin(2 * Math.PI * 659.25 * t) * 0.35
      : 0;
    pcm[i] = Math.round(v * Math.max(0, env) * 9000);
  }
  const data = new Uint8Array(pcm.buffer);
  const header = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  header.setUint32(4, 36 + data.length, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  str(36, 'data');
  header.setUint32(40, data.length, true);
  return URL.createObjectURL(new Blob([header.buffer, data], { type: 'audio/wav' }));
}
