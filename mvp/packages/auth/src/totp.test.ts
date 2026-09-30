import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUrl, totp, verifyTotp } from './totp';

// Эталонный секрет RFC 6238 (SHA1): «12345678901234567890».
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('base32 туда и обратно', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });
  it('HOTP — векторы RFC 4226', () => {
    const k = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 9].map((c) => hotp(k, c))).toEqual(['755224', '287082', '359152', '520489']);
  });
  it('TOTP — векторы RFC 6238 (последние 6 цифр)', () => {
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
    expect(totp(RFC_SECRET, 1111111109_000)).toBe('081804');
    expect(totp(RFC_SECRET, 1234567890_000)).toBe('005924');
    expect(totp(RFC_SECRET, 2000000000_000)).toBe('279037');
  });
  it('проверка: допуск ±1 шаг, чужой и повторный код отклоняются', () => {
    const now = 1234567890_000;
    const code = totp(RFC_SECRET, now);
    const step = verifyTotp(RFC_SECRET, code, { nowMs: now });
    expect(step).toBe(Math.floor(1234567890 / 30));
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now + 30_000 })).toBe(step);
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now + 90_000 })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '000000', { nowMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abc', { nowMs: now })).toBeNull();
    // Тот же код второй раз (защита от повтора).
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, lastStep: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, code.slice(0, 3) + ' ' + code.slice(3), { nowMs: now })).toBe(step);
  });
  it('otpauth-ссылка для приложения-аутентификатора', () => {
    expect(otpauthUrl('ABC', 'admin@x.by', 'Контакт-центр')).toBe(
      'otpauth://totp/%D0%9A%D0%BE%D0%BD%D1%82%D0%B0%D0%BA%D1%82-%D1%86%D0%B5%D0%BD%D1%82%D1%80%3Aadmin%40x.by?secret=ABC&issuer=%D0%9A%D0%BE%D0%BD%D1%82%D0%B0%D0%BA%D1%82-%D1%86%D0%B5%D0%BD%D1%82%D1%80&algorithm=SHA1&digits=6&period=30',
    );
  });
});
