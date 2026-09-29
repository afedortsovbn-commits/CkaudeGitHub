/**
 * Озвучивание чисел из заранее записанных фрагментов (M-IVR-02, [УПР] — без синтеза речи, В-15).
 * Число раскладывается на ключи фрагментов аудиобиблиотеки: «2345» → двe тысячи триста сорок пять =
 * ['2f', 'thousand_few', '300', '40', '5']. Род учитывается для 1 и 2 («одна тысяча», «две копейки»).
 */

export type Plural = 'one' | 'few' | 'many';
export type Gender = 'm' | 'f';

/** Все ключи фрагментов с подписями — для загрузки в аудиобиблиотеку. */
export const NUMBER_FRAGMENTS: { key: string; label: string }[] = [
  { key: 'minus', label: 'минус' },
  ...[
    'ноль',
    'один',
    'два',
    'три',
    'четыре',
    'пять',
    'шесть',
    'семь',
    'восемь',
    'девять',
    'десять',
    'одиннадцать',
    'двенадцать',
    'тринадцать',
    'четырнадцать',
    'пятнадцать',
    'шестнадцать',
    'семнадцать',
    'восемнадцать',
    'девятнадцать',
  ].map((label, i) => ({ key: String(i), label })),
  { key: '1f', label: 'одна' },
  { key: '2f', label: 'две' },
  ...[
    'двадцать',
    'тридцать',
    'сорок',
    'пятьдесят',
    'шестьдесят',
    'семьдесят',
    'восемьдесят',
    'девяносто',
  ].map((label, i) => ({ key: String((i + 2) * 10), label })),
  ...['сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'].map(
    (label, i) => ({ key: String((i + 1) * 100), label }),
  ),
  { key: 'thousand_one', label: 'тысяча' },
  { key: 'thousand_few', label: 'тысячи' },
  { key: 'thousand_many', label: 'тысяч' },
  { key: 'million_one', label: 'миллион' },
  { key: 'million_few', label: 'миллиона' },
  { key: 'million_many', label: 'миллионов' },
];

/** Форма существительного после числа: 1 рубль, 2 рубля, 5 рублей (11–14 — «многие»). */
export function plural(n: number): Plural {
  const a = Math.abs(Math.trunc(n));
  const t = a % 100;
  if (t >= 11 && t <= 14) return 'many';
  const u = a % 10;
  if (u === 1) return 'one';
  if (u >= 2 && u <= 4) return 'few';
  return 'many';
}

function unitKey(u: number, g: Gender): string {
  return g === 'f' && (u === 1 || u === 2) ? `${u}f` : String(u);
}

/** Сотни, десятки, единицы (0 < n < 1000). */
function triad(n: number, g: Gender): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) out.push(String(h * 100));
  if (r >= 20) {
    out.push(String(Math.floor(r / 10) * 10));
    if (r % 10) out.push(unitKey(r % 10, g));
  } else if (r > 0) out.push(unitKey(r, g));
  return out;
}

/** Целое число (|n| < 10⁹) → ключи фрагментов. */
export function numberKeys(n: number, g: Gender = 'm'): string[] {
  let v = Math.trunc(n);
  if (!Number.isFinite(v) || Math.abs(v) >= 1e9) return [];
  const out: string[] = [];
  if (v < 0) {
    out.push('minus');
    v = -v;
  }
  if (v === 0) return [...out, '0'];
  const mil = Math.floor(v / 1e6);
  const th = Math.floor((v % 1e6) / 1e3);
  const rest = v % 1e3;
  if (mil) out.push(...triad(mil, 'm'), `million_${plural(mil)}`);
  if (th) out.push(...triad(th, 'f'), `thousand_${plural(th)}`);
  if (rest) out.push(...triad(rest, g));
  return out;
}

/**
 * Значение переменной («1234,5», «-12», «45.07») → целая и дробная (2 знака) части.
 * null — значение не число.
 */
export function parseAmount(value: string): { int: number; frac: number; negative: boolean } | null {
  const s = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const frac = f ? Math.round(Number(`0.${f}`) * 100) : 0;
  return { int: Number(i), frac: Math.min(frac, 99), negative };
}
