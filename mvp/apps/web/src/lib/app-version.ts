import { useSyncExternalStore } from 'react';
import { get } from './api';
import { onRealtime } from './realtime';
import { softphone } from './softphone';

declare const __APP_VERSION__: string;

/** Версия загруженной сборки (тег образа web, задаётся при сборке — ops/build-images.sh). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
let current = APP_VERSION;
/** Только для тестов: версия «загруженной» сборки (в тестах сборки нет — 'dev'). */
export function setCurrentVersionForTest(v: string): void {
  current = v;
}

/**
 * Новая версия интерфейса без прерывания работы (Ф11, M-OP-11, 02-архитектура 6.2 п.8).
 * Признак новой версии — `/version.json` отдаёт другую версию (проверка раз в минуту, при возврате на вкладку
 * и сразу по событию `app.version` после обновления web). Тогда показывается баннер «Доступна новая
 * версия»; страница обновляется сама, только если нет звонка и неотправленного черновика (и включён флаг
 * `web.auto_reload`); кнопка «Обновить» во время звонка недоступна. Во время звонка страница не
 * перезагружается никогда — софтфону не нужно переживать перезагрузку.
 */
export interface UpdateInputs {
  current: string;
  latest: string | null;
  inCall: boolean;
  drafts: number;
  autoReload: boolean;
}
export type UpdateDecision =
  | { kind: 'none' }
  | { kind: 'wait_call' }
  | { kind: 'wait_draft' }
  | { kind: 'manual' }
  | { kind: 'reload' };

export function decideUpdate(s: UpdateInputs): UpdateDecision {
  if (!s.latest || s.latest === s.current || s.current === 'dev') return { kind: 'none' };
  if (s.inCall) return { kind: 'wait_call' };
  if (s.drafts > 0) return { kind: 'wait_draft' };
  return s.autoReload ? { kind: 'reload' } : { kind: 'manual' };
}

/** Звонок идёт или вот-вот начнётся (входящий звонит, исходящий соединяется). */
export function softphoneBusy(): boolean {
  const c = softphone.getSnapshot().call;
  return !!c && c.state !== 'ended';
}

// ---- неотправленные черновики (поле ответа и т.п.) ----
const drafts = new Set<string>();
const subs = new Set<() => void>();
const emit = () => {
  refreshSnapshot();
  subs.forEach((f) => f());
};
export function setDraft(key: string, dirty: boolean): void {
  const had = drafts.has(key);
  if (dirty) drafts.add(key);
  else drafts.delete(key);
  if (had !== dirty) emit();
}

// ---- состояние обновления ----
interface UpdateState {
  latest: string | null;
  autoReload: boolean;
  /** Момент автоматического обновления (мс), если оно запланировано. */
  reloadAt: number | null;
}
let state: UpdateState = { latest: null, autoReload: true, reloadAt: null };
const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch };
  emit();
};

async function check(): Promise<void> {
  try {
    const r = await fetch('/version.json', { cache: 'no-store' });
    if (!r.ok) return;
    const v = (await r.json()) as { version?: string };
    if (v.version && v.version !== state.latest) set({ latest: v.version });
  } catch {
    /* сеть или обновление web — проверим позже */
  }
}

async function loadFlags(): Promise<void> {
  try {
    const f = await get<Record<string, boolean>>('/features');
    set({ autoReload: f['web.auto_reload'] !== false });
  } catch {
    /* по умолчанию — включено */
  }
}

function currentDecision(): UpdateDecision {
  return decideUpdate({
    current,
    latest: state.latest,
    inCall: softphoneBusy(),
    drafts: drafts.size,
    autoReload: state.autoReload,
  });
}

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Автообновление с небольшой случайной задержкой (все вкладки не перезагружаются одновременно) и повторной
 * проверкой условий в момент перезагрузки.
 */
function reevaluate(): void {
  const d = currentDecision();
  if (d.kind !== 'reload') {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = undefined;
    if (state.reloadAt !== null) set({ reloadAt: null });
    return;
  }
  if (reloadTimer) return;
  const delay = 5_000 + Math.floor(Math.random() * 15_000);
  // Таймер — до set(): set() оповещает подписчиков, среди которых и reevaluate (иначе — бесконечная рекурсия).
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined;
    if (currentDecision().kind === 'reload') location.reload();
    else reevaluate();
  }, delay);
  set({ reloadAt: Date.now() + delay });
}

let started = false;
/** Запускается один раз после входа сотрудника (Layout). */
export function startUpdateWatcher(): () => void {
  if (started) return () => undefined;
  started = true;
  void check();
  void loadFlags();
  const poll = setInterval(() => void check(), 60_000);
  const flags = setInterval(() => void loadFlags(), 300_000);
  const tick = setInterval(reevaluate, 2_000);
  const onVisible = () => document.visibilityState === 'visible' && void check();
  document.addEventListener('visibilitychange', onVisible);
  const offRt = onRealtime((e) => {
    if (e.type === 'app_version') void check();
  });
  const offSoft = softphone.subscribe(reevaluate);
  subs.add(reevaluate);
  // Модуль старой версии не нашёлся (ресурсы хранятся для текущей и предыдущей версии, но на случай
  // более старой вкладки): проверяем версию — баннер и обновление при первой возможности.
  const onPreloadError = () => void check();
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => {
    started = false;
    clearInterval(poll);
    clearInterval(flags);
    clearInterval(tick);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('vite:preloadError', onPreloadError);
    offRt();
    offSoft();
    subs.delete(reevaluate);
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = undefined;
  };
}

type Snapshot = UpdateState & { decision: UpdateDecision };
let snapshot: Snapshot = { ...state, decision: { kind: 'none' } };
/** Снимок для React меняется, только когда меняется видимое (звонок и черновики влияют на решение). */
function refreshSnapshot(): void {
  const next = { ...state, decision: currentDecision() };
  if (JSON.stringify(next) !== JSON.stringify(snapshot)) snapshot = next;
}
const subscribe = (f: () => void) => {
  subs.add(f);
  const offSoft = softphone.subscribe(() => {
    refreshSnapshot();
    f();
  });
  return () => {
    subs.delete(f);
    offSoft();
  };
};
export function useAppUpdate(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
