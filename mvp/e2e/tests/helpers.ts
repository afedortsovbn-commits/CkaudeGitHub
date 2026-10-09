import { createHmac } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';

export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@cc.local',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'Admin12345!',
};
export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? 'Demo12345!';

export async function login(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByTestId('current-user')).toBeVisible();
}

export async function nav(page: Page, name: string) {
  const menu = page.getByRole('navigation');
  const link = menu.getByRole('link', { name, exact: true });
  // Ф16: разделы сгруппированы, свёрнутые группы прячут пункты — раскрыть группы, если пункт не виден.
  const closed = menu.locator('[data-testid^="nav-group-"]:not([data-expanded])');
  // Меню может перестроиться (например, после входа — переход на стартовую страницу с узким меню): короткие
  // попытки и повторная проверка, а не ожидание исчезнувшей группы.
  for (let i = 0; i < 10; i++) {
    if (await link.first().isVisible()) break;
    if (!(await closed.count())) break;
    await closed
      .first()
      .click({ timeout: 2000 })
      .catch(() => undefined);
  }
  await link.click();
}

/**
 * Выбор в двухуровневом справочнике (TreePicker: темы/подтемы, предприятия/подразделения): открыть поле,
 * найти по словам (раскрывает найденное), выбрать строку.
 */
export async function tree(
  page: Page,
  testId: string,
  search: string,
  option: string,
  scope: Locator = page.locator('body'),
) {
  await scope.getByTestId(testId).click();
  await page.getByTestId(`${testId}-search`).fill(search);
  await page.getByRole('option', { name: option, exact: true }).first().click();
}

/** Выбор значения в Select/MultiSelect Mantine по подписи поля. */
export async function pick(
  page: Page,
  label: string,
  option: string,
  scope = page.getByRole('dialog'),
  exact = true,
) {
  await scope.getByRole('textbox', { name: label }).click();
  await page.getByRole('option', { name: option, exact }).first().click();
}

/** Код TOTP (RFC 6238, SHA1, 30 с, 6 цифр) для входа со второй ступенью в e2e; shift — смещение в шагах. */
export function totpCode(secretB32: string, shift = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32.replace(/\s/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + shift));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Статус оператора (меню в шапке): «В работе», «Перерыв» (первая причина), «Завершить смену». */
export async function setAgentStatus(page: Page, status: 'ready' | 'break' | 'offline') {
  const btn = page.getByTestId('agent-status');
  await expect(btn).toHaveAttribute('data-status', /.+/);
  if (status !== 'break' && (await btn.getAttribute('data-status')) === status) return;
  await btn.click();
  await page.getByTestId(status === 'break' ? 'agent-status-break-0' : `agent-status-${status}`).click();
}

/** Вид списка обращений на рабочем месте оператора: «Очередь» — отдельная кнопка, остальное — выпадающий список. */
export async function listView(page: Page, view: string) {
  // В режиме обработки обращения список скрыт — показать его. Режим может включиться в этот момент (обращение
  // только что взято в работу): тогда список пропадёт вместе с меню — показать его снова и повторить.
  const show = page.locator('[data-testid="focus-toggle-list"][data-focus]');
  const visible = (l: Locator) =>
    l
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
  for (let i = 0; i < 4; i++) {
    if (await show.isVisible()) await show.click();
    if (view === 'queue') {
      if (await visible(page.getByTestId('queue-open'))) {
        await page
          .getByTestId('queue-open')
          .click({ timeout: 3000 })
          .catch(() => undefined);
        if (await page.getByTestId('conv-list-panel').isVisible()) return;
      }
      continue;
    }
    if (!(await visible(page.getByTestId('list-view')))) continue;
    await page
      .getByTestId('list-view')
      .click({ timeout: 3000 })
      .catch(() => undefined);
    const item = page.getByTestId(`view-${view}`);
    if (await visible(item)) {
      const ok = await item
        .click({ timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (ok && (await page.getByTestId('conv-list-panel').isVisible())) return;
    }
  }
  throw new Error(`Не удалось открыть вид списка «${view}»`);
}
