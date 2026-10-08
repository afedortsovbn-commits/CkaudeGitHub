import { describe, expect, it } from 'vitest';
import { addDiskPoint, diskDaysLeft, evaluateResources, resourceAlerts, resourceMessage } from './resources';

const th = { warnPct: 80, critPct: 90 };
const GB = 1024 ** 3;
const db = { connections: 20, maxConnections: 100, outboxOldestS: null, emailStuck: 0 };

describe('контроль ресурсов', () => {
  it('уровни по порогам: диск, память, подключения, очереди', () => {
    const s = evaluateResources(
      {
        disk: { totalBytes: 100 * GB, freeBytes: 5 * GB },
        memory: { totalBytes: 8 * GB, availableBytes: 1.2 * GB },
      },
      { ...db, outboxOldestS: 400, emailStuck: 25 },
      th,
    );
    const by = Object.fromEntries(s.map((x) => [x.key, x.level]));
    expect(by).toEqual({ disk: 'crit', memory: 'warn', db_connections: 'ok', outbox: 'warn', email: 'crit' });
    expect(s.find((x) => x.key === 'disk')!.detail).toBe('занято 95%, свободно 5,0 ГБ из 100,0 ГБ');
  });

  it('уведомление при ухудшении, напоминание раз в сутки, «снова в норме» при устранении', () => {
    const t0 = new Date('2026-10-06T10:00:00Z');
    const crit = evaluateResources({ disk: { totalBytes: 100, freeBytes: 5 } }, db, th);
    const first = resourceAlerts(crit, {}, t0);
    expect(first.alerts.map((a) => `${a.sample.key}:${a.kind}`)).toEqual(['disk:worse']);
    // через 5 минут — тишина, через сутки — напоминание
    expect(resourceAlerts(crit, first.state, new Date(t0.getTime() + 300_000)).alerts).toEqual([]);
    const day = resourceAlerts(crit, first.state, new Date(t0.getTime() + 24 * 3600_000));
    expect(day.alerts.map((a) => a.kind)).toEqual(['reminder']);
    // снижение с «критично» до «внимание» — без письма; затем норма — «снова в норме»
    const warn = evaluateResources({ disk: { totalBytes: 100, freeBytes: 15 } }, db, th);
    const down = resourceAlerts(warn, day.state, new Date(t0.getTime() + 25 * 3600_000));
    expect(down.alerts).toEqual([]);
    const ok = evaluateResources({ disk: { totalBytes: 100, freeBytes: 50 } }, db, th);
    const back = resourceAlerts(ok, down.state, new Date(t0.getTime() + 26 * 3600_000));
    expect(back.alerts.map((a) => a.kind)).toEqual(['recovered']);
  });

  it('текст: критично — «Важно!» и совет, что сделать', () => {
    const [disk] = evaluateResources({ disk: { totalBytes: 100 * GB, freeBytes: 5 * GB } }, db, th);
    const m = resourceMessage(disk!, 'worse', th);
    expect(m.subject).toBe('Важно! Ресурсы сервера: Место на диске — критично (95%)');
    expect(m.high).toBe(true);
    expect(m.body).toContain('Что сделать:');
  });

  it('процессор, подкачка и прогноз заполнения диска', () => {
    const s = evaluateResources(
      {
        cpu: { load5: 14.6, cores: 16 },
        swap: { totalBytes: 4 * GB, freeBytes: 3 * GB },
        disk: { totalBytes: 100 * GB, freeBytes: 40 * GB },
      },
      db,
      th,
      { diskDaysLeft: 5.2 },
    );
    const by = Object.fromEntries(s.map((x) => [x.key, x.level]));
    expect(by.cpu).toBe('crit');
    expect(by.swap).toBe('ok');
    // По занятости диск в норме (60%), но при нынешнем темпе место кончится через 5 дней — критично.
    expect(by.disk).toBe('crit');
    expect(s.find((x) => x.key === 'disk')!.detail).toContain('примерно через 5 дн.');

    const t0 = new Date('2026-10-01T00:00:00Z');
    let h = addDiskPoint([], 50 * GB, t0);
    h = addDiskPoint(h, 50 * GB, new Date(t0.getTime() + 600_000)); // чаще раза в час — не пишется
    expect(h).toHaveLength(1);
    // За 2 суток ушло 10 ГБ — 5 ГБ/сутки, осталось 40 ГБ: около 8 дней.
    const now = new Date(t0.getTime() + 2 * 86_400_000);
    expect(Math.round(diskDaysLeft(h, 40 * GB, now)!)).toBe(8);
    expect(diskDaysLeft(h, 50 * GB, now)).toBeNull();
  });
});
