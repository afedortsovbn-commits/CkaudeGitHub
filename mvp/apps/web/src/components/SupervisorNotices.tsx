import { notifications } from '@mantine/notifications';
import { useEffect } from 'react';
import { onRealtime } from '../lib/realtime';
import { t } from '../lib/i18n';

/**
 * Уведомления оператору о действиях супервизора (Ф14): подсказка в чате (скрытое сообщение — только назначенному
 * оператору и супервизорам) и перехват обращения. Всплывают в любом разделе; при свёрнутой вкладке — ещё и системным
 * уведомлением браузера.
 */
export function SupervisorNotices({ userId }: { userId: string }) {
  useEffect(
    () =>
      onRealtime((ev) => {
        if (ev.type !== 'event' || !ev.data) return;
        const d = ev.data;
        let title = '';
        let message = '';
        let color = 'grape';
        const m = d.message as { body?: string; meta?: { hint?: boolean } } | undefined;
        if (ev.event === 'conversation.message_created' && m?.meta?.hint && d.assigneeId === userId) {
          title = t.supervisorNotices.podskazka;
          message = String(m.body ?? '');
        } else if (
          ev.event === 'conversation.updated' &&
          d.action === 'transferred' &&
          d.takeover &&
          d.fromUserId === userId
        ) {
          title = t.supervisorNotices.perekhvacheno;
          message = d.channelKind === 'voice' ? t.supervisorNotices.zvonok : t.supervisorNotices.dialog;
          color = 'orange';
        } else return;
        notifications.show({
          title,
          message,
          color,
          autoClose: 10_000,
          'data-testid': 'supervisor-notice',
        } as never);
        if (
          document.visibilityState !== 'visible' &&
          'Notification' in window &&
          Notification.permission === 'granted'
        )
          new Notification(title, { body: message });
      }),
    [userId],
  );
  return null;
}
