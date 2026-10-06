/**
 * Значок вкладки браузера по роли сотрудника: с несколькими открытыми вкладками (оператор, 2-я линия,
 * администратор) видно, какая где. Роль выбирается по старшинству; неизвестная роль — значок оператора.
 */
const ICONS: Record<string, { color: string; body: string }> = {
  // Гарнитура — оператор (как в index.html).
  operator: {
    color: '#1c7ed6',
    body:
      "<path d='M9 18v-3a7 7 0 0 1 14 0v3' fill='none' stroke='white' stroke-width='2.4' stroke-linecap='round'/>" +
      "<rect x='7' y='17' width='5' height='7' rx='2' fill='white'/><rect x='20' y='17' width='5' height='7' rx='2' fill='white'/>",
  },
  // Входящие (лоток) — 2-я линия: ответственный и куратор.
  responsible: {
    color: '#7048e8',
    body:
      "<path d='M7 17l3-8h12l3 8v6H7z' fill='none' stroke='white' stroke-width='2.2' stroke-linejoin='round'/>" +
      "<path d='M7 17h5l1.5 2.5h5L20 17h5' fill='none' stroke='white' stroke-width='2.2' stroke-linejoin='round'/>",
  },
  // Столбики — супервизор.
  supervisor: {
    color: '#f08c00',
    body:
      "<rect x='8' y='16' width='4' height='8' rx='1' fill='white'/><rect x='14' y='10' width='4' height='14' rx='1' fill='white'/>" +
      "<rect x='20' y='13' width='4' height='11' rx='1' fill='white'/>",
  },
  // Ползунки настроек — администратор.
  admin: {
    color: '#495057',
    body:
      "<path d='M8 11h16M8 16h16M8 21h16' stroke='white' stroke-width='2' stroke-linecap='round'/>" +
      "<circle cx='12' cy='11' r='2.6' fill='white'/><circle cx='20' cy='16' r='2.6' fill='white'/><circle cx='14' cy='21' r='2.6' fill='white'/>",
  },
};

/** Старшинство: при нескольких ролях значок — по самой «широкой». */
const ORDER = ['admin', 'supervisor', 'responsible', 'curator', 'operator'];

export function roleIconKey(roles: string[]): string {
  const r = ORDER.find((x) => roles.includes(x)) ?? 'operator';
  return r === 'curator' ? 'responsible' : r;
}

export function roleFaviconUrl(roles: string[]): string {
  const i = ICONS[roleIconKey(roles)]!;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='${i.color}'/>${i.body}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Подменяет значок вкладки (link rel=icon) под роль. */
export function applyRoleFavicon(roles: string[]): void {
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = roleFaviconUrl(roles);
}
