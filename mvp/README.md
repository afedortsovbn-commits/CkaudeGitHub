# Контакт-центр — MVP

Омниканальный контакт-центр: телефония и IVR, текстовые каналы, единое рабочее место оператора,
вторая линия с согласованием, обновления без остановки обработки обращений.

Требования, архитектура и план — в [`../Контакт-центр/planning/`](../Контакт-центр/planning/).
Журнал выполненных фаз — [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Состав (выполнены фазы Ф0–Ф4)

| Каталог                   | Что это                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                | Основной сервис (NestJS + Fastify): `/api/v1/*`, `/healthz`, `/readyz`, `/metrics`                                                                                                      |
| `apps/worker`             | Приём входящих сообщений из потока `CC_INBOUND` (без потерь и дублей), статусы доставки ответов во внешние каналы                                                                       |
| `apps/connector-telegram` | Telegram-боты как экземпляры канала: long polling или webhook (`/tg/<id канала>`), текст, фото и документы, доставка ответов                                                            |
| `apps/connector-email`    | Почтовые ящики: приём по IMAP (IDLE), ответы по SMTP в ту же цепочку писем, вложения; ящики распределяются между экземплярами (аренда в NATS KV)                                        |
| `apps/mock-telegram`      | Мок Telegram Bot API для e2e и проверок (профиль `test`, в поставку не входит)                                                                                                          |
| `apps/router`             | ACD: распределение текстовых обращений операторам, статусы операторов, перелив, эскалация, таймаут принятия (pg-boss)                                                                   |
| `apps/realtime`           | WebSocket для операторов и клиентов (события по правам, «печатает…»)                                                                                                                    |
| `apps/web`                | Веб-интерфейс (React + Mantine): администрирование, рабочее место оператора, супервизор                                                                                                 |
| `apps/widget`             | Виджет чата для сайта и страница для WebView мобильного приложения (Preact)                                                                                                             |
| `packages/auth`           | Токены, загрузка прав, области видимости (общие для api и realtime)                                                                                                                     |
| `packages/domain`         | Общая логика обращений: приём входящего, добавление сообщения, исходящие во внешние каналы, события, статус оператора                                                                   |
| `packages/connector-kit`  | Основа коннекторов каналов: реестр экземпляров канала (без перезапуска), доставка исходящих, вложения, журнал и статус канала                                                           |
| `e2e`                     | Сквозные тесты в браузере (Playwright)                                                                                                                                                  |
| `packages/contracts`      | Контракты событий (zod): оболочка события, правила совместимости                                                                                                                        |
| `packages/db`             | SQL-миграции (правило expand/contract), раннер миграций, схема Drizzle                                                                                                                  |
| `packages/service-kit`    | Общая основа сервисов: конфиг, JSON-логи, корректная остановка, NATS, transactional outbox, очередь задач (pg-boss), аренды в NATS KV, шифрование секретов, метрики                     |
| `infra/compose`           | Docker Compose: Traefik, PostgreSQL 16, NATS JetStream ×3, SeaweedFS (S3), api, worker, router, realtime, коннекторы, web ×2; профили `observability`, `test` (мок Telegram, GreenMail) |
| `ops/`                    | Сборка образов, поэтапное обновление, офлайн-комплект, проверки                                                                                                                         |

## Быстрый старт

Нужны: Node.js 22, pnpm 10, Docker с Compose (Docker Engine 29+ требует Traefik 3.6+, он и используется).

```bash
cd mvp
ops/build-images.sh dev                                   # сборка кода и образов cc/api:dev, cc/web:dev
SEED_DEMO=true BOOTSTRAP_ADMIN_PASSWORD='Admin12345!' \
  docker compose -f infra/compose/docker-compose.yml up -d --wait
# интерфейс: https://localhost  (самоподписанный сертификат)
# демо-сайт с виджетом чата: https://localhost/widget/demo.html
docker compose -f infra/compose/docker-compose.yml --profile observability up -d   # Prometheus :9090, Grafana :3001
```

Учётные записи демо-стенда (`SEED_DEMO=true`, пароль `Demo12345!`, задаётся `DEMO_PASSWORD`):

| Вход                                                                                  | Роль                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `admin@cc.local` / `BOOTSTRAP_ADMIN_PASSWORD`                                         | Администратор                                    |
| `supervisor@demo.local`                                                               | Супервизор, область — только предприятие «Север» |
| `operator1@demo.local` … `operator3@demo.local`                                       | Операторы                                        |
| `resp1@demo.local` … `resp4@demo.local`, `curator1@demo.local`, `curator2@demo.local` | Ответственные и кураторы 2-й линии               |

На сервере обязательно задайте в `infra/compose/.env` свои `JWT_SECRET`, `POSTGRES_PASSWORD`, `BOOTSTRAP_ADMIN_PASSWORD`
и `SECRETS_KEY` (ключ шифрования токенов ботов и паролей почты в БД, не короче 16 символов; при его смене секреты
каналов нужно ввести заново). Для Telegram-ботов в режиме webhook — `PUBLIC_BASE_URL` (внешний https-адрес КЦ,
Telegram будет присылать сообщения на `<адрес>/tg/<id канала>`); режим опроса (по умолчанию) входящего доступа из
интернета не требует, нужен только исходящий доступ к `api.telegram.org` (или локальный Bot API-сервер).

Каналы Telegram и email добавляются в «Администрирование → Каналы» и начинают работать без перезапуска; там же —
состояние подключения и журнал обмена канала. Проверить Telegram и почту на стенде без интернета:

```bash
APPS="mock-telegram" ops/build-images.sh dev
export COMPOSE_PROFILES=test PUBLIC_BASE_URL=https://traefik
docker compose -f infra/compose/docker-compose.yml up -d --wait
# мок Telegram: адрес Bot API в настройке бота — http://mock-telegram:3000; «клиент пишет боту»:
curl -X POST http://127.0.0.1:8081/__test/<токен>/message -H 'content-type: application/json' \
  -d '{"chatId": 1001, "text": "Здравствуйте", "firstName": "Иван"}'
# GreenMail: IMAP mail:3143, SMTP mail:3025 без TLS, пароль любой; снаружи — 127.0.0.1:3143/3025
```

## Обновление без остановки

```bash
ops/build-images.sh v2
API_TAG=v2 ops/rollout.sh api
WEB_TAG=v2 ops/rollout.sh web
CONNECTOR_TELEGRAM_TAG=v2 ops/rollout.sh connector-telegram
```

Маршруты Traefik заданы в `infra/traefik/dynamic.yml`, а не в метках контейнеров: во время обновления метки
старых и новых экземпляров не должны различаться. Скрипт поднимает новые экземпляры рядом со старыми, ждёт их готовности, затем корректно останавливает
старые: `readyz` → 503, пауза, пока балансировщик снимет экземпляр, завершение текущих запросов,
закрытие соединений. Проверка под нагрузкой:

```bash
node ops/test/rollout-under-load.mjs v2 50 60   # 50 запросов/с в течение 60 с, во время обновления — 0 ошибок
SERVICE=web node ops/test/rollout-under-load.mjs v2 40 30
node ops/test/chat-under-rollout.mjs v2 60     # переписка во время обновления worker, realtime, api — 0 потерь
node ops/test/route-under-rollout.mjs v2         # распределение обращений во время обновления router — 0 потерь
node ops/test/connectors-under-rollout.mjs v2 60 # Telegram и email во время обновления коннекторов (профиль test)
node ops/test/nats-failover.mjs 2000             # перезапуск узла-лидера NATS — 0 потерь и дублей
```

## Работа без интернета (M-NFR-10)

```bash
ops/mirror/export.sh offline-bundle        # все Docker-образы + все npm-пакеты по lockfile
# перенести репозиторий и offline-bundle/ на сервер без интернета:
ops/mirror/import.sh offline-bundle
PNPM_STORE=offline-bundle/pnpm-store PNPM_OFFLINE=1 ops/build-images.sh v1
ops/mirror/push-registry.sh registry.local:5000   # или опубликовать образы в свой реестр
```

Образы приложений собираются без скачивания чего-либо внутри Docker. Лицензии зависимостей
проверяются в CI (`pnpm licenses:check`), в продукт допускаются только свободные бессрочные лицензии.

## Проверки

```bash
pnpm install && pnpm build
pnpm lint && pnpm typecheck && pnpm test
TEST_DATABASE_URL=postgres://cc:cc_dev_password@127.0.0.1:5432/postgres pnpm test   # + интеграционные тесты API
cd e2e && pnpm exec playwright test                                                  # e2e против запущенного стека
pnpm format:check && pnpm licenses:check && pnpm migrations:lint
```

## Правила для разработки

См. [план, раздел 1](../Контакт-центр/planning/03-план-разработки.md): каждый сервис строится на `service-kit`
(health/readiness, корректная остановка), миграции — только expand в текущем релизе, события — через outbox,
изменения контрактов — только аддитивные.
