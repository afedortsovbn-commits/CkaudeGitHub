import {
  API_KEY_PERMISSIONS,
  BOT_TURN_EVENT,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_EVENTS,
} from '@cc/contracts';

/**
 * OpenAPI 3.1 публичного API (Ф9, M-INT-01). Описание ведётся рядом с контроллером `ext.controller.ts`;
 * тест `openapi.test.ts` сверяет, что каждый маршрут контроллера описан здесь (и наоборот).
 * Изменения — только аддитивные (новые пути, необязательные поля), как у контрактов событий.
 */

type Obj = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Obj, description = 'Успешно') => ({
  description,
  content: { 'application/json': { schema } },
});
const idParam = (name = 'id', description = 'Идентификатор (UUID)') => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', format: 'uuid' },
});
const errors = {
  '400': {
    description: 'Ошибка в данных запроса',
    content: { 'application/json': { schema: ref('Error') } },
  },
  '401': { description: 'Нет ключа, ключ недействителен или отозван' },
  '403': { description: 'У ключа нет нужного права' },
  '404': { description: 'Не найдено или вне области видимости ключа' },
  '429': { description: 'Превышена частота запросов (500 за 10 с на ключ)' },
};
const op = (o: {
  summary: string;
  description?: string;
  perm?: string;
  tag: string;
  params?: Obj[];
  body?: Obj;
  ok?: Obj;
  status?: string;
  extra?: Obj;
}) => ({
  tags: [o.tag],
  summary: o.summary,
  description: [o.description, o.perm ? `Право ключа: \`${o.perm}\`.` : ''].filter(Boolean).join('\n\n'),
  ...(o.params ? { parameters: o.params } : {}),
  ...(o.body ? { requestBody: { required: true, content: { 'application/json': { schema: o.body } } } } : {}),
  responses: { [o.status ?? '200']: o.ok ?? { description: 'Успешно' }, ...errors, ...(o.extra ?? {}) },
});

