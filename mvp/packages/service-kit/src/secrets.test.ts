import { describe, expect, it } from 'vitest';
import { isSealed, openSecret, sealSecret } from './secrets';

describe('секреты интеграций', () => {
  it('шифрование и расшифровка; каждый раз разный шифртекст', () => {
    const a = sealSecret('123456:token', 'key-0123456789abcdef');
    const b = sealSecret('123456:token', 'key-0123456789abcdef');
    expect(isSealed(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('token');
    expect(openSecret(a, 'key-0123456789abcdef')).toBe('123456:token');
  });
  it('незашифрованное значение возвращается как есть; чужой ключ и подмена — ошибка', () => {
    expect(openSecret('plain', 'k'.repeat(16))).toBe('plain');
    const s = sealSecret('пароль', 'key-0123456789abcdef');
    expect(() => openSecret(s, 'other-key-0123456789')).toThrow();
    const raw = Buffer.from(s.slice('enc:v1:'.length), 'base64');
    raw[raw.length - 1]! ^= 1;
    expect(() => openSecret(`enc:v1:${raw.toString('base64')}`, 'key-0123456789abcdef')).toThrow();
  });
});
