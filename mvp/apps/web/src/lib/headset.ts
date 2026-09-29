/**
 * Кнопки гарнитуры через WebHID (M-OP-07, 02-архитектура 8.2): стандартная HID Telephony usage page —
 * Hook Switch (ответ/отбой), Phone Mute; индикаторы LED page — Off-Hook, Ring, Mute. Так работают проводные
 * гарнитуры Jabra и другие модели со стандартной страницей; для остальных — интерфейс и горячие клавиши.
 * Официальный JS SDK Jabra не подключаем: стандартной страницы достаточно, SDK распространяется не по
 * свободной лицензии (M-NFR-10). Разбор дескриптора — чистые функции (unit-тесты).
 */

// Расширенные коды usage в WebHID: страница << 16 | идентификатор.
export const USAGE = {
  hookSwitch: 0x000b0020,
  phoneMute: 0x000b002f,
  ledOffHook: 0x00080017,
  ledRing: 0x00080018,
  ledMute: 0x00080009,
  telephonyRinger: 0x000b009e,
} as const;
export const TELEPHONY_PAGE = 0x0b;

/** Минимальная модель HIDCollectionInfo из WebHID (для разбора и тестов). */
export interface HidReportItem {
  usages?: number[];
  usageMinimum?: number;
  usageMaximum?: number;
  reportSize?: number;
  reportCount?: number;
  isAbsolute?: boolean;
  isConstant?: boolean;
}
export interface HidReport {
  reportId?: number;
  items?: HidReportItem[];
}
export interface HidCollection {
  usagePage?: number;
  usage?: number;
  inputReports?: HidReport[];
  outputReports?: HidReport[];
  children?: HidCollection[];
}

export interface Field {
  reportId: number;
  bitOffset: number;
  bitSize: number;
  absolute: boolean;
}

export interface TelephonyMap {
  hook?: Field;
  mute?: Field;
  out: { offHook?: Field; ring?: Field; mute?: Field };
  /** Размер выходного отчёта (байт, без reportId) — по reportId. */
  outSizes: Record<number, number>;
}

function usagesOf(item: HidReportItem): number[] {
  if (item.usages?.length) return item.usages;
  if (item.usageMinimum !== undefined && item.usageMaximum !== undefined) {
    const r: number[] = [];
    for (let u = item.usageMinimum; u <= item.usageMaximum && r.length < 256; u++) r.push(u);
    return r;
  }
  return [];
}

/** Позиции нужных полей во входных/выходных отчётах устройства. */
export function mapTelephony(collections: HidCollection[]): TelephonyMap {
  const map: TelephonyMap = { out: {}, outSizes: {} };
  const walk = (reports: HidReport[] | undefined, input: boolean) => {
    for (const rep of reports ?? []) {
      const reportId = rep.reportId ?? 0;
      let offset = 0;
      for (const item of rep.items ?? []) {
        const size = item.reportSize ?? 0;
        const count = item.reportCount ?? 0;
        const usages = item.isConstant ? [] : usagesOf(item);
        for (let i = 0; i < count; i++) {
          // Если usage меньше, чем полей, последний usage повторяется (правило HID).
          const usage = usages[Math.min(i, usages.length - 1)];
          const field: Field = {
            reportId,
            bitOffset: offset + i * size,
            bitSize: size,
            absolute: item.isAbsolute ?? true,
          };
          if (usage === undefined) continue;
          if (input) {
            if (usage === USAGE.hookSwitch && !map.hook) map.hook = field;
            if (usage === USAGE.phoneMute && !map.mute) map.mute = field;
          } else {
            if (usage === USAGE.ledOffHook && !map.out.offHook) map.out.offHook = field;
            if ((usage === USAGE.ledRing || usage === USAGE.telephonyRinger) && !map.out.ring)
              map.out.ring = field;
            if (usage === USAGE.ledMute && !map.out.mute) map.out.mute = field;
          }
        }
        offset += size * count;
      }
      if (!input) map.outSizes[reportId] = Math.max(map.outSizes[reportId] ?? 0, Math.ceil(offset / 8));
    }
  };
  const visit = (c: HidCollection) => {
    walk(c.inputReports, true);
    walk(c.outputReports, false);
    c.children?.forEach(visit);
  };
  collections.forEach(visit);
  return map;
}

export function readField(data: DataView, f: Field): number {
  let v = 0;
  for (let b = 0; b < f.bitSize; b++) {
    const bit = f.bitOffset + b;
    const byte = bit >> 3;
    if (byte >= data.byteLength) break;
    if ((data.getUint8(byte) >> (bit & 7)) & 1) v |= 1 << b;
  }
  return v;
}

