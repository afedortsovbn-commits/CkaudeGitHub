import {
  Alert,
  Button,
  Center,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { BrowserWarning } from '../components/BrowserWarning';
import { TotpSetup } from '../components/TotpSetup';
import { errorText } from '../lib/api';
import { type MfaStep, useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

export function LoginPage() {
  const { login, loginTotp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState<MfaStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Center h="100vh" bg="gray.1">
      <Stack w={mfa?.setup ? 460 : 380}>
        <BrowserWarning />
        <Paper
          component="form"
          p="xl"
          shadow="md"
          radius="md"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (mfa) await loginTotp(mfa.mfaToken, code);
              else setMfa(await login(email, password));
            });
          }}
        >
          <Stack>
            <Title order={3}>{mfa?.setup ? t.mfa.setupTitle : t.appName}</Title>
            {error && <Alert color="red">{error}</Alert>}
            {!mfa && (
              <>
                <TextInput
                  label={t.email}
                  name="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  required
                />
                <PasswordInput
                  label={t.password}
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  required
                />
              </>
            )}
            {mfa?.setup && (
              <>
                <Text size="sm">{t.mfa.setupText}</Text>
                <TotpSetup secret={mfa.setup.secret} url={mfa.setup.otpauthUrl} />
              </>
            )}
            {mfa && (
              <TextInput
                label={t.mfa.code}
                name="totp"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
                data-autofocus
                autoFocus
                required
              />
            )}
            <Group grow>
              {mfa && (
                <Button
                  variant="default"
                  onClick={() => {
                    setMfa(null);
                    setCode('');
                  }}
                >
                  {t.mfa.back}
                </Button>
              )}
              <Button type="submit" loading={busy}>
                {mfa ? t.mfa.confirm : t.signIn}
              </Button>
            </Group>
          </Stack>
        </Paper>
      </Stack>
    </Center>
  );
}
