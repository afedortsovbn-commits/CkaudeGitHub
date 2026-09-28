import { describe, expect, it } from 'vitest';
import { normalizePhone, userIdOfSip } from './telephony';

describe('normalizePhone', () => {
  it('белорусские форматы → E.164', () => {
    expect(normalizePhone('+375 (29) 123-45-67')).toBe('+375291234567');
    expect(normalizePhone('80291234567')).toBe('+375291234567');
    expect(normalizePhone('8 029 123 45 67')).toBe('+375291234567');
    expect(normalizePhone('291234567')).toBe('+375291234567');
    expect(normalizePhone('375171234567')).toBe('+375171234567');
    expect(normalizePhone('00375291234567')).toBe('+375291234567');
  });
  it('короткие внутренние номера — как есть; мусор — null', () => {
    expect(normalizePhone('1000')).toBe('1000');
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('12345678')).toBeNull();
    expect(normalizePhone('+12')).toBeNull();
  });
  it('иностранный номер с «+» сохраняется', () => {
    expect(normalizePhone('+7 (495) 123-45-67')).toBe('+74951234567');
  });
});

describe('userIdOfSip', () => {
  it('op-<uuid> → uuid, прочее → null', () => {
    expect(userIdOfSip('op-01a0e808-1e07-7645-9aa9-425541aaa7c5')).toBe('01a0e808-1e07-7645-9aa9-425541aaa7c5');
    expect(userIdOfSip('demo-123')).toBeNull();
  });
});
