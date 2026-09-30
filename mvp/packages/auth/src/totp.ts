import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Одноразовые коды TOTP (RFC 6238: HMAC-SHA1, шаг 30 с, 6 цифр) — вторая ступень входа администраторов
 * (M-NFR-03). Совместимо с любыми приложениями-аутентификаторами (FreeOTP, Google Authenticator, Яндекс Ключ).
 * Без внешних зависимостей: работает в закрытом контуре.
 */
export const TOTP_STEP_S = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Неверный символ base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Новый секрет (160 бит) в base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Код для шага времени (HOTP, RFC 4226). */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, '0');
}

export const totpStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / TOTP_STEP_S);

export function totp(secretB32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs));
}

/**
 * Проверка кода с допуском ±1 шаг (расхождение часов). Возвращает шаг совпавшего кода — его нужно сохранить,
 * чтобы не принять тот же код повторно (`lastStep`); иначе null.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  opts: { nowMs?: number; lastStep?: number | null; window?: number } = {},
): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const cur = totpStep(opts.nowMs);
  const w = opts.window ?? 1;
  for (let d = -w; d <= w; d++) {
    const step = cur + d;
    if (opts.lastStep !== undefined && opts.lastStep !== null && step <= opts.lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(c))) return step;
  }
  return null;
}

/** Ссылка otpauth:// для QR-кода приложения-аутентификатора. */
export function otpauthUrl(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_S}`;
}
