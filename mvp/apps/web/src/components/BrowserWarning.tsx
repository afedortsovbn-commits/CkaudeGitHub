import { Alert } from '@mantine/core';
import { currentBrowserSupported } from '../lib/browser';
import { t } from '../lib/i18n';

/** Предупреждение в неподдерживаемом браузере (M-NFR-02); работу не блокирует. */
export function BrowserWarning() {
  if (currentBrowserSupported()) return null;
  return (
    <Alert color="orange" data-testid="browser-warning">
      {t.browser.unsupported}
    </Alert>
  );
}
