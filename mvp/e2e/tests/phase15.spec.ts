import { expect, test } from '@playwright/test';
import { ADMIN, login, nav } from './helpers';

/**
 * Ф15 (доработки заказчика, п.1): роли и права. Администратор создаёт роль с отдельными правами и своим
 * интерфейсом (меню, стартовая страница); сотрудник с этой ролью видит только свои разделы, api не пускает в чужие;
 * роль, назначенную сотруднику, удалить нельзя; системную роль удалить нельзя.
 */
test.describe.serial('Ф15: роли и права', () => {
  const stamp = Date.now().toString(36);
  const email = `kb-editor-${stamp}@demo.local`;
  const password = 'Editor12345!';
  let token = '';
  let roleCode = '';

  test('администратор создаёт роль «Редактор базы знаний» и сотрудника с ней', async ({ request }) => {
    const r = await request.post('/api/v1/auth/login', { data: ADMIN });
    token = (await r.json()).accessToken;
    const auth = { authorization: `Bearer ${token}` };

    const catalog = await (await request.get('/api/v1/roles/catalog', { headers: auth })).json();
    expect(
      catalog.groups.flatMap((g: { permissions: { code: string }[] }) => g.permissions.map((p) => p.code)),
    ).toContain('kb.manage');

    const role = await request.post('/api/v1/roles', {
      headers: auth,
      data: {
        name: `Редактор базы знаний ${stamp}`,
        permissions: ['kb.manage', 'templates.manage'],
        ui: {
          v: 1,
          home: '/kb',
          menu: [
            { to: '/kb', visible: true },
            { to: '/templates', visible: true },
            { to: '/', visible: false },
          ],
        },
      },
    });
    expect(role.status()).toBe(201);
    roleCode = (await role.json()).code;

    const user = await request.post('/api/v1/users', {
      headers: auth,
      data: { fullName: `Редактор ${stamp}`, email, password, roles: [roleCode] },
    });
    expect(user.ok()).toBeTruthy();
  });

  test('сотрудник видит только свои разделы в заданном порядке и попадает на стартовую страницу', async ({
    page,
    request,
  }) => {
    await login(page, email, password);
    await expect(page).toHaveURL(/\/kb$/);
    const menu = page.getByRole('navigation').getByRole('link');
    await expect(menu).toHaveText([/База знаний/, /Шаблоны ответов/]);
    // Права, а не меню, решают доступ: в каналы api не пускает.
    const own = await request.post('/api/v1/auth/login', { data: { email, password } });
    const auth = { authorization: `Bearer ${(await own.json()).accessToken}` };
    expect((await request.get('/api/v1/kb/articles', { headers: auth })).status()).toBe(200);
    expect(
      (
        await request.get('/api/v1/channels/00000000-0000-0000-0000-000000000000/log', { headers: auth })
      ).status(),
    ).toBe(403);
    expect((await request.get('/api/v1/roles', { headers: auth })).status()).toBe(403);
  });

  test('роль, назначенную сотруднику, и системную роль удалить нельзя; администратор видит роль на странице', async ({
    page,
    request,
  }) => {
    const auth = { authorization: `Bearer ${token}` };
    expect((await request.delete(`/api/v1/roles/${roleCode}`, { headers: auth })).status()).toBe(409);
    expect((await request.delete('/api/v1/roles/operator', { headers: auth })).status()).toBe(400);
    // У «Администратора» нельзя снять управление сотрудниками.
    const admin = (await (await request.get('/api/v1/roles', { headers: auth })).json()).find(
      (r: { code: string }) => r.code === 'admin',
    );
    const cut = await request.put('/api/v1/roles/admin', {
      headers: auth,
      data: { name: admin.name, permissions: admin.permissions.filter((p: string) => p !== 'admin.users') },
    });
    expect(cut.status()).toBe(400);

    await login(page, ADMIN.email, ADMIN.password);
    await nav(page, 'Роли и права');
    await page.getByTestId(`role-item-${roleCode}`).click();
    await expect(page.getByTestId('perm-kb.manage')).toBeChecked();
    await expect(page.getByTestId('perm-channels.manage')).not.toBeChecked();
    await page.getByTestId('role-tab-ui').click();
    await expect(page.getByTestId('ui-preview')).toContainText('База знаний');
  });
});
