import { Group, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useSoftphone } from '../lib/softphone';
import { t } from '../lib/i18n';

/** Сколько ждать перед показом: при входе и коротких переподключениях сообщение не мелькает. */
const GRACE_MS = 5000;

/** true — если условие держится дольше GRACE_MS. */
function useLasting(bad: boolean): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!bad) {
      setLong(false);
      return;
    }
    const id = setTimeout(() => setLong(true), GRACE_MS);
    return () => clearTimeout(id);
  }, [bad]);
  return long;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/**
 * Проблемы связи — мерцающим сообщением по центру шапки: нет сети, нет связи с сервером (мгновенные обновления),
 * телефон не подключён. Пока всё в порядке — ничего не показывается.
 */
export function ConnectionAlert({ connected, phone }: { connected: boolean; phone: boolean }) {
  const online = useOnline();
  const sp = useSoftphone();
  const net = useLasting(!online);
  const server = useLasting(online && !connected);
  const tel = useLasting(phone && sp.reg === 'error');
  const problem = net
    ? { text: t.layout.connOffline, hint: t.layout.connOfflineHint }
    : server
      ? { text: t.layout.connServer, hint: t.layout.connServerHint }
      : tel
        ? { text: t.layout.connPhone, hint: sp.error ?? t.layout.connPhoneHint }
        : null;
  return (
    <>
      {/* Состояние связи для проверок и экранного диктора. */}
      <VisuallyHidden data-testid="rt-status">
        {connected ? t.workspace.onlayn : t.workspace.netSvyazi}
      </VisuallyHidden>
      {problem && (
        <Tooltip label={problem.hint} multiline w={320} withArrow position="bottom">
          <Group
            gap={6}
            wrap="nowrap"
            px="md"
            py={6}
            className="cc-alert-flash"
            data-testid="connection-alert"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              borderRadius: 999,
              maxWidth: '44vw',
              zIndex: 5,
              cursor: 'default',
            }}
          >
            <IconAlertTriangle size={18} style={{ flex: 'none' }} />
            <Text size="sm" fw={700} truncate>
              {problem.text}
            </Text>
          </Group>
        </Tooltip>
      )}
    </>
  );
}
