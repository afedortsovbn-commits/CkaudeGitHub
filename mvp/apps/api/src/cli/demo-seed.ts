import { newId } from '@cc/contracts';
import type { PoolClient } from 'pg';
import { hashPassword } from '../auth/passwords';

/**
 * Демо-данные (домен из ТЗ: сеть АЗС/ЭЗС). Названия условные. Идемпотентно: если предприятие E1 уже есть — пропуск.
 * Пароль демо-сотрудников задаётся переменной DEMO_PASSWORD (только для стендов).
 */
export async function seedDemo(tx: PoolClient, demoPassword: string): Promise<boolean> {
  const exists = await tx.query(`SELECT 1 FROM enterprise WHERE code = 'E1'`);
  if (exists.rowCount) return false;

  const ins = async (table: string, data: Record<string, unknown>) => {
    const id = (data.id as string) ?? newId();
    const cols = Object.keys(data).filter((k) => k !== 'id');
    await tx.query(
      `INSERT INTO ${table} (id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
      [id, ...cols.map((c) => data[c])],
    );
    return id;
  };

  const ent: Record<string, string> = {};
  const ents: [string, string][] = [
    ['E1', 'Предприятие «Север»'],
    ['E2', 'Предприятие «Юг»'],
    ['E3', 'Предприятие «Центр»'],
  ];
  for (const [code, name] of ents) ent[code] = await ins('enterprise', { code, name });

  const dep: Record<string, string> = {};
  const deps: [string, string, string[]][] = [
    ['OPS', 'Служба эксплуатации АЗС', ['E1', 'E2', 'E3']],
    ['CLIENT', 'Отдел по работе с клиентами', ['E1', 'E2', 'E3']],
    ['EV', 'Служба зарядных станций', ['E1', 'E3']],
    ['LOY', 'Отдел программы лояльности', ['E1']],
    ['SUP', 'Техническая поддержка', ['E1']],
  ];
  const ed: Record<string, string> = {};
  for (const [code, name, es] of deps) {
    dep[code] = await ins('department', { code, name });
    for (const e of es) {
      ed[`${e}/${code}`] = await ins('enterprise_department', {
        enterprise_id: ent[e],
        department_id: dep[code],
        transfer_number: code === 'SUP' ? '+375170000000' : null,
      });
    }
  }

  const topic: Record<string, string> = {};
  const addTopic = async (
    key: string,
    name: string,
    parent?: string,
    extra: Record<string, unknown> = {},
  ) => {
    topic[key] = await ins('topic', {
      parent_id: parent ? topic[parent] : null,
      level: 1,
      path: '{}',
      name,
      ...extra,
    });
  };
  const tree: [string, string, [string, string, Record<string, unknown>?][]?, Record<string, unknown>?][] = [
    [
      'cards',
      'Банковские карты',
      [
        ['cards.pay', 'Оплата картой на АЗС'],
        ['cards.refund', 'Возврат средств'],
      ],
    ],
    [
      'fuel',
      'Топливо',
      [
        ['fuel.quality', 'Качество топлива'],
        ['fuel.short', 'Недолив'],
      ],
    ],
    [
      'app',
      'Мобильное приложение',
      [
        ['app.login', 'Вход и регистрация'],
        ['app.pay', 'Оплата в приложении'],
      ],
    ],
    [
      'staff',
      'Жалобы на персонал АЗС',
      [
        ['staff.rude', 'Некорректное поведение'],
        ['staff.service', 'Качество обслуживания'],
      ],
      { is_important: true, default_response_days: 10 },
    ],
    ['site', 'Сайт'],
    ['gift', 'Подарочные сертификаты'],
    [
      'bonus',
      'Бонусная программа',
      [
        ['bonus.balance', 'Баланс бонусов'],
        ['bonus.accrual', 'Начисление бонусов'],
      ],
    ],
    [
      'ev',
      'Электрозарядные станции',
      [
        ['ev.start', 'Зарядка не запускается'],
        ['ev.pay', 'Оплата зарядки'],
      ],
    ],
    [
      'b2b',
      'Топливные карты B2B',
      [
        ['b2b.block', 'Блокировка карты', { is_important: true, default_response_days: 3 }],
        ['b2b.limits', 'Лимиты'],
      ],
    ],
    ['goods', 'Сопутствующие товары и питание'],
  ];
  let order = 0;
  for (const [key, name, children, extra] of tree) {
    await addTopic(key, name, undefined, { sort_order: order++, ...(extra ?? {}) });
    for (const [ck, cn, cextra] of children ?? []) await addTopic(ck, cn, key, cextra ?? {});
  }
  await addTopic('fuel.quality.diesel', 'Дизельное топливо', 'fuel.quality');
  await addTopic('fuel.quality.petrol', 'Бензин', 'fuel.quality');

  await ins('field_def', {
    topic_id: topic.fuel,
    key: 'station',
    label: 'Номер АЗС',
    type: 'text',
    required_on_escalate: true,
    sort_order: 1,
  });
  await ins('field_def', {
    topic_id: topic.fuel,
    key: 'fuel_date',
    label: 'Дата заправки',
    type: 'date',
    required_on_escalate: true,
    sort_order: 2,
  });
  await ins('field_def', {
    topic_id: topic.b2b,
    key: 'card_number',
    label: 'Номер топливной карты',
    type: 'text',
    mask: '0000 0000 0000 0000',
    required_on_escalate: true,
  });
  await ins('field_def', {
    topic_id: topic.staff,
    key: 'station',
    label: 'Номер АЗС',
    type: 'text',
    required_on_close: true,
    required_on_escalate: true,
  });

  for (const [i, e] of ['E1', 'E1', 'E2', 'E2', 'E3', 'E3'].entries()) {
    await ins('service_object', {
      enterprise_id: ent[e],
      code: `AZS-${i + 1}`,
      name: `АЗС №${i + 1}`,
      address: `г. Минск, ул. Условная, ${i + 1}`,
    });
  }
  await ins('service_object', {
    enterprise_id: ent.E1,
    code: 'EV-1',
    name: 'ЭЗС-1',
    address: 'г. Минск, пр. Условный, 10',
  });

  const hash = await hashPassword(demoPassword);
  const user = async (email: string, fullName: string, roles: string[], e?: string, d?: string) => {
    const id = await ins('app_user', {
      email,
      full_name: fullName,
      password_hash: hash,
      primary_enterprise_id: e ? ent[e] : null,
      primary_department_id: d ? dep[d] : null,
    });
    for (const r of roles)
      await tx.query('INSERT INTO user_role (user_id, role_code) VALUES ($1, $2)', [id, r]);
    await tx.query('INSERT INTO access_scope (id, user_id) VALUES ($1, $2)', [newId(), id]);
    return id;
  };
  const u = {
    sup: await user('supervisor@demo.local', 'Смирнова Анна (супервизор)', ['supervisor']),
    op1: await user('operator1@demo.local', 'Иванов Пётр (оператор)', ['operator']),
    op2: await user('operator2@demo.local', 'Кузнецова Ольга (оператор)', ['operator']),
    op3: await user('operator3@demo.local', 'Попов Сергей (оператор)', ['operator']),
    r1: await user('resp1@demo.local', 'Васильев Андрей (ответственный)', ['responsible'], 'E1', 'OPS'),
    r2: await user('resp2@demo.local', 'Морозова Елена (ответственный)', ['responsible'], 'E2', 'OPS'),
    r3: await user('resp3@demo.local', 'Новиков Игорь (ответственный)', ['responsible'], 'E1', 'LOY'),
    r4: await user('resp4@demo.local', 'Фёдорова Мария (ответственный)', ['responsible'], 'E1', 'EV'),
    c1: await user('curator1@demo.local', 'Козлов Дмитрий (куратор)', ['responsible'], 'E1', 'OPS'),
    c2: await user('curator2@demo.local', 'Лебедева Татьяна (куратор)', ['responsible'], 'E1', 'EV'),
  };
  // Супервизор с ограниченной областью — для демонстрации прав: только предприятие «Север».
  await tx.query('UPDATE access_scope SET enterprise_ids = $2 WHERE user_id = $1', [u.sup, [ent.E1]]);

  const assign = async (edKey: string, t: string, userId: string, kind: 'responsible' | 'curator') =>
    ins('responsibility', { enterprise_department_id: ed[edKey], topic_id: topic[t], user_id: userId, kind });
  await assign('E1/OPS', 'fuel', u.r1, 'responsible');
  await assign('E1/OPS', 'fuel.quality', u.r2, 'responsible'); // более точное назначение на подтему
  await assign('E2/OPS', 'fuel', u.r2, 'responsible');
  await assign('E3/OPS', 'fuel', u.r1, 'responsible');
  for (const e of ['E1', 'E2', 'E3']) await assign(`${e}/OPS`, 'fuel', u.c1, 'curator');
  await assign('E1/CLIENT', 'staff', u.r1, 'responsible');
  await assign('E1/CLIENT', 'staff', u.c1, 'curator');
  await assign('E1/LOY', 'bonus', u.r3, 'responsible');
  await assign('E1/EV', 'ev', u.r4, 'responsible');
  await assign('E3/EV', 'ev', u.r4, 'responsible');
  await assign('E1/EV', 'ev', u.c2, 'curator');
  await assign('E1/SUP', 'app', u.r3, 'responsible');

  let i = 0;
  const disps: [string, string, string][] = [
    ['resolved', 'Решено на 1-й линии', 'resolved'],
    ['escalate', 'Передать на 2-ю линию', 'escalate'],
    ['no_reply', 'Не требует ответа', 'no_reply_needed'],
    ['postponed', 'Отложено / перезвонить', 'postponed'],
    ['duplicate', 'Дубликат', 'duplicate'],
  ];
  for (const [code, name, behavior] of disps)
    await ins('disposition', { code, name, behavior, sort_order: i++ });
  i = 0;
  const methods: [string, string][] = [
    ['email', 'Электронная почта'],
    ['messenger', 'Мессенджер'],
    ['phone', 'Телефон'],
    ['paper', 'Письмо на бумаге'],
    ['none', 'Не требует связи с клиентом'],
  ];
  for (const [code, name] of methods) await ins('answer_method', { code, name, sort_order: i++ });

  const qGeneral = await ins('queue', {
    name: 'Общая',
    channels: ['voice', 'webchat', 'app', 'telegram', 'email'],
    priority: 0,
  });
  await ins('queue', { name: 'B2B', channels: ['voice', 'email'], priority: 10 });
  for (const op of [u.op1, u.op2, u.op3])
    await tx.query('INSERT INTO user_queue (user_id, queue_id) VALUES ($1, $2)', [op, qGeneral]);
  for (const n of ['Повторное обращение', 'VIP', 'Требует контроля']) await ins('tag', { name: n });
  for (const n of ['Обед', 'Технический перерыв', 'Обучение']) await ins('break_reason', { name: n });
  await ins('schedule', {
    name: 'Круглосуточно',
    week: JSON.stringify(
      Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '24:00']]]),
      ),
    ),
  });
  await ins('channel', {
    kind: 'webchat',
    name: 'Чат на сайте (демо)',
    queue_id: qGeneral,
    config: JSON.stringify({
      public_key: 'demo-webchat',
      allowed_origins: ['*'],
      consent_version: '1',
      consent_text:
        'Я согласен(на) на обработку персональных данных в соответствии с политикой конфиденциальности.',
      greeting: 'Здравствуйте! Напишите ваш вопрос — оператор скоро ответит.',
      max_file_mb: 10,
    }),
  });
  await ins('channel', {
    kind: 'app',
    name: 'Чат в мобильном приложении (демо)',
    queue_id: qGeneral,
    config: JSON.stringify({
      public_key: 'demo-app',
      allowed_origins: ['*'],
      consent_version: '1',
      app_secret: 'demo-app-secret-change-me-0123456789',
    }),
  });
  await ins('channel', {
    kind: 'voice',
    name: 'Телефон (демо)',
    queue_id: qGeneral,
    // 1000 — номер демо-страницы «Позвонить» и генератора вызовов SIPp; +375… — пример номера транка.
    config: JSON.stringify({ dids: ['1000', '+375170000000'], record: true }),
  });
  await ins('scope_template', {
    name: 'Только предприятие «Север»',
    rules: JSON.stringify([{ enterpriseIds: [ent.E1], departmentIds: null, topicIds: null }]),
  });
  return true;
}
