import { Alert, Button, Group, Text, Tooltip } from '@mantine/core';
import { useEffect, useState } from 'react';
import { APP_VERSION, startUpdateWatcher, useAppUpdate } from '../lib/app-version';
import { t } from '../lib/i18n';

/** Баннер «Доступна новая версия» (Ф11, M-OP-11): кнопка «Обновить» недоступна во время звонка. */
export function UpdateBanner() {
  useEffect(() => startUpdateWatcher(), []);
  const u = useAppUpdate();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!u.reloadAt) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [u.reloadAt]);
  if (u.decision.kind === 'none') return null;
  const inCall = u.decision.kind === 'wait_call';
  const hint =
    u.decision.kind === 'wait_call'
      ? t.update.waitCall
      : u.decision.kind === 'wait_draft'
        ? t.update.waitDraft
        : u.decision.kind === 'reload' && u.reloadAt
          ? t.updateBannerUi.s(t.update.reloadIn, Math.max(0, Math.ceil((u.reloadAt - now) / 1000)))
          : u.autoReload
            ? t.update.auto
            : t.update.autoOff;
  return (
    <Alert color="blue" mb="sm" data-testid="update-banner" data-latest={u.latest ?? ''}>
      <Group justify="space-between" wrap="nowrap">
        <div>
          <Text fw={600} size="sm">
            {t.update.available} ({APP_VERSION} → {u.latest})
          </Text>
          <Text size="xs" c="dimmed" data-testid="update-hint">
            {hint}
          </Text>
        </div>
        <Tooltip label={t.update.waitCall} disabled={!inCall}>
          <Button size="xs" disabled={inCall} onClick={() => location.reload()} data-testid="update-reload">
            {t.update.reload}
          </Button>
        </Tooltip>
      </Group>
    </Alert>
  );
}
