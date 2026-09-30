import { Code, Image, Stack, Text } from '@mantine/core';
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { t } from '../lib/i18n';

/** QR-код и секрет для приложения-аутентификатора (2FA, M-NFR-03). QR строится в браузере, без сети. */
export function TotpSetup({ secret, url }: { secret: string; url: string }) {
  const src = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createDataURL(5, 4);
  }, [url]);
  return (
    <Stack gap="xs" align="center">
      <Image src={src} w={200} h={200} alt="QR" data-testid="totp-qr" />
      <Text size="sm">{t.mfa.secret}:</Text>
      <Code data-testid="totp-secret">{secret.replace(/(.{4})/g, '$1 ').trim()}</Code>
    </Stack>
  );
}
