import { newId } from '@cc/contracts';
import { type FlowEdge, type FlowGraph, type FlowNode, validateGraph } from '@cc/flow-engine';
import type { PoolClient } from 'pg';

export const DEMO_BOT_NAME = 'Демо: бот сайта сети АЗС';
export const DEMO_BOT_KEY = 'demo-webchat-bot';

/**
 * Демо Ф7 (01, разд. 5, сценарий 2): отдельный канал «Чат на сайте с ботом» (ключ demo-webchat-bot — прежний
 * demo-webchat остаётся без бота, на нём работают проверки Ф2–Ф4), опубликованный бот (кнопки → сбор
 * телефона → баланс из мока самообслуживания → перевод на оператора с темой), правила автоответов этого
 * канала, общие шаблоны ответов, база знаний и провайдер LLM (мок OpenAI-совместимого сервера, выключен).
 * Идемпотентно: бот с этим именем уже есть — пропуск.
 */
export async function seedBotDemo(tx: PoolClient, o: { llmUrl: string }): Promise<boolean> {
  const exists = await tx.query(`SELECT 1 FROM flow WHERE name = $1`, [DEMO_BOT_NAME]);
  if (exists.rowCount) return false;
  const q = await tx.query<{ id: string }>(`SELECT id FROM queue WHERE name = 'Общая' LIMIT 1`);
  const queue = q.rows[0]?.id;
  if (!queue) return false; // нет базовых демо-данных
  const topic = async (name: string) =>
    (await tx.query<{ id: string }>(`SELECT id FROM topic WHERE name = $1 AND is_active LIMIT 1`, [name]))
      .rows[0]?.id ?? null;
  const tBalance = await topic('Баланс бонусов');
  const tAccrual = await topic('Начисление бонусов');
  const tBlock = await topic('Блокировка карты');
  const op = await tx.query<{ id: string }>(
    `SELECT id FROM integration_op WHERE code = 'selfservice.balance'`,
  );
  const balanceOp = op.rows[0]?.id;

  // ---------- бот
  const n = (
    id: string,
    type: FlowNode['type'],
    params: Record<string, unknown>,
    x: number,
    y: number,
    name?: string,
  ): FlowNode => ({
    id,
    type,
    params,
    position: { x, y },
    ...(name ? { name } : {}),
  });
  const e = (source: string, exit: string, target: string): FlowEdge => ({
    id: `${source}-${exit}-${target}`,
    source,
    exit,
    target,
  });
  const nodes: FlowNode[] = [
    n('start', 'start', {}, 300, 0),
    n(
      'hello',
      'message',
      { text: 'Я виртуальный помощник. Помогу быстро узнать баланс бонусов или соединю с оператором.' },
      300,
      110,
    ),
    n(
      'menu',
      'buttons',
      {
        text: 'Выберите, пожалуйста, тему обращения:',
        buttons: [
          { id: 'bonus', label: 'Баланс бонусов' },
          { id: 'cards', label: 'Топливные карты' },
          { id: 'other', label: 'Другой вопрос' },
        ],
        retries: 1,
        retryText: 'Не понял вас. Нажмите, пожалуйста, одну из кнопок.',
        variable: 'Тема',
      },
      300,
      230,
      'Тема обращения',
    ),
    n(
      'phone',
      'ask',
      {
        text: 'Напишите, пожалуйста, номер телефона, к которому привязана бонусная карта.',
        variable: 'Телефон',
        validation: 'phone',
        retries: 1,
        retryText: 'Это не похоже на номер телефона. Пример: +375 29 123-45-67.',
        saveTo: 'phone',
      },
      40,
      380,
      'Сбор телефона',
    ),
    ...(balanceOp
      ? [
          n(
            'balance',
            'http',
            { operationId: balanceOp, input: { phone: '{{Телефон}}' } },
            40,
            520,
            'Баланс',
          ),
          n(
            'said',
            'message',
            { text: 'По карте {{card}} на счёте {{balance}} бонусов (уровень «{{level}}»).' },
            40,
            640,
          ),
        ]
      : []),
    n(
      'toBonus',
      'handoff',
      {
        queueId: queue,
        topicId: tBalance,
        text: 'Передаю диалог оператору — он ответит на остальные вопросы.',
      },
      40,
      770,
      'Оператор: бонусы',
    ),
    n(
      'toCards',
      'handoff',
      { queueId: queue, topicId: tBlock, priority: 5, text: 'Соединяю со специалистом по топливным картам.' },
      320,
      380,
      'Оператор: карты',
    ),
    n(
      'toOther',
      'handoff',
      { queueId: queue, text: 'Соединяю с оператором, пожалуйста, подождите.' },
      580,
      380,
      'Оператор',
    ),
  ];
  const edges: FlowEdge[] = [
    e('start', 'next', 'hello'),
    e('hello', 'next', 'menu'),
    e('menu', 'btn:bonus', 'phone'),
    e('menu', 'btn:cards', 'toCards'),
    e('menu', 'btn:other', 'toOther'),
    e('menu', 'other', 'toOther'),
    e('phone', 'invalid', 'toBonus'),
    ...(balanceOp
      ? [
          e('phone', 'next', 'balance'),
          e('balance', 'ok', 'said'),
          e('balance', 'error', 'toBonus'),
          e('said', 'next', 'toBonus'),
        ]
      : [e('phone', 'next', 'toBonus')]),
  ];
  const graph: FlowGraph = { version: 1, kind: 'text', nodes, edges };
  const v = validateGraph(graph);
  if (v.errors.length) throw new Error(`демо-бот: ${v.errors.map((x) => x.message).join('; ')}`);
  const flowId = newId();
  const versionId = newId();
  await tx.query(`INSERT INTO flow (id, name, kind, description, draft) VALUES ($1, $2, 'text', $3, $4)`, [
    flowId,
    DEMO_BOT_NAME,
    'Демо-сценарий 2: кнопки, сбор телефона, баланс, перевод на оператора',
    JSON.stringify(graph),
  ]);
  await tx.query(
    `INSERT INTO flow_version (id, flow_id, version, graph, comment) VALUES ($1, $2, 1, $3, 'демо-данные')`,
    [versionId, flowId, JSON.stringify(graph)],
  );
  await tx.query(`UPDATE flow SET published_version_id = $2 WHERE id = $1`, [flowId, versionId]);

  const channel = newId();
  await tx.query(
    `INSERT INTO channel (id, kind, name, queue_id, bot_flow_id, config) VALUES ($1, 'webchat', $2, $3, $4, $5)`,
    [
      channel,
      'Чат на сайте с ботом (демо)',
      queue,
      flowId,
      JSON.stringify({
        public_key: DEMO_BOT_KEY,
        allowed_origins: ['*'],
        consent_version: '1',
        consent_text:
          'Я согласен(на) на обработку персональных данных в соответствии с политикой конфиденциальности.',
        greeting: 'Здравствуйте! Задайте вопрос — ответит бот, при необходимости подключится оператор.',
        max_file_mb: 10,
      }),
    ],
  );

  // ---------- правила автоответов канала с ботом
  const rule = async (r: Record<string, unknown>) => {
    const cols = Object.keys(r);
    await tx.query(
      `INSERT INTO auto_reply_rule (id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
      [newId(), ...Object.values(r)],
    );
  };
  await rule({
    name: 'Приветствие (сайт с ботом)',
    kind: 'greeting',
    channel_ids: [channel],
    text: 'Здравствуйте! Спасибо, что написали в контакт-центр сети АЗС.',
  });
  await rule({
    name: '«Вы в очереди» (сайт с ботом)',
    kind: 'queued',
    channel_ids: [channel],
    text: 'Вы в очереди — оператор подключится в ближайшее время.',
  });
  await rule({
    name: 'Часы работы',
    kind: 'keyword',
    channel_ids: [channel],
    match_type: 'keyword',
    pattern: 'часы работы, режим работы, до скольки',
    text: 'Контакт-центр работает круглосуточно, АЗС сети — с 06:00 до 23:00.',
  });
  await rule({
    name: 'Автозакрытие при молчании (сайт с ботом)',
    kind: 'inactivity',
    channel_ids: [channel],
    text: 'Вы ещё здесь? Если вопросов больше нет, диалог закроется автоматически через 5 минут.',
    params: JSON.stringify({
      warnAfterSec: 600,
      closeAfterSec: 300,
      closeText: 'Диалог закрыт: вы не ответили. Напишите снова, если понадобится помощь.',
    }),
  });

  // ---------- общие шаблоны ответов
  const tpl = async (title: string, shortcut: string, body: string, topicId: string | null) =>
    tx.query(`INSERT INTO reply_template (id, title, body, shortcut, topic_id) VALUES ($1, $2, $3, $4, $5)`, [
      newId(),
      title,
      body,
      shortcut,
      topicId,
    ]);
  await tpl(
    'Приветствие',
    'привет',
    'Здравствуйте, {{client.name}}! Меня зовут {{operator.firstName}}, чем могу помочь?',
    null,
  );
  await tpl(
    'Баланс бонусов',
    'баланс',
    'Баланс бонусного счёта можно посмотреть в мобильном приложении в разделе «Карта» или на кассе любой АЗС. ' +
      'Бонусы начисляются в течение 24 часов после заправки.',
    tBalance,
  );
  await tpl(
    'Бонусы не начислены',
    'неначислены',
    'Бонусы начисляются в течение 24 часов. Если прошло больше суток, пришлите, пожалуйста, фото чека — проверим и начислим вручную.',
    tAccrual,
  );
  await tpl(
    'Блокировка топливной карты',
    'блок',
    'Заблокировать топливную карту можно в личном кабинете клиента или по письму на бланке организации. ' +
      'Сейчас я оформлю заявку — назовите, пожалуйста, номер карты.',
    tBlock,
  );
  await tpl('Завершение', 'пока', 'Спасибо за обращение, {{client.name}}! Хорошего дня.', null);

  // ---------- база знаний
  const cat = async (name: string, sort: number) => {
    const id = newId();
    await tx.query(`INSERT INTO kb_category (id, name, sort_order) VALUES ($1, $2, $3)`, [id, name, sort]);
    return id;
  };
  const cBonus = await cat('Бонусная программа', 1);
  const cCards = await cat('Топливные карты', 2);
  const art = async (
    category: string,
    title: string,
    body: string,
    topics: (string | null)[],
    keywords: string,
  ) =>
    tx.query(
      `INSERT INTO kb_article (id, category_id, title, body, topic_ids, keywords) VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), category, title, body, topics.filter(Boolean), keywords],
    );
  await art(
    cBonus,
    'Как узнать баланс бонусов',
    'Баланс бонусного счёта отображается в мобильном приложении (раздел «Карта»), в чеке на АЗС и в личном ' +
      'кабинете на сайте. Оператор видит баланс в карточке клиента (панель «Данные из внешних систем»). ' +
      '1 бонус = 1 копейка при оплате топлива и товаров.',
    [tBalance],
    'баланс, бонусы, баллы, остаток, сколько бонусов',
  );
  await art(
    cBonus,
    'Сроки начисления бонусов',
    'Бонусы начисляются в течение 24 часов после покупки. Если бонусы не пришли: проверить, что карта была ' +
      'предъявлена до оплаты, запросить фото чека и оформить обращение «Начисление бонусов».',
    [tAccrual],
    'начисление, не пришли бонусы, не начислили',
  );
  await art(
    cCards,
    'Блокировка топливной карты',
    'Блокировка выполняется немедленно по звонку ответственного лица организации (проверка по кодовому слову) ' +
      'или по письму на бланке. Разблокировка — только по письму. Тема обращения «Блокировка карты» — особо важная.',
    [tBlock],
    'заблокировать карту, потеря карты, украли карту',
  );

  // ---------- провайдер LLM (мок OpenAI-совместимого сервера) — выключен по умолчанию (M-AI-01)
  await tx.query(
    `INSERT INTO assist_provider (id, name, kind, config, functions, timeout_ms, sort_order, is_active)
     VALUES ($1, 'LLM (локальная модель, демо)', 'openai', $2, '{suggest,draft}', 5000, 10, false)`,
    [newId(), JSON.stringify({ baseUrl: o.llmUrl, model: 'mock-llm' })],
  );
  return true;
}
