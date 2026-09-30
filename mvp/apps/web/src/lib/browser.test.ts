import { describe, expect, it } from 'vitest';
import { isSupportedBrowser } from './browser';

describe('поддерживаемые браузеры (M-NFR-02)', () => {
  it('Chrome, Яндекс Браузер, Edge — да', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    expect(isSupportedBrowser(chrome)).toBe(true);
    expect(isSupportedBrowser(`${chrome} YaBrowser/25.8.0.0 Yowser/2.5`)).toBe(true);
    expect(isSupportedBrowser(`${chrome} Edg/140.0.0.0`)).toBe(true);
    expect(isSupportedBrowser('', [{ brand: 'Not.A/Brand' }, { brand: 'Chromium' }])).toBe(true);
  });
  it('Firefox и Safari — нет', () => {
    expect(isSupportedBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe(
      false,
    );
    expect(
      isSupportedBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ),
    ).toBe(false);
  });
});
