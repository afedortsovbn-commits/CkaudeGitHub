import { describe, expect, it } from 'vitest';
import {
  canApprove,
  LINK_PLACEHOLDER,
  renderMail,
  retryDelaySeconds,
  type TicketCard,
} from './ticket-notify';

const card: TicketCard = {
  id: 't1',
  number: 1001,
  status: 'in_work',
  summary: 'Клиент жалуется на недолив',
  due: '2026-10-05',
  isImportant: true,
  topicNames: ['Топливо', 'Недолив'],
  enterpriseName: 'Север',
  departmentName: 'Эксплуатация',
  contactName: 'Иван',
  contactPhone: '+375291112233',
  contactEmail: null,
};

describe('renderMail', () => {
  it('ответственным и кураторам — «Важно!» и высокий приоритет; в письме все поля из M-TKT-04', () => {
    const m = renderMail('daily', card, { daysLeft: 2 });
    expect(m).toMatchObject({ subject: 'Важно! Обращение (2 линия) №1001: осталось 2 дня', high: true });
    for (const part of [
      '№1001',
      'Топливо / Недолив',
      'Север',
      'Эксплуатация',
      'недолив',
      'Иван, +375291112233',
      '05.10.2026',
      LINK_PLACEHOLDER,
    ])
      expect(m.body).toContain(part);
    expect(renderMail('daily', card, { daysLeft: -1 }).subject).toBe(
      'Важно! Обращение (2 линия) №1001: просрочено на 1 день',
    );
    expect(renderMail('assigned', card).subject).toMatch(/^Важно! Вам назначено обращение \(2 линия\) №1001/);
    expect(renderMail('rework', card, { comment: 'нет скана' }).body).toContain('нет скана');
  });
  it('согласование — без высокого приоритета', () => {
    expect(renderMail('approval_request', card)).toMatchObject({
      high: false,
      subject: 'Обращение (2 линия) №1001 ожидает согласования',
    });
    expect(renderMail('approval_reminder', card).high).toBe(false);
  });
});

describe('canApprove: режимы согласования (M-TKT-09)', () => {
  const t = { enterprise_id: 'e1', department_id: 'd1', topic_path: ['a'], created_by: 'op' };
  const all = { all: true, rules: [] };
  const north = { all: false, rules: [{ enterpriseIds: ['e1'], departmentIds: null, topicIds: null }] };
  const south = { all: false, rules: [{ enterpriseIds: ['e2'], departmentIds: null, topicIds: null }] };
  const creatorMode = { mode: 'creator' as const, creatorActive: true, substituteIds: ['sub'] };

  it('creator: создатель, его заместитель и супервизор в области', () => {
    expect(canApprove(creatorMode, t, { id: 'op', canSupervise: false, scope: all })).toBe(true);
    expect(canApprove(creatorMode, t, { id: 'sub', canSupervise: false, scope: all })).toBe(true);
    expect(canApprove(creatorMode, t, { id: 'sup', canSupervise: true, scope: north })).toBe(true);
    expect(canApprove(creatorMode, t, { id: 'sup2', canSupervise: true, scope: south })).toBe(false);
    expect(canApprove(creatorMode, t, { id: 'other', canSupervise: false, scope: all })).toBe(false);
  });
  it('supervisor: только супервизор в области, создатель и заместитель — нет', () => {
    const m = { ...creatorMode, mode: 'supervisor' as const };
    expect(canApprove(m, t, { id: 'op', canSupervise: false, scope: all })).toBe(false);
    expect(canApprove(m, t, { id: 'sub', canSupervise: false, scope: all })).toBe(false);
    expect(canApprove(m, t, { id: 'sup', canSupervise: true, scope: north })).toBe(true);
  });
  it('уволенный создатель не согласует — тикет у супервизоров', () => {
    const gone = { ...creatorMode, creatorActive: false };
    expect(canApprove(gone, t, { id: 'op', canSupervise: false, scope: all })).toBe(false);
    expect(canApprove(gone, t, { id: 'sup', canSupervise: true, scope: all })).toBe(true);
  });
});

describe('повтор отправки', () => {
  it('задержка растёт вдвое и ограничена часом', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([60, 120, 240, 480]);
    expect(retryDelaySeconds(20)).toBe(3600);
  });
});