export function buildOpenApi(serverUrl: string): Obj {
  const eventList = Object.entries(WEBHOOK_EVENTS)
    .map(([k, v]) => `- \`${k}\` — ${v}`)
    .join('\n');
  const permList = Object.entries(API_KEY_PERMISSIONS)
    .map(([k, v]) => `- \`${k}\` — ${v}`)
    .join('\n');
  return {
    openapi: '3.1.0',
    info: {
      title: 'Контакт-центр — публичный API',
      version: '1.0.0',
      description: [
        'REST API для внешних систем: чтение обращений, запись результатов анализа, внешний бот (Bot Gateway), ' +
          'приём сообщений сторонней системы как обращений (внешний канал). Версия — в пути (`/api/v1`); ' +
          'изменения в пределах версии только добавляют пути и необязательные поля.',
        '## Аутентификация',
        'Ключ API выпускает администратор («Администрирование → Ключи API»); ключ показывается один раз. ' +
          'Передавайте его в заголовке `Authorization: Bearer cck_…` (или `X-API-Key: cck_…`). ' +
          'У ключа — права и область видимости (предприятия × подразделения × темы, как у сотрудника): ' +
          'обращение вне области — ответ 404.',
        `### Права ключа\n${permList}`,
        '## Webhooks',
        'Подписки на события настраиваются в «Администрирование → Webhooks». Запрос — `POST` JSON ' +
          '`{id, type, occurredAt, data}`; доставка «хотя бы один раз», повторы с экспоненциальной задержкой ' +
          '— получатель отбрасывает повторы по `id`. Подпись: заголовки ' +
          `\`${TIMESTAMP_HEADER}\` (секунды Unix) и \`${SIGNATURE_HEADER}: sha256=<hex>\`, где hex — ` +
          'HMAC-SHA256 секрета подписки от строки `<timestamp>.<тело запроса>`. Отвечайте 2xx в течение ' +
          'таймаута подписки (по умолчанию 5 с); обработку дольше выполняйте асинхронно.',
        `### Типы событий\n${eventList}\n- \`${BOT_TURN_EVENT}\` — ход внешнего бота (только подпискам «внешний бот»)`,
        '## Внешний бот (Bot Gateway)',
        'Канал с назначенным внешним ботом отдаёт новые диалоги боту: на каждое сообщение клиента бот получает ' +
          `\`${BOT_TURN_EVENT}\` (см. схему BotTurn) и отвечает вызовами \`POST …/messages\` (ответ клиенту, ` +
          'кнопки) и `POST …/handoff` (перевод на оператора). Не ответил до `deadline` — диалог уходит оператору.',
        '## Анализ завершённых обращений',
        'Подпишитесь на `conversation.closed` и/или `recording.ready`, получите данные (`GET …/conversations/{id}`, ' +
          '`…/messages`, `GET /recordings/{id}`) и запишите результат `PATCH /conversations/{id}` — поля, теги, ' +
          'заметка оператору.',
      ].join('\n\n'),
    },
    servers: [{ url: serverUrl.replace(/\/$/, '') }],
    security: [{ apiKey: [] }],
    tags: [
      { name: 'Ключ', description: 'Сведения о ключе' },
      { name: 'Обращения', description: 'Чтение обращений, сообщений, клиентов и записей' },
      { name: 'Анализ', description: 'Запись результатов внешнего анализа (M-AI-03)' },
      { name: 'Внешний бот', description: 'Bot Gateway (M-AI-02)' },
      { name: 'Внешний канал', description: 'Приём сообщений сторонней системы (M-CH-09)' },
    ],
    paths: {
      '/api/v1/ext/me': {
        get: op({ tag: 'Ключ', summary: 'Права и область видимости ключа', ok: json(ref('KeyInfo')) }),
      },
      '/api/v1/ext/conversations': {
        get: op({
          tag: 'Обращения',
          summary: 'Список обращений (новые изменения первыми)',
          perm: 'conversations.read',
          params: [
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['open', 'closed', 'bot', 'all'], default: 'all' },
            },
            { name: 'channelId', in: 'query', schema: { type: 'string', format: 'uuid' } },
            {
              name: 'updatedSince',
              in: 'query',
              description: 'Только изменённые после момента (ISO 8601 с часовым поясом)',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          ok: json({ type: 'array', items: ref('Conversation') }),
        }),
      },
      '/api/v1/ext/conversations/{id}': {
        get: op({
          tag: 'Обращения',
          summary: 'Обращение: тема, поля, теги, клиент, записи разговоров',
          perm: 'conversations.read',
          params: [idParam()],
          ok: json(ref('ConversationDetail')),
        }),
        patch: op({
          tag: 'Анализ',
          summary: 'Записать результат анализа: поля, теги, заметка',
          description:
            'Поля объединяются с имеющимися (`null` — удалить поле); оператор видит их в карточке. Теги — по ' +
            'названию существующих тегов. Заметка видна только сотрудникам. Работает и для закрытых обращений.',
          perm: 'conversations.write',
          params: [idParam()],
          body: ref('ConversationPatch'),
          ok: json(ref('ConversationDetail')),
        }),
      },
      '/api/v1/ext/conversations/{id}/messages': {
        get: op({
          tag: 'Обращения',
          summary: 'Сообщения обращения по порядку',
          perm: 'conversations.read',
          params: [
            idParam(),
            {
              name: 'includeNotes',
              in: 'query',
              description: 'Включить внутренние заметки сотрудников',
              schema: { type: 'boolean', default: false },
            },
          ],
          ok: json({ type: 'array', items: ref('Message') }),
        }),
        post: op({
          tag: 'Внешний бот',
          summary: 'Ответ бота клиенту',
          description: 'Только пока обращение ведёт внешний бот (иначе 409).',
          perm: 'bot.reply',
          params: [idParam()],
          body: ref('BotMessage'),
          status: '201',
          ok: json(ref('Message'), 'Сообщение отправлено'),
          extra: { '409': { description: 'Обращение уже у оператора или закрыто' } },
        }),
      },
      '/api/v1/ext/conversations/{id}/notes': {
        post: op({
          tag: 'Анализ',
          summary: 'Внутренняя заметка оператору',
          perm: 'conversations.write',
          params: [idParam()],
          body: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string', maxLength: 10000 } },
            additionalProperties: false,
          },
          status: '201',
          ok: json(ref('Message'), 'Заметка добавлена'),
        }),
      },
      '/api/v1/ext/conversations/{id}/handoff': {
        post: op({
          tag: 'Внешний бот',
          summary: 'Перевод диалога на оператора',
          perm: 'bot.reply',
          params: [idParam()],
          body: ref('Handoff'),
          ok: json({ type: 'object', properties: { ok: { type: 'boolean' } } }),
          extra: { '409': { description: 'Обращение уже у оператора или закрыто' } },
        }),
      },
      '/api/v1/ext/contacts/{id}': {
        get: op({
          tag: 'Обращения',
          summary: 'Клиент и его идентификаторы (телефон, email, Telegram)',
          perm: 'conversations.read',
          params: [idParam()],
          ok: json(ref('Contact')),
        }),
      },
      '/api/v1/ext/recordings/{id}': {
        get: op({
          tag: 'Обращения',
          summary: 'Запись разговора (WAV)',
          description: 'Каждое скачивание записывается в журнал аудита.',
          perm: 'conversations.read',
          params: [idParam()],
          ok: {
            description: 'Файл',
            content: { 'audio/wav': { schema: { type: 'string', format: 'binary' } } },
          },
          extra: { '409': { description: 'Запись ещё обрабатывается' } },
        }),
      },
      '/api/v1/ext/inbound': {
        post: op({
          tag: 'Внешний канал',
          summary: 'Сообщение сторонней системы → обращение',
          description:
            'Сообщение попадает в канал «Внешняя система (API)», назначенный ключу, и дальше обрабатывается как ' +
            'любое обращение (очередь, автоответы, бот). Клиент узнаётся по телефону или email во всех каналах. ' +
            'Повтор с тем же `externalId` дубля не создаёт. Ответы операторов — событием `message.created` ' +
            '(подписка webhooks с фильтром по каналу).',
          perm: 'inbound',
          body: ref('Inbound'),
          status: '202',
          ok: json(
            {
              type: 'object',
              properties: { accepted: { type: 'boolean' }, id: { type: 'string', format: 'uuid' } },
            },
            'Принято',
          ),
          extra: { '409': { description: 'Внешний канал отключён' } },
        }),
      },
    },
    webhooks: {
      webhookEvent: {
        post: {
          summary: 'Событие по подписке',
          parameters: [
            { name: TIMESTAMP_HEADER, in: 'header', required: true, schema: { type: 'string' } },
            { name: SIGNATURE_HEADER, in: 'header', required: true, schema: { type: 'string' } },
            { name: 'x-cc-event', in: 'header', required: true, schema: { type: 'string' } },
            {
              name: 'x-cc-delivery',
              in: 'header',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: { content: { 'application/json': { schema: ref('WebhookEvent') } } },
          responses: { '200': { description: 'Принято (любой 2xx)' } },
        },
      },
      botTurn: {
        post: {
          summary: 'Ход внешнего бота',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  allOf: [ref('WebhookEvent'), { type: 'object', properties: { data: ref('BotTurn') } }],
                },
              },
            },
          },
          responses: { '200': { description: 'Принято (ответ боту — вызовами API)' } },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'cck_…', description: 'Ключ API' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, message: { type: 'string' }, details: {} },
        },
        KeyInfo: {
          type: 'object',
          properties: {
            keyId: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            permissions: { type: 'array', items: { type: 'string', enum: Object.keys(API_KEY_PERMISSIONS) } },
            channelId: { type: ['string', 'null'], format: 'uuid' },
            scope: { description: '`all` или правила области' },
          },
        },
        Conversation: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: {
              type: 'string',
              enum: [
                'bot',
                'queued',
                'offered',
                'active',
                'hold',
                'wrap_up',
                'waiting_customer',
                'waiting_2nd_line',
                'closed',
              ],
            },
            channelId: { type: 'string', format: 'uuid' },
            channelKind: {
              type: 'string',
              enum: ['webchat', 'app', 'telegram', 'email', 'api', 'voice', 'review'],
            },
            contactId: { type: 'string', format: 'uuid' },
            queueId: { type: ['string', 'null'] },
            assigneeId: { type: ['string', 'null'] },
            assigneeName: { type: ['string', 'null'] },
            topicId: { type: ['string', 'null'] },
            topicName: { type: ['string', 'null'] },
            enterpriseId: { type: ['string', 'null'] },
            departmentId: { type: ['string', 'null'] },
            isImportant: { type: 'boolean' },
            fields: { type: 'object', additionalProperties: true },
            tags: { type: 'array', items: { type: 'string' } },
            disposition: { type: ['string', 'null'], description: 'Результат обработки' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            closedAt: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        ConversationDetail: {
          allOf: [
            ref('Conversation'),
            {
              type: 'object',
              properties: {
                contact: ref('Contact'),
                recordings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      callId: { type: 'string', format: 'uuid' },
                      createdAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          ],
        },
        Contact: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: ['string', 'null'] },
            phone: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            segment: { type: ['string', 'null'] },
            identities: {
              type: 'array',
              items: { type: 'object', properties: { kind: { type: 'string' }, value: { type: 'string' } } },
            },
          },
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            seq: { type: 'integer' },
            direction: { type: 'string', enum: ['in', 'out', 'system', 'note'] },
            text: { type: 'string' },
            attachments: { type: 'array', items: { type: 'object' } },
            sentAt: { type: 'string', format: 'date-time' },
            authorName: { type: ['string', 'null'] },
            meta: {
              type: 'object',
              description: 'auto — автоответ/бот, buttons — кнопки, external — ключ API',
            },
          },
        },
        ConversationPatch: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fields: {
              type: 'object',
              additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
              example: { sentiment: 'негативная', summary: 'Клиент недоволен обслуживанием на АЗС' },
            },
            addTags: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string' },
              example: ['Требует контроля'],
            },
            note: { type: 'string', maxLength: 10000 },
          },
        },
        BotMessage: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', maxLength: 4000 },
            buttons: {
              type: 'array',
              maxItems: 10,
              items: { type: 'string', maxLength: 64 },
              description: 'Кнопки: нажатие приходит следующим ходом как текст кнопки',
            },
          },
        },
        Handoff: {
          type: 'object',
          additionalProperties: false,
          properties: {
            queueId: {
              type: 'string',
              format: 'uuid',
              description: 'Очередь (по умолчанию — очередь канала)',
            },
            topicId: { type: 'string', format: 'uuid' },
            text: { type: 'string', description: 'Сообщение клиенту перед переводом' },
            note: { type: 'string', description: 'Заметка оператору' },
          },
        },
        Inbound: {
          type: 'object',
          required: ['externalId', 'contact'],
          additionalProperties: false,
          properties: {
            externalId: { type: 'string', maxLength: 200, description: 'Идентификатор сообщения у вас' },
            contact: {
              type: 'object',
              additionalProperties: false,
              description: 'Хотя бы одно из: externalId, phone, email',
              properties: {
                externalId: { type: 'string' },
                name: { type: 'string' },
                phone: { type: 'string', example: '+375291234567' },
                email: { type: 'string', format: 'email' },
              },
            },
            text: { type: 'string', maxLength: 20000 },
            fields: {
              type: 'object',
              additionalProperties: { type: ['string', 'number', 'boolean'] },
              description: 'Данные формы — в поля обращения',
            },
          },
        },
        WebhookEvent: {
          type: 'object',
          required: ['id', 'type', 'occurredAt', 'data'],
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Ключ идемпотентности' },
            type: { type: 'string', enum: [...Object.keys(WEBHOOK_EVENTS), BOT_TURN_EVENT, 'webhook.test'] },
            occurredAt: { type: 'string', format: 'date-time' },
            data: {
              type: 'object',
              description:
                'Для событий обращений — conversationId, contactId, channelId, channelKind, status, queueId, ' +
                'assigneeId, enterpriseId, departmentId, topicPath, isImportant, action; для message.created — ' +
                'ещё message; для тикетов — ticketId, number, status, dueDate и измерения.',
            },
          },
        },
        BotTurn: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', format: 'uuid' },
            channel: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' } } },
            contact: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: ['string', 'null'] },
                phone: { type: ['string', 'null'] },
                email: { type: ['string', 'null'] },
              },
            },
            message: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                attachments: { type: 'array' },
              },
            },
            history: { type: 'array', items: { type: 'object' } },
            replyUrl: { type: 'string', format: 'uri' },
            handoffUrl: { type: 'string', format: 'uri' },
            deadline: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  };
}
