import { Button, Center, Loader, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { api, setAccessToken } from '../lib/api';
import { t } from '../lib/i18n';

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string; ready?(): void; expand?(): void } };
  }
}

/**
 * Мини-приложение Telegram (Д-010): страница открывается из бота для сотрудников, подтверждает подпись
 * `initData` на сервере (POST /auth/telegram), входит под привязанным сотрудником и показывает экран
 * мониторинга; отчёты — в меню системы. Работает только по публичному https-адресу (настройка «Telegram-бот»).
 */
export function TgPage() {
  const [state, setState] = useState<'loading' | 'no-telegram' | 'denied'>('loading');
  useEffect(() => {
    const wa = window.Telegram?.WebApp;
    wa?.ready?.();
    wa?.expand?.();
    const initData =
      wa?.initData ?? new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppData') ?? '';
    if (!initData) return setState('no-telegram');
    api<{ accessToken: string }>('POST', '/auth/telegram', { initData })
      .then((r) => {
        setAccessToken(r.accessToken);
        window.location.replace('/wallboard');
      })
      .catch(() => setState('denied'));
  }, []);
  return (
    <Center mih="100vh" p="md">
      <Stack align="center" gap="sm">
        <Title order={3}>{t.notify.tgAppTitle}</Title>
        {state === 'loading' && (
          <>
            <Loader />
            <Text size="sm">{t.notify.tgAppLoading}</Text>
          </>
        )}
        {state === 'no-telegram' && <Text size="sm">{t.notify.tgAppNoTelegram}</Text>}
        {state === 'denied' && (
          <>
            <Text size="sm" c="red">
              {t.notify.tgAppDenied}
            </Text>
            <Button size="xs" variant="light" onClick={() => window.location.reload()}>
              {t.notify.tgAppRetry}
            </Button>
          </>
        )}
      </Stack>
    </Center>
  );
}
