import { Alert, Button, Center, Paper, PasswordInput, Stack, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Center h="100vh" bg="gray.1">
      <Paper
        component="form"
        w={380}
        p="xl"
        shadow="md"
        radius="md"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await login(email, password);
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Stack>
          <Title order={3}>{t.appName}</Title>
          {error && <Alert color="red">{error}</Alert>}
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
          <Button type="submit" loading={busy}>
            {t.signIn}
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
