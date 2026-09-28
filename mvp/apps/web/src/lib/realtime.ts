import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getAccessToken, refreshSession } from './api';

export interface RtEvent {
  type: 'event' | 'typing' | 'hello';
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

/**
 * Подключение к realtime с переподключением. После переподключения (в т.ч. при обновлении сервиса — код 1012)
 * все данные перечитываются из API: источник истины — БД, пропущенные события не теряются.
 */
export function useRealtime(enabled: boolean): { connected: boolean; send(m: unknown): void } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let retry = 0;
    let first = true;
    const connect = async () => {
      if (!getAccessToken() || retry > 0) await refreshSession();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${location.host}/ws?token=${encodeURIComponent(getAccessToken() ?? '')}`,
      );
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        if (!first) void qc.invalidateQueries();
        first = false;
      };
      ws.onmessage = (e) => {
        const d = JSON.parse(String(e.data)) as RtEvent;
        listeners.forEach((l) => l(d));
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        setTimeout(() => void connect(), Math.min(500 * 2 ** retry++, 10_000));
      };
    };
    void connect();
    return () => {
      stopped = true;
      wsRef.current?.close();
    };
  }, [enabled, qc]);
  return {
    connected,
    send: (m) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(m));
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
