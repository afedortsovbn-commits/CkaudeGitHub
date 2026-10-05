import { Alert, Anchor, Center, Loader, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

/**
 * Демо-стенд: вход в один клик под демо-учёткой (ссылка «Войти» на странице ссылок стенда). Текущий вход в этом
 * адресе заменяется новым; после входа — стартовая страница роли.
 */
export function DemoLoginPage() {
  const { loginDemo, loading } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const email = new URLSearchParams(window.location.search).get('as') ?? '';

  useEffect(() => {
    // Сначала дождаться восстановления прежней сессии: иначе её ответ может перезаписать cookie нового входа.
    if (loading || started.current) return;
    started.current = true;
    if (!email) {
      setError(t.demoLogin.noUser);
      return;
    }
    void loginDemo(email)
      .then((mfa) => {
        // Нужен код второй ступени — обычная страница входа.
        if (mfa) setError(t.demoLogin.needCode);
        else window.location.replace('/');
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [loading]);

  return (
    <Center h="100vh">
      {error ? (
        <Stack maw={420}>
          <Alert color="red" title={t.demoLogin.failed}>
            {error}
          </Alert>
          <Anchor href="/">{t.demoLogin.manual}</Anchor>
        </Stack>
      ) : (
        <Stack align="center">
          <Loader />
          <Text c="dimmed">{t.demoLogin.signingIn(email)}</Text>
        </Stack>
      )}
    </Center>
  );
}
