# Channelbox — архитектура: компоненты и потоки данных (выжимка)

Источник: `Архитектура_Channelbox_компоненты_и_потоки_данных.pdf` (v2.1, авг. 2026, 55 стр.). Схемы разделов 3 и 7.3 просмотрены как изображения.

## 1. О чём документ
- Архитектура продукта Channelbox для текстовых каналов (чат-виджет, мессенджеры, соцсети, email) на базе **Supabase Self-Hosted**: компоненты, потоки, сетевые зоны, интеграционные API, эксплуатация, схема БД (~120–127 таблиц + 11 views).
- Шесть независимых компонентов, связь по HTTPS и WebSocket: ядро Channelbox, WES, MES, Token Service, MCP-сервер, клиентские приложения.
- Helpdesk/тикетов 2-й линии в документе **нет**; есть только outbound-webhooks «в CRM/Service Desk» [прим.: передачу на 2-ю линию проектировать отдельно, точки стыковки — webhooks chat.closed/assigned].

## 2. Компоненты
- **Channelbox (ядро)** — 13 Docker-контейнеров (docker-compose): Nginx (reverse proxy, TLS), Kong (API Gateway), Edge Functions (93 серверные функции через единый роутер `/functions/v1/{name}`), PostgreSQL, Realtime (WebSocket-подписки на изменения БД), GoTrue (аутентификация/сессии), Storage (вложения, аватары), Analytics, Meta, PostgREST, Dashboard, Imgproxy, Vector (логи).
  - Группы Edge Functions: каналы (`telegram-/viber-/instagram-/email-webhook`, `send-external`); виджет/WES; почта MES (`mail-external-service-api`, `smtp-gateway-api`); маршрутизация (`chat-router`, `routing-assign`, `routing-operator-status`); жизненный цикл чата (`chat-events`, `message-events`, таймауты, wrap-up/постобработка); боты/AI (`bot-gateway`, `bot-process-message`, `bot-test`, `mcp-server`); рассылки (`broadcast-worker`); интеграции (`outbound-webhook-dispatch`, `stored-data-api`, `operators-admin-api`, `embed-token`, Consent API); SLA (`sla-check-breaches`, экспорт отчётов); обслуживание (cron/cleanup/warmup на pg_cron).
- **WES (Widget External Services)** — микросервис-прокси в DMZ между виджетами и ядром. К клиенту — WSS; к ядру — HTTPS Callback `POST {host}/widget/callback/{channel_id}`; к Token Service — получение PII по токену. Все файлы проверяются антивирусом до передачи в ядро. Текст, вложения, реакции, lead-формы, обратная связь, «оператор печатает», метаданные посетителя, режим уведомлений (рассылки в ЛК). Горизонтально масштабируется.
  - Callback-формат: получатель (посетитель), тип (текст/системное/feedback/запрос оператора), секрет канала, отправитель, channel_id, текст, действие (new/reply/edit/delete/reaction).
  - Studio-конфигуратор виджета: 140+ полей (вид, тексты, автоприглашения, lead-формы, кастомные поля, видимость по устройствам), темы, медиа-ассеты, живое превью; часть полей на уровне проекта, часть — канала.
- **Token Service** — in-memory токенизация PII (Python/FastAPI, RWLock), TTL 30 мин–24 ч, автоочистка. API: `POST /api/v1/tokens` (UUID v4), `GET/PUT …/extend/DELETE /tokens/{token}`, health, stats; API-ключ.
- **MES (Mail External Service)** — свой почтовый воркер SMTP/IMAP в контуре заказчика; pull-модель к ядру: heartbeat, `GET /config/domains`, `GET /inbound/mailboxes`, `POST /inbound/check`, `POST /inbound/deliver`, `GET /outbound/queue`. `worker_secret` на хост с ротацией из UI; SSRF-защита (флаг `allow_private_host` только self-hosted).
- **MCP-сервер** — Edge Function, протокол MCP (JSON-RPC), 23 инструмента для внешних AI-агентов: чат (take/close/hold/resume/reopen/return_to_queue/transfer_to_operator), сообщения (send, send_from_template, history_get), теги, кастомные поля, шаблоны, очереди, «профиль заёмщика» (get/summary/service_action). Валидация JSON Schema, токен с ротацией, лог каждого вызова, rate limits. Обратное направление: платформа может звать MCP-серверы заказчика для обогащения ответов бота.
- **Клиентские приложения** — сайт, личный кабинет, мобильное приложение (виджет); соцсети — через webhook канала.

