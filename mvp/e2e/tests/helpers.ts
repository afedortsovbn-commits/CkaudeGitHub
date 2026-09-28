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
