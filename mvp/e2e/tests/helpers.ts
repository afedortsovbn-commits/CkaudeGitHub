import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

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
  await page.getByRole('navigation').getByRole('link', { name }).click();
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
