import { Badge, Button, Group, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { TotpSetup } from '../components/TotpSetup';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/data';
import { t } from '../lib/i18n';

interface TotpStatus {
  enabled: boolean;
  enabledAt: string | null;
  required: boolean;
}

/** Профиль сотрудника: вход с кодом (2FA, M-NFR-03) и смена пароля. */
export function ProfilePage() {
  const { me } = useAuth();
  const st = useQuery({ queryKey: ['/auth/totp'], queryFn: () => get<TotpStatus>('/auth/totp') });
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '' });
  const begin = useAction(
    () => post<{ secret: string; otpauthUrl: string }>('/auth/totp/setup').then(setSetup),
    t.profilePage.otskaniruyteQrKodI,
  );
  const enable = useAction(
    () => post('/auth/totp/enable', { code }).then(() => (setSetup(null), setCode(''))),
    t.mfa.enabled,
  );
  const disable = useAction(
    () => post('/auth/totp/disable', { code }).then(() => setCode('')),
    t.mfa.disabled,
  );
  const change = useAction(
    () => post('/auth/change-password', pwd).then(() => setPwd({ currentPassword: '', newPassword: '' })),
    t.profile.passwordChanged,
  );
  const s = st.data;
  return (
    <Stack maw={520}>
      <Title order={3}>{t.profile.title}</Title>
      <Text>
        {me?.fullName} · {me?.email}
      </Text>
      <Paper withBorder p="md">
        <Stack>
          <Group>
            <Title order={5}>{t.profilePage.vkhodSKodomDvukhfaktornaya}</Title>
            {s && (
              <Badge color={s.enabled ? 'green' : 'gray'} data-testid="totp-status">
                {s.enabled ? t.mfa.enabled : t.mfa.disabled}
              </Badge>
            )}
            {s?.required && <Badge color="orange">{t.mfa.required}</Badge>}
          </Group>
          {setup && <TotpSetup secret={setup.secret} url={setup.otpauthUrl} />}
          {(setup || s?.enabled) && (
            <TextInput
              label={t.mfa.code}
              inputMode="numeric"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              data-testid="totp-code"
            />
          )}
          <Group>
            {setup ? (
              <Button onClick={() => enable.mutate(undefined)} loading={enable.isPending}>
                {t.mfa.confirm}
              </Button>
            ) : (
              <Button variant="light" onClick={() => begin.mutate(undefined)} data-testid="totp-begin">
                {s?.enabled ? t.profilePage.perenastroitNovyyTelefon : t.mfa.enable}
              </Button>
            )}
            {s?.enabled && !s.required && !setup && (
              <Button color="red" variant="outline" onClick={() => disable.mutate(undefined)}>
                {t.mfa.disable}
              </Button>
            )}
          </Group>
        </Stack>
      </Paper>
      <Paper withBorder p="md">
        <Stack>
          <Title order={5}>{t.profile.changePassword}</Title>
          <PasswordInput
            label={t.profile.currentPassword}
            value={pwd.currentPassword}
            onChange={(e) => setPwd({ ...pwd, currentPassword: e.currentTarget.value })}
          />
          <PasswordInput
            label={t.profile.newPassword}
            value={pwd.newPassword}
            onChange={(e) => setPwd({ ...pwd, newPassword: e.currentTarget.value })}
          />
          <Button
            onClick={() => change.mutate(undefined)}
            disabled={!pwd.currentPassword || pwd.newPassword.length < 8}
          >
            {t.profile.changePassword}
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
