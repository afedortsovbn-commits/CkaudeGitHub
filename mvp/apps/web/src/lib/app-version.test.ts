import { describe, expect, it, vi } from 'vitest';
import { decideUpdate } from './app-version';

const base = { current: 'v1', latest: 'v2', inCall: false, drafts: 0, autoReload: true };

describe('decideUpdate (M-OP-11)', () => {
  it('нет новой версии или локальная сборка — ничего', () => {
    expect(decideUpdate({ ...base, latest: null }).kind).toBe('none');
    expect(decideUpdate({ ...base, latest: 'v1' }).kind).toBe('none');
    expect(decideUpdate({ ...base, current: 'dev' }).kind).toBe('none');
  });
  it('во время звонка — никогда не перезагружать', () => {
    expect(decideUpdate({ ...base, inCall: true }).kind).toBe('wait_call');
    expect(decideUpdate({ ...base, inCall: true, drafts: 2 }).kind).toBe('wait_call');
  });
  it('неотправленный черновик откладывает автообновление', () => {
    expect(decideUpdate({ ...base, drafts: 1 }).kind).toBe('wait_draft');
  });
  it('нет звонка и черновика — автообновление; флаг выключен — только кнопка', () => {
    expect(decideUpdate(base).kind).toBe('reload');
    expect(decideUpdate({ ...base, autoReload: false }).kind).toBe('manual');
  });
});

describe('наблюдатель новой версии (M-OP-11)', () => {
  it('новая версия → баннер и перезагрузка через 5–20 с; во время звонка и с черновиком — нет', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('version.json')
          ? { ok: true, json: async () => ({ version: 'v2' }) }
          : {
              ok: true,
              status: 200,
              json: async () => ({ 'web.auto_reload': true }),
              text: async () => '{}',
            },
      ),
    );
    const m = await import('./app-version');
    m.setCurrentVersionForTest('v1');
    m.setDraft('reply:1', true);
    const stop = m.startUpdateWatcher();
    await vi.advanceTimersByTimeAsync(3000);
    expect(reload).not.toHaveBeenCalled(); // черновик
    // Задержка автообновления случайна (5–20 с) — в тесте минимальная: 5 с.
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0);
    m.setDraft('reply:1', false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).toHaveBeenCalledTimes(1);
    rnd.mockRestore();
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
