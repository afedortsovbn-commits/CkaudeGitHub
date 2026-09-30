/**
 * Поддерживаемые браузеры (M-NFR-02): Google Chrome, Яндекс Браузер, Microsoft Edge — все на движке Chromium
 * (WebRTC, WebHID для гарнитур). Firefox и Safari официально не поддерживаются — показываем предупреждение.
 */
export function isSupportedBrowser(ua: string, brands?: { brand: string }[]): boolean {
  if (brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge|Yandex/i.test(b.brand))) return true;
  if (/Firefox\/|FxiOS\//.test(ua)) return false;
  return /(Chrome|Chromium|CriOS|Edg|YaBrowser)\/\d+/.test(ua);
}

export function currentBrowserSupported(): boolean {
  if (typeof navigator === 'undefined') return true;
  const n = navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } };
  return isSupportedBrowser(n.userAgent, n.userAgentData?.brands);
}
