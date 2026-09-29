/**
 * Мок внешней системы самообслуживания (M-INT-03, 02-архитектура 2.2 — демо-компонент, требования 6.2 к нему
 * не применяются): бонусный счёт и топливная карта клиента по номеру телефона.
 *   GET /balance?phone=+375…  → {phone, card, balance, currency, level}
 *   GET /history?phone=+375…  → {phone, operations: [{date, station, fuel, liters, amount, bonus}]}
 * Для проверки ветки «ошибка»: номер, оканчивающийся на 0000, — ответ 500; на 9999 — ответ через 10 с.
 * Авторизация: заголовок Authorization: Bearer <MOCK_TOKEN> (если MOCK_TOKEN задан).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.MOCK_TOKEN ?? '';

/** Детерминированные «данные клиента» из цифр номера — одинаковы при каждом запросе. */
function seed(phone: string): number {
  let h = 7;
  for (const ch of phone.replace(/\D/g, '')) h = (h * 31 + Number(ch)) % 1_000_003;
  return h;
}

function balance(phone: string) {
  const s = seed(phone);
  return {
    phone,
    card: `7000 **** **** ${String(s % 10000).padStart(4, '0')}`,
    balance: 100 + (s % 4900),
    currency: 'бонусов',
    level: ['Базовый', 'Серебро', 'Золото'][s % 3],
  };
}

function history(phone: string) {
  const s = seed(phone);
  const stations = ['АЗС № 12, Минск', 'АЗС № 3, Гомель', 'ЭЗС № 7, Брест', 'АЗС № 25, Витебск'];
  const fuels = ['АИ-95', 'ДТ', 'АИ-92', 'Электроэнергия'];
  return {
    phone,
    operations: Array.from({ length: 5 }, (_, i) => {
      const liters = 10 + ((s >> i) % 40);
      return {
        date: new Date(Date.UTC(2026, 8, 28 - i * 3)).toISOString().slice(0, 10),
        station: stations[(s + i) % stations.length],
        fuel: fuels[(s + i) % fuels.length],
        liters,
        amount: Math.round(liters * 2.45 * 100) / 100,
        bonus: liters,
      };
    }),
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  if (url.pathname === '/healthz' || url.pathname === '/readyz') return send(200, { status: 'ok' });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
  const phone = url.searchParams.get('phone') ?? '';
  if (!/^\+?\d{5,15}$/.test(phone)) return send(400, { error: 'phone' });
  if (phone.endsWith('0000')) return send(500, { error: 'внутренняя ошибка системы' });
  const reply = () => {
    if (url.pathname === '/balance') return send(200, balance(phone));
    if (url.pathname === '/history') return send(200, history(phone));
    return send(404, { error: 'not found' });
  };
  if (phone.endsWith('9999')) setTimeout(reply, 10_000);
  else reply();
});
server.listen(PORT, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
