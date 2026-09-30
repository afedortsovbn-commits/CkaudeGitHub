# CLAUDE.md — точка входа для продолжения работы

Проект: собственный **омниканальный контакт-центр** (MVP) для заказчика из Беларуси.
Язык общения с заказчиком, документов, коммитов, PR и интерфейса — **русский**.

## С чего начать новую сессию

1. Прочитать `Контакт-центр/planning/03-план-разработки.md`: **раздел 1** (правила каждой фазы) и раздел своей фазы.
   Там же у каждой фазы есть готовая формулировка задания и критерии готовности (DoD).
2. Прочитать указанные в фазе разделы `Контакт-центр/planning/02-архитектура.md` и требования `M-*` из
   `01-требования-mvp.md`.
3. Прочитать `mvp/docs/PROGRESS.md` — журнал выполненных фаз: что сделано, решения, находки, ограничения.
4. Открытые вопросы и решения по умолчанию — `04-открытые-вопросы.md`. Ответы заказчика (приоритетный источник) —
   `planning/sources/модули-и-указания-заказчика.md`, разделы 3 и 4. Исходные документы заказчика в `Контакт-центр/`
   не удалять и без нужды не читать — всё сведено в 01/02.

## Текущее состояние (30.09.2026)

- **Выполнены Ф0–Ф12 и Ф12b** (PR #1–#3, #5–#13, #15, #16 и PR Ф12b, см. `mvp/docs/PROGRESS.md`). Код — в `mvp/`, как запустить —
  `mvp/README.md`.
- **Ф5a** добавила телефонию: `infra/asterisk` (2 узла, образ на `andrius/asterisk:22`), `infra/kamailio` (Kamailio 6
  из RPM на AlmaLinux 9, WSS 8443, auth_ephemeral, dispatcher), coturn ×2, сервис `call-control` (ARI, активный/
  резервный на узел по аренде в NATS KV, сверка после переключения), голос в router (ёмкость 1), софтфон JsSIP в web,
  запись через snoop-канал, прослушивание, демо-страница `/demo-call`, `ops/update-media.sh` (осушение узла).
- **Ф5b** добавила в софтфон модуль аудиоустройств (`apps/web/src/lib/audio-devices.ts`: выбор, горячая замена через
  `replaceTrack`, тест), кнопки гарнитур по WebHID (`lib/headset.ts`, стандартная HID Telephony page, без Jabra SDK),
  качество связи по `getStats` и ICE restart, горячие клавиши Ctrl+Alt+A/H/M; чек-лист гарнитур — в PROGRESS.md.
- **Ф6** добавила `packages/flow-engine` (граф, проверка, пошаговый исполнитель — общий для call-control и
  тестового прогона в браузере; узлы ботов для текста — задел Ф7), исполнение IVR в call-control (`src/ivr.ts`,
  состояние шага — `call.ivr_state` в БД), конструктор IVR на React Flow (`/ivr`), аудиобиблиотеку, объявления о
  сбоях, интеграционные операции (выполняет api, вызов из call-control — NATS `cc.integration.execute`), панель
  внешних данных в карточке, CSAT после разговора, голосовое сообщение → задача «перезвонить», `mock-selfservice`.
  Демо-IVR — номер **2000** (1000 — сразу в очередь).
- **Ф7** добавила шаблоны ответов (`/код`), базу знаний (FTS по-русски), правила автоответов (приветствие, «в
  очереди», нерабочее время, ключевые слова, автозакрытие), текстовые узлы бота в flow-engine (сообщение, кнопки,
  сбор поля, перевод на оператора) с исполнением в worker (`packages/domain/src/automation.ts` — в транзакции
  входящего сообщения, статус обращения `bot`), подсказки (Assist) — считает **api** по запросу панели оператора
  (`apps/api/src/automation/assist.ts`: встроенный, LLM OpenAI-совместимый, внешний HTTP), оценку чата в виджете.
  Демо-чат с ботом — `/widget/demo.html?key=demo-webchat-bot` (прежний `demo-webchat` — без бота).
- **Ф8** добавила 2-ю линию: тикеты (`packages/domain/src/tickets.ts`: передача, открытие, закрытие ответственным,
  согласование, возврат, переадресация, замена, увольнения, «применить матрицу»; все переходы — с проверкой
  `version`), уведомления (`ticket-notify.ts`: письма «Важно!», колокольчик, ежедневная рассылка), worker — рассылка
  (pg-boss раз в минуту + отметка дня) и отправка писем из очереди `notification` (SMTP — `TICKET_SMTP_*`), api —
  `apps/api/src/tickets/`, web — форма передачи, вкладки «На согласовании»/«Переданные», `/tickets` (кабинет),
  `/tickets/:id`, `/tickets-control`. Обращение с тикетом — статус `waiting_2nd_line`.
- **Ф9** добавила публичный API `/api/v1/ext/*` по ключам (`api_key`: права `conversations.read/write`, `bot.reply`,
  `inbound`, область видимости; guard различает ключ `cck_…` и сессию сотрудника), OpenAPI 3.1
  (`/api/v1/openapi.json`, `apps/api/src/ext/openapi.ts`, тест сверяет с маршрутами), webhooks
  (`packages/domain/src/webhooks.ts`: worker раскладывает `CC_EVENTS` по подпискам в `webhook_delivery`, доставка с
  HMAC, пробная доставка при сбое), Bot Gateway (подписка вида `bot` на канале, `conversation.bot_turn`, срок
  ответа → оператор), внешний канал (`POST /ext/inbound`, канал типа `api`), экспорт/импорт конфигурации
  (`apps/api/src/config/`), страницы «Ключи API», «Webhooks», «Внешний бот», «Экспорт и импорт», «Документация API».
  Демо: `/widget/demo.html?key=demo-webchat-extbot` (эхо-бот), подписка «Демо: анализатор» (выключена).
- **Ф10** добавила отчёты M-REP-03 по журналу `event` (`apps/api/src/reports/`: `GET /api/v1/reports/<вид>`, JSON и
  CSV; история статусов обращения восстанавливается из событий — эпизоды ожидания и отрезки обработки), событие
  `agent.status_changed`, измерения `topicId`/`objectId` в `ConversationRef`, `dispositionKind`, назначенных в
  событиях тикетов, прямые переводы (`transferKind: direct`); миграция `0011` (индексы журнала, `cc_uuid_array`,
  право `reports.view`, пороги `supervisor.thresholds`, `report.*`); панель супервизора со сводкой, SL за сегодня и
  подсветкой по порогам; страницу «Отчёты». Реестр просроченных — по таблице `ticket`.
- **Ф11** добавила выпуск без простоя: `ops/release.sh <тег>` (предпроверки, expand-миграции с `lock_timeout`,
  поэтапная замена в порядке 02 6.6, `app.version`, `FEATURE_FLAGS`, `MEDIA_TAG`, журнал `release_log`, `--rollback`),
  `ops/update-media.sh` (Asterisk, coturn, NATS, Kamailio; отчёт; решение администратора при `MAX_DRAIN`), проверку
  совместимости контрактов `pnpm compat:check --base <ref>` (`ops/compat`: типы `@cc/contracts` и OpenAPI из любой
  git-ревизии), линтер миграций с `--base` и пометкой `-- contract-of: NNNN`, фиче-флаги (`/api/v1/features`,
  «Настройки»), баннер новой версии и автообновление вне звонка (`apps/web/src/lib/app-version.ts`), автотест
  `ops/zero-downtime-test/run.mjs` (10 операторов, 30 вызовов, 100 чатов во время выпуска; в CI — задача
  `zero-downtime`, N = базовая ветка), `ops/test/kamailio-restart.mjs`. Регламент — `mvp/docs/регламент-обновления.md`.
- **Ф12** добавила: право «видит неклассифицированные обращения» (`scope.unclassified` у роли, `app_user.sees_unclassified`
  у сотрудника — в `scopeFilter`/`inScope`, В-52), настраиваемые параметры SL (В-51, `reports/reports.ts` `slParams`),
  вход с кодом TOTP (`packages/auth/src/totp.ts`, «Профиль», `security.admin_2fa_required`), маскирование ПДн в логах
  (`service-kit/src/pii.ts`) и сквозной `correlationId` (`service-kit/src/trace.ts`, `x-request-id` → `traceId`
  событий), версии текстов согласий (`consent_text` + триггер), срок хранения записей (pg-boss в api), обезличивание
  клиента и сотрудника (`apps/api/src/privacy/`), `ops/backup.sh` / `ops/restore.sh [--verify]`, `ops/demo.sh`,
  сертификат домена Traefik (`TRAEFIK_TLS`), `TRUNK_ALLOW` в Kamailio, руководства и отчёт о соответствии в `mvp/docs/`.
- **Ф12b** закрыла пробелы «частично»: вкладки «Удержание»/«Постобработка» (`?tab=hold|wrapup`, по признакам звонка
  и молчания клиента — `operator.wrapup_chat_idle_s`), несколько транков (`TRUNKS="хост:порт;приоритет,…"`, перебор в
  `failure_route` Kamailio), слияние дублей клиентов (`POST /contacts/:id/merge`, право `contacts.merge`,
  `merged_into_id` подставляется в api/worker/realtime), обязательный тег (`queue.require_tag`), консультативный
  перевод (call-control: `consult`/`consult_complete`/`consult_cancel`, состояние — `call.consult_*`), все строки web
  и виджета — в `src/lib/i18n` (`pnpm i18n:check`). Отчёт о соответствии: «частично» — 0.
- **Следующая — Ф13** (Rocket Data, синхронизация объектов) — после получения описаний API от заказчика (В-32, В-42),
  задание — в 03.
- Ждём от заказчика: параметры SIP-транка МТС (подключается переменной `TRUNK_HOST`), описание API Rocket Data и
  источника справочника объектов (к Ф13). Их отсутствие работу не блокирует — см. соответствующие фазы в плане.

## Порядок работы по фазе

- Одна фаза = ветка `phase-NN-<кратко>` от `main` → черновой PR в `main` → CI зелёный → слияние (merge-коммит).
- В конце фазы: раздел в `mvp/docs/PROGRESS.md`, статус в таблице раздела 2 плана, правки 02 при изменении решений,
  обновление таблицы «Состав» в `mvp/README.md`.
- Перед пушем: `pnpm format:check lint typecheck test`, `pnpm licenses:check`, `pnpm i18n:check`, `pnpm migrations:lint --base origin/main`,
  `pnpm test:ops`, `pnpm compat:check --base origin/main`;
  интеграционные тесты api — с `TEST_DATABASE_URL`; e2e (Playwright, `mvp/e2e`) против поднятого стека.
- Каждый новый сервис: ≥2 экземпляра в compose, добавить в `ops/build-images.sh` (APPS) и в CI, проверить
  `ops/rollout.sh <сервис>` под нагрузкой (скрипты в `ops/test/`).

## Ключевые требования, которые нельзя нарушать

- **Обновление без остановки обработки обращений** — главное требование заказчика (окно до 60 с допустимо лишь для
  редких случаев). Отсюда: корректная остановка через `service-kit` Lifecycle, миграции **только expand**
  (contract — отдельным релизом позже; имена `NNNN_expand_*.sql`, линтер + squawk), события только через
  transactional outbox, контракты в `packages/contracts` меняются только аддитивно, обработчики идемпотентны.
- **Суверенность (M-NFR-10)**: работа в закрытом контуре без интернета, офлайн-комплект (`ops/mirror/`), только
  свободные бессрочные лицензии (проверка в CI). MinIO не использовать (выбран SeaweedFS). Никаких облачных SaaS
  в продукте.
- **Права**: роль + области видимости (предприятия × подразделения × темы). Любой новый список/карточка фильтруется
  единым предикатом `scopeFilter`/`inScope` из `packages/auth`; чужая запись по прямому id → 404.
- Настройки из админки применяются без перезапуска (событие `config.changed`). Всё, что видит оператор, —
  настраиваемое. Браузеры: Chrome, Яндекс Браузер, Edge. Время — Europe/Minsk.

## Технические особенности и грабли (уже найдены)

- **Traefik ≥ 3.6** обязателен при Docker Engine 29+ (3.5 не подключается к Docker API).
- **Маршруты Traefik — только в `infra/traefik/dynamic.yml`**, метки контейнеров описывают лишь сервис (порт,
  healthcheck). Если метки старых и новых контейнеров различаются, Traefik снимает маршрут во время rollout → 404.
- Keep-alive задерживал остановку — при остановке `Connection: close` и `closeIdleConnections` (уже в `app.factory.ts`).
- `jose` — версии 5.x (6.x только ESM, а проект CommonJS). В тестах Vitest DI NestJS требует явный
  `@Inject(...)` (esbuild не выдаёт метаданные типов).
- turbo не пробрасывает переменные окружения в задачи — нужные перечислять в `passThroughEnv` (`turbo.json`).
- jsonb-значения в `pg` передавать через `JSON.stringify` (массив иначе станет массивом PostgreSQL).
- Для `text/plain` и неизвестных типов тело разбирается как Buffer (иначе ломались загрузки файлов).
- Порядок сообщений — по `sent_at`, дедупликация — по `(channel_kind, external_id)`.
- Бакеты NATS KV с одним именем (`cc_leases`, `cc_outbound_sent`) должны создаваться с одинаковыми параметрами
  во всех сервисах (TTL, реплики) — иначе второй сервис получит ошибку несовпадения конфигурации бакета.
- Телефония: образы `cc/asterisk`, `cc/kamailio` собирает `ops/build-images.sh` (тег `MEDIA_TAG`, `SKIP_MEDIA=1` —
  пропустить). Базы: `andrius/asterisk:22`, `kamailio/kamailio-store:6.0.5-centos-9.amd64`, `almalinux:9` (в облаке —
  через `mirror.gcr.io/...` + `docker tag`). ARI: после `StasisEnd` приложению не приходит `ChannelDestroyed`.
  Kamailio должен слушать адрес интерфейса (не 0.0.0.0 — иначе Record-Route ломает диалоги).
  Регистрации софтфона копятся (новая на каждую загрузку страницы, живут 300 с), а вызов рассылается максимум на
  12 контактов — поэтому `usrloc desc_time_order=1` (новые первыми) и снятие регистрации на `pagehide`. Браузер в e2e —
  Chromium с `--use-fake-device-for-media-stream`; Asterisk в docker-сети доступен браузеру на хосте напрямую.
- IVR: фразы Asterisk берёт по HTTP у call-control (`sound:http://call-control:3000/media/<id>.wav`,
  `res_http_media_cache`) — нужен `astcachedir` (иначе проигрывание мгновенно «заканчивается»). DTMF из браузера —
  RFC 4733, из SIPp — SIP INFO (`ops/test/sipp/ivr-scenario.mjs`). Файлы аудиобиблиотеки — WAV 8 кГц моно, приводит
  браузер. web подключает исходники `packages/flow-engine` псевдонимом Vite (`vite.config.ts`, `tsconfig paths`).
  Расширить CHECK в expand-миграции: `DROP CONSTRAINT IF EXISTS x` + `ADD CONSTRAINT x CHECK … NOT VALID` в том
  же файле (исключение линтера). Задача «перезвонить» (голосовое обращение без вызова) не занимает голос в router.
- Ф7: кнопки бота во всех каналах — это обычный текст клиента (Telegram — клавиатура ответа), исполнитель
  сопоставляет текст/номер кнопки. Панель подсказок перечитывает `/suggestions` только при новом сообщении клиента
  (ключ запроса не начинается с `/conversations`). Адрес LLM вне контура сохраняется только с `allowExternal`.
  Мок LLM — в `mock-selfservice` (`/v1`, `/down/v1`, `/slow/v1`). Имена переменных сценария — и кириллицей.
- Ф8: письма по тикетам сначала пишутся в `notification` (уникальный `dedupe_key`), отправляются отдельно;
  рассылку в тестах вызывать `runDailyDigest(pool, now)` с подменой времени. Подстановка по матрице теперь в
  `packages/domain/src/matrix.ts` (api реэкспортирует). Для e2e Ф8 — `TICKET_SMTP_HOST=mail TICKET_SMTP_PORT=3025`.
- Ф9: публичные типы событий выводятся из внутренних (`publicEventOf` в contracts) — новые `action` у
  `conversation.updated` становятся `conversation.updated`, если их не добавить в таблицу. Мок внешних систем для
  e2e — `127.0.0.1:8082` (`/hooks/<имя>`, `POST /control {"down":true}`); демо-ключи API совпадают у сида и мока.
  Пункты меню ищутся e2e по подстроке (`nav`) — не давать новым пунктам названий, содержащих существующие.
- Ф10: отчёты — SQL с CTE в коде (`reports/query.ts`: `convCtes`, `TRANSITION_CTES`, `dimWhere`); **каждая смена
  статуса обращения/тикета/оператора обязана публиковать событие** — иначе отчёты её не увидят (статический тест
  `reports/journal.test.ts`). Неиспользуемый `$n` в запросе — ошибка PostgreSQL: параметры, зависящие от разреза,
  добавлять через `Params.lazy`; параметры в `AT TIME ZONE`/сравнениях — с явным приведением типа. Тест-эталон
  (`it/reports.int.test.ts`) пишет события прямо в `event` за прошлые даты. «Настройки» отправляют только изменённые
  ключи (в `system_setting` есть служебные). Супервизор с областью не видит неклассифицированные обращения (В-52).
- Ф11: **обновлять стек только командами компонентов** (`release.sh`, `rollout.sh`, `update-media.sh`), не общим
  `docker compose up` — он пересоздаст разом все изменившиеся контейнеры (все узлы NATS, оба Asterisk). Запросы внутри
  диалога к софтфону адресованы GRUU (`sip:op-…@cc.local;gr=…`) — Kamailio разрешает их `lookup("location")`
  (`route[DLG_TO_BROWSER]`); без этого ACK не доходил и звонок рвался через 32 с. Kamailio без DNS-кэша
  (`use_dns_cache=off`), Record-Route — по имени `SIP_ADVERTISE`. Asterisk при соединении с оператором шлёт клиенту
  re-INVITE — сценарии SIPp с разговором брать из `talkScenario()` (`ops/test/lib/stack.mjs`). Проверки здоровья
  образов: `--start-interval=1s`, затем раз в 10 с, `--retries=3` (частые проверки грузят CPU и «флапают»). worker
  обрабатывает входящие параллельно по ключу «канал + отправитель» (`INBOUND_CONCURRENCY`). Новые тесты с
  Playwright/SIPp/БД — через `ops/test/lib/stack.mjs`. Docker Hub в облаке упирается в лимит — базовые образы при
  сборке через `mirror.gcr.io` (`--build-arg NGINX_IMAGE=…`, `KAMAILIO_RPMS_IMAGE`, `BASE_IMAGE`).
- Ф12: Traefik читает **каталог** динамической конфигурации (`routes.yml` = `infra/traefik/dynamic.yml` + `tls.yml` из
  `TRAEFIK_TLS`); ссылка на отсутствующий файл сертификата ломает TLS целиком, пустой `tls: {}` — ошибка. web после
  `stop`/`start` раньше оставался в «осушении» (`/tmp/draining`) — entrypoint теперь удаляет отметку. Журнал `event`
  меняется только в транзакции обезличивания (`SET LOCAL cc.pd_erase = 'on'`). Логгер `createLogger` маскирует ПДн —
  в тестах логов учитывать (`maskPii: false` или `LOG_PII=1`). Бэкап — `umask 077`, утилита S3 запускается
  `--user $(id -u)`. e2e: в статусе «Готов» router предлагает оператору чаты, оставшиеся от прошлых тестов (лимит
  чатов) — брать из очереди до перехода в «Готов».
- Ф12b: **строки интерфейса — только в `apps/web/src/lib/i18n/<раздел>.ts`** (виджет — `apps/widget/src/lib/i18n.ts`),
  в коде `t.<раздел>.<ключ>`; кириллица в строках/JSX вне ресурсов ломает `pnpm i18n:check` (комментарии можно). Не
  называйте локальные переменные `t` — затеняют ресурсы. Ресурсы без `as const` (литеральные типы мешали `useState`).
  Kamailio: `dispatcher` — только узлы Asterisk (`flags=2` — без него `ds_next_dst` не работал); транки — список
  `__TRUNK_LIST__` из entrypoint. Встроенный `-sn uas` SIPp не возвращает Record-Route — для транка в тестах свой
  сценарий. MultiSelect Mantine в e2e — `getByRole('textbox', { name }).click({ force: true })`.
- JetStream при старте кластера отвечает не сразу: сервисы подключаются через `connectNats` (ждёт готовности), новые
  потоки/потребители/KV создавать через `ensureStream` или обёртку `retryJs` из `service-kit`.
- Стек для e2e Ф4/Ф5 и проверок: `COMPOSE_PROFILES=test MOCK_TELEGRAM_TAG=<тег> PUBLIC_BASE_URL=https://traefik TRUNK_HOST=trunk-sim:5060`,
  образы моков — `APPS="mock-telegram mock-selfservice" ops/build-images.sh <тег>`. Проверки, оставляющие операторов «Готов»
  (`route-under-rollout.mjs`), влияют на последующие: router сам предлагает новые обращения.

## Облачное окружение Claude (если нужно поднимать стек)

- Docker-демон может быть не запущен после перезапуска контейнера:
  `setsid nohup dockerd > /tmp/dockerd.log 2>&1 < /dev/null &`, затем подождать `docker info`.
- Если Docker Hub недоступен или упирается в лимиты — тянуть образы через `mirror.gcr.io/library/<образ>`
  (или `mirror.gcr.io/<владелец>/<образ>`) и переименовывать `docker tag` в имя из compose; либо задать переменные
  `*_IMAGE` из `docker-compose.yml`.
- Playwright использует предустановленный Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), `playwright install`
  не запускать.
- Сборка: `cd mvp && pnpm install && ops/build-images.sh dev`; запуск — см. `mvp/README.md`.
