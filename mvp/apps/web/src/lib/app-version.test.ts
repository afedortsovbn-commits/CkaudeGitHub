import { describe, expect, it } from 'vitest';
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