## 3. Потоки данных
- **Виджет, прямой режим**: клиент → WSS init (channel_id, name, email) → WES → HTTPS callback (PII открыто) → ядро создаёт/находит посетителя → ответ оператора → WES → WSS клиенту.
- **Виджет с токенизацией**: клиент `POST /tokens` (name, email, phone, metadata) → получает UUID → WSS init (channel_id, token) → WES `GET /tokens/{token}` → PII → callback в ядро. PII не идёт через WebSocket, клиент хранит только токен.
- **Email через MES**: клиент → почтовый сервер → MES забирает по IMAP → `POST /inbound/deliver` (тред, тема, вложения) → ядро → маршрутизация в очередь → оператор отвечает → MES `GET /outbound/queue` → SMTP → клиент. Альтернатива: провайдер (Mailgun/Resend) → HTTPS webhook с HMAC → `email-webhook` → email-тред; исходящие через API провайдера.
- **Мессенджеры**: входящие — webhook на `/functions/v1/{channel}-webhook` с проверкой подписи; исходящие — `send-external` на API мессенджеров.
- **Внешний роутер** (`distribution_mode='external'`): `chat-router` POST внешнему роутеру → синхронный ack `ok` → чат остаётся в очереди → роутер асинхронно `POST /routing-assign (conversation_id, operator_id)` → назначение. Защита от гонок: перед записью QUEUE проверяется текущий статус.
- **Массовая рассылка в ЛК**: кампания (UI или Broadcast API) → формирование аудитории (RPC preview) → `broadcast-worker` батчами по 500 → `send-external` с каноническим payload `external_app` → WES `/widget/external_service/incoming` → уведомление в ЛК.
- **MCP**: AI-агент `tools/call` + токен → валидация → бизнес-логика (RPC/Edge Fn) → результат/структурированная ошибка → лог.
- **Смена статуса оператора** на break/offline → его активные чаты автоматически возвращаются в очередь + system webhook.

## 4. Каналы и интеграция
| Канал | Вход | Верификация | Выход |
|---|---|---|---|
| Telegram | webhook | `X-Telegram-Bot-Api-Secret-Token` | api.telegram.org |
| Viber | webhook | HMAC-SHA256 `X-Viber-Content-Signature`; дедупликация токенов | chatapi.viber.com |
| Instagram/Facebook | общий Meta-webhook | подпись Meta | graph.facebook.com |
| Email (провайдер) | webhook | HMAC-SHA256 | Resend/Mailgun/MailForge API, SMTP |
| Email (MES) | IMAP-опрос воркером | worker_secret | SMTP через очередь |
| Веб-виджет/ЛК/моб. app | WSS через WES | secret_key канала | WSS |
- Email: автосоздание тредов (`original_message_id`, `references_chain`), вложения параллельно, нормализация заголовков, у каждого письма своя тема (видна в карточке и передаётся ботам в `email_context`), подписи с `{name}`, `use_channel_sender_name` скрывает PII оператора. Отправка — Strategy-паттерн `EmailProvider`.
- Embed-скрипт: project_id, язык (ru/en), открыт по умолчанию, разрешённые действия с сообщениями (edit/delete/reply), dev/prod, авторизация ручная (форма) или автоматическая из внешней среды. Loader — ES-module, нужен CORS.
- Типы сообщений виджета (JSON): message, edit, delete, reply, reaction, feedback.

## 5. Рабочее место оператора, боты, распределение, SLA
- UI оператора — отдельный домен, только через VPN; встраивается в CRM через iframe / Chromium WebView / Electron (одноразовый `init_token` 60 с → session JWT, sliding session без third-party cookies, ограничения `allowed_origins`/`allowed_operator_ids`).
- CRM Screen-Pop: webhooks chat.assigned/closed/hold + `postMessage(integration:event)` в родительское окно; триггеры auto_assign, operator_accept, takeover/transfer, tab_switch; кэш настроек 30 с, circuit breaker.
- Функции (по схеме БД): шаблоны сообщений с категориями, тегами, файлами и действиями (кнопки/интенты); внутренние заметки (`is_internal`); реакции, редактирование с историей; теги иерархические с каталогами (привязка каталогов к очередям); категории чатов; кастомные поля посетителя/диалога; закреплённые чаты, курсоры прочтения, уведомления, настраиваемая правая сайдбар-панель, дашборд/workspace-модули; автоперевод сообщений (сохраняется); стикеры; превью ссылок; профиль клиента (кастомный модуль «заёмщик» с группами/layout).
- Статусы оператора: ready / break (с причиной) / offline; история статусов. Роли admin/supervisor/operator + кастомные роли с капабилити; супервайзеры очередей.
- Статусы диалога: pending, active, bot, hold, post_processing (wrap-up), closed; история состояний; reopen.
- Распределение: внутренний роутер (правила между очередями/ботами/операторами, авто-назначение с журналом) или внешний роутер; очереди с расписаниями работы и праздниками; привязка бота к очереди.
- Боты: типы ai / external / script. Внешние — Callback API через `bot-gateway` (v1: текст, файлы, клавиатуры; v2: инлайн-действия, метаданные), при недоступности 5 попыток с экспоненциальным backoff → fallback-сообщение и перевод в очередь. AI — provider-agnostic: OpenRouter или любой OpenAI-совместимый endpoint (в т.ч. on-prem), выбор по model_id; версии промптов; связь ботов с базой знаний (KB: базы/страницы/блоки/chunks/теги — [прим.] структура под RAG).
- SLA: политики на очередь, трекинг, события warning/breach, функция проверки нарушений.
- Обратная связь: шаблоны оценок (stars/nps/csat/thumbs/emoji), опросы, Feedback Form API (API-ключ + HMAC, до 10 файлов по 10 МБ, бот → эскалация → закрытие/переоткрытие).
- Рассылки: сегменты/списки/конкретные посетители, каналы telegram/email/widget/external_app, throttle, авто-пауза при высокой доле ошибок, статусы кампании и получателя.

