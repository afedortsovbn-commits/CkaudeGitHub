import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getAccessToken, refreshSession } from './api';

export interface RtEvent {
  type: 'event' | 'typing' | 'hello' | 'ticket';
  event?: string;
  data?: Record<string, unknown> & {
    conversationId?: string;
    message?: Record<string, unknown>;
    assigneeId?: string | null;
    status?: string;
  };
  from?: string;
  contactId?: string;
}

type Listener = (e: RtEvent) => void;
const listeners = new Set<Listener>();
export const onRealtime = (l: Listener) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Одно общее соединение на вкладку: им пользуются рабочее место, колокольчик и другие разделы. */
const shared = {
  users: 0,
  ws: null as WebSocket | null,
  connected: false,
  stopped: true,
  retry: 0,
  first: true,
  qc: null as QueryClient | null,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  subs: new Set<() => void>(),
};
const setConnected = (v: boolean) => {
  shared.connected = v;
  shared.subs.forEach((f) => f());
};

async function connect(): Promise<void> {
  if (shared.stopped) return;
  if (!getAccessToken() || shared.retry > 0) await refreshSession();
  if (shared.stopped) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?token=${encodeURIComponent(getAccessToken() ?? '')}`,
  );
  shared.ws = ws;
  ws.onopen = () => {
    shared.retry = 0;
    setConnected(true);
    if (!shared.first) void shared.qc?.invalidateQueries();
    shared.first = false;
  };
  ws.onmessage = (e) => {
    const d = JSON.parse(String(e.data)) as RtEvent;
    listeners.forEach((l) => l(d));
  };
  ws.onclose = () => {
    setConnected(false);
    if (shared.stopped) return;
    shared.timer = setTimeout(() => void connect(), Math.min(500 * 2 ** shared.retry++, 10_000));
  };
}

/**
 * Подключение к realtime с переподключением. После переподключения (в т.ч. при обновлении сервиса — код 1012)
 * все данные перечитываются из API: источник истины — БД, пропущенные события не теряются.
 */
export function useRealtime(enabled: boolean): { connected: boolean; send(m: unknown): void } {
  const qc = useQueryClient();
  const [connected, setLocal] = useState(shared.connected);
  useEffect(() => {
    const sync = () => setLocal(shared.connected);
    shared.subs.add(sync);
    sync();
    return () => void shared.subs.delete(sync);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    shared.qc = qc;
    if (++shared.users === 1) {
      shared.stopped = false;
      shared.retry = 0;
      shared.first = true;
      void connect();
    }
    return () => {
      if (--shared.users === 0) {
        shared.stopped = true;
        clearTimeout(shared.timer);
        shared.ws?.close();
        shared.ws = null;
        setConnected(false);
      }
    };
  }, [enabled, qc]);
  return {
    connected,
    send: (m) => {
      if (shared.ws?.readyState === WebSocket.OPEN) shared.ws.send(JSON.stringify(m));
    },
  };
}

/** Звук, мигание заголовка вкладки и системное уведомление о новом сообщении/обращении (M-OP-09). */
export function notify(title: string, body: string): void {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  } catch {
    /* звук недоступен до первого действия пользователя */
  }
  if (document.hidden) {
    const orig = document.title;
    let n = 0;
    const t = setInterval(() => {
      document.title = n++ % 2 ? orig : `● ${title}`;
      if (!document.hidden || n > 20) {
        clearInterval(t);
        document.title = orig;
      }
    }, 800);
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
  }
}