/** Выходной отчёт индикаторов для reportId: Off-Hook / Ring / Mute. */
export function buildOutput(
  map: TelephonyMap,
  reportId: number,
  state: { offHook: boolean; ring: boolean; mute: boolean },
): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(new ArrayBuffer(map.outSizes[reportId] ?? 1));
  const set = (f: Field | undefined, on: boolean) => {
    if (!f || f.reportId !== reportId || !on) return;
    data[f.bitOffset >> 3]! |= 1 << (f.bitOffset & 7);
  };
  set(map.out.offHook, state.offHook);
  set(map.out.ring, state.ring);
  set(map.out.mute, state.mute);
  return data;
}

export type HeadsetAction = 'answer' | 'hangup' | 'mute';

/**
 * Интерпретация входного отчёта: переход Hook Switch 0→1 — «поднять трубку» (ответ), 1→0 — «положить»
 * (отбой); Phone Mute — нажатие (переход 0→1) переключает микрофон; у абсолютного Mute — смена значения.
 */
export class TelephonyInput {
  private hook = 0;
  private mute = 0;
  constructor(private readonly map: TelephonyMap) {}

  handle(reportId: number, data: DataView): HeadsetAction[] {
    const out: HeadsetAction[] = [];
    const { hook, mute } = this.map;
    if (hook && hook.reportId === reportId) {
      const v = readField(data, hook);
      if (v && !this.hook) out.push('answer');
      if (!v && this.hook) out.push('hangup');
      this.hook = v;
    }
    if (mute && mute.reportId === reportId) {
      const v = readField(data, mute);
      if (v && !this.mute) out.push('mute');
      this.mute = v;
    }
    return out;
  }

  /** Софтфон сам снял/положил трубку — синхронизируем ожидаемое состояние кнопки. */
  syncHook(offHook: boolean): void {
    this.hook = offHook ? 1 : 0;
  }
}

// ---------------------------------------------------------------- подключение устройства (браузер)

interface HidDeviceLike {
  productName: string;
  opened: boolean;
  collections: HidCollection[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: 'inputreport', fn: (e: { reportId: number; data: DataView }) => void): void;
}
interface HidApi {
  getDevices(): Promise<HidDeviceLike[]>;
  requestDevice(o: { filters: { usagePage: number }[] }): Promise<HidDeviceLike[]>;
  addEventListener(type: 'disconnect' | 'connect', fn: (e: { device: HidDeviceLike }) => void): void;
}

const hid = (): HidApi | null =>
  typeof navigator !== 'undefined' && 'hid' in navigator
    ? (navigator as unknown as { hid: HidApi }).hid
    : null;

export const webHidSupported = () => !!hid();

/** Общий интерфейс управления гарнитурой — за ним стандартная страница HID или адаптер производителя. */
export interface HeadsetControl {
  readonly name: string;
  setState(s: { ring: boolean; offHook: boolean; mute: boolean }): void;
  close(): Promise<void>;
}

export class HidHeadset implements HeadsetControl {
  private readonly map: TelephonyMap;
  private readonly input: TelephonyInput;
  private last = '';

  private constructor(
    private readonly device: HidDeviceLike,
    onAction: (a: HeadsetAction) => void,
  ) {
    this.map = mapTelephony(device.collections);
    this.input = new TelephonyInput(this.map);
    device.addEventListener('inputreport', (e) => {
      for (const a of this.input.handle(e.reportId, e.data)) onAction(a);
    });
  }

  get name(): string {
    return this.device.productName;
  }
  get supported(): boolean {
    return !!this.map.hook;
  }

  static async open(device: HidDeviceLike, onAction: (a: HeadsetAction) => void): Promise<HidHeadset> {
    if (!device.opened) await device.open();
    return new HidHeadset(device, onAction);
  }

  setState(s: { ring: boolean; offHook: boolean; mute: boolean }): void {
    const key = `${+s.ring}${+s.offHook}${+s.mute}`;
    if (key === this.last) return;
    this.last = key;
    this.input.syncHook(s.offHook);
    const ids = new Set(
      [this.map.out.offHook, this.map.out.ring, this.map.out.mute].filter(Boolean).map((f) => f!.reportId),
    );
    for (const id of ids)
      void this.device.sendReport(id, buildOutput(this.map, id, s)).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.device.close().catch(() => undefined);
  }
}

/** Ранее разрешённая гарнитура (без повторного выбора) или выбор новой — по действию пользователя. */
export async function connectHeadset(
  onAction: (a: HeadsetAction) => void,
  request: boolean,
): Promise<HidHeadset | null> {
  const api = hid();
  if (!api) return null;
  const known = await api.getDevices();
  const devices =
    known.length || !request ? known : await api.requestDevice({ filters: [{ usagePage: TELEPHONY_PAGE }] });
  for (const d of devices) {
    const h = await HidHeadset.open(d, onAction).catch(() => null);
    if (h?.supported) return h;
  }
  return null;
}

export function onHeadsetDisconnect(fn: () => void): void {
  hid()?.addEventListener('disconnect', () => fn());
}