## 6. Модель данных (ключевое)
- Core: `conversations`, `messages`, `operators`, `queues`, `visitors`, `message_attachments/_reactions/_edit_history`.
- Связи: visitor 1–N conversation; queue 1–N conversation; operator 1–N conversation; operators N–M queues; queue → bot (0..1), work_schedule, sla_policies; conversation → chat_history, tags, field_values.
- Прочее: `external_integrations` (каналы: channel_type, delivery_mode, consent_template_id), `routing_rules`, `internal_routing_rules`, `auto_assign_logs`, `sla_*`, `bots`, `bot_sessions` (state machine), `dialog_sessions` (browser/geo/device), `ai_providers/ai_models`, `email_threads`, `mail_worker_*` (domains/hosts/mailboxes/smtp_accounts/inbound_log/outbound_queue), `consent_*`, `security_*`, `auth_audit_log`, `outbound_webhook_*`, `broadcast_*`, `system_settings` (key-value).
- Views для отчётов: время ответа, длительности статусов/этапов, утилизация операторов, service level, `vw_superset_*` (AHT, время в статусах).

## 7. Технологии и протоколы
- Supabase (PostgreSQL, PostgREST, GoTrue, Realtime, Storage), Kong, Nginx, Deno Edge Functions [прим.: Deno — по природе Supabase, в тексте не названо], pg_cron, Docker Compose, Ansible (сертификаты).
- Python/FastAPI (Token Service); WebSocket/WSS, HTTPS, JSON-RPC (MCP), IMAP/SMTP, HMAC-подписи, JWT, API-ключи с правами (router, stored_data, admin).
- Очередей/брокеров сообщений нет: очереди — таблицы БД (`mail_worker_outbound_queue`, broadcast recipients), событийность — Postgres Realtime и webhooks.
- Outbound webhooks: chat.started/closed, visitor.updated; параллельная отправка (Promise.allSettled), версия v1, таймаут 10 с, лог доставки. System webhooks: operator.status_changed, chat.assigned, chat.queued — синхронно, 5 с, без ретраев.
- Stored Data API (по образцу Webim Stored Data API v4): справочники, инкрементальная выгрузка `/chats?since=` с курсором `last_ts`/`more_available` (CDC-паттерн, upsert у потребителя), `/stats`, опция `anonymize=true`, только SELECT, 60 rpm.
- Operator Status API, Operator Admin API (CRUD операторов для IdM, аудит), Consent API (152-ФЗ/GDPR), BI — Apache Superset поверх views или через ClickHouse/DWH.
- Наблюдаемость: Prometheus (+node/postgres-exporter, Kong), Vector → Loki (или ELK), Grafana; SIEM-экспорт pull-моделью (Wazuh/Splunk/Elastic/QRadar, NDJSON/CEF/Syslog) + push-алерты.
- Безопасность: 3 зоны (VPN для операторов, DMZ для WES/Token, внутренняя для ядра/MES), сервисы на 127.0.0.1, firewall только на фиксированные POST-endpoints, SSRF-блокировка приватных диапазонов, RLS, шифрование API-ключей AI, IP-баны/автобан, rate limits виджета, разрешённые домены.

## 8. Отказоустойчивость / обновления
- Бэкап: WAL-G (ежесуточный full + непрерывный WAL, PITR в S3), pg_dump, синхронизация файлов; RPO от 24 ч (pilot) до минут, RTO от 1–2 ч до 5–15 мин (репликация + PITR). Ежемесячное тестовое восстановление.
- Ограничения: Realtime ~100 событий/с на арендатора; polling как обходной путь запрещён.
- Отказоустойчивость на уровне интеграций: ретраи/fallback ботов, circuit breaker screen-pop, авто-пауза рассылок, защита от гонок роутера.
- Zero-downtime обновлений и HA-кластеризации ядра документ **не описывает** [прим.: единый docker-compose — узкое место для требования zero downtime; WES масштабируется горизонтально].

## 9. Что отброшено
- Sizing (vCPU/RAM/SSD WES/MES/Token), характеристики RPS/латентности Token Service, конкретные SSL-файлы/пути, ссылки на внутренние runbook-и, мелкие детали SIEM-форматов.
