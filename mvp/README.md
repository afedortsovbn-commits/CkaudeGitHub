# Контакт-центр — MVP

Омниканальный контакт-центр: телефония и IVR, текстовые каналы, единое рабочее место оператора,
вторая линия с согласованием, обновления без остановки обработки обращений.

Требования, архитектура и план — в [`../Контакт-центр/planning/`](../Контакт-центр/planning/).
Журнал выполненных фаз — [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Состав (выполнены фазы Ф0–Ф3)

| Каталог                | Что это                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`             | Основной сервис (NestJS + Fastify): `/api/v1/*`, `/healthz`, `/readyz`, `/metrics`                                                        |
| `apps/worker`          | Приём входящих сообщений из потока `CC_INBOUND` (без потерь и дублей)                                                                     |
| `apps/router`          | ACD: распределение текстовых обращений операторам, статусы операторов, перелив, эскалация, таймаут принятия (pg-boss)                     |
| `apps/realtime`        | WebSocket для операторов и клиентов (события по правам, «печатает…»)                                                                      |
| `apps/web`             | Веб-интерфейс (React + Mantine): администрирование, рабочее место оператора, супервизор                                                   |
| `apps/widget`          | Виджет чата для сайта и страница для WebView мобильного приложения (Preact)                                                               |
| `packages/auth`        | Токены, загрузка прав, области видимости (общие для api и realtime)                                                                       |
| `packages/domain`      | Общая логика обращений: приём входящего, добавление сообщения, события, статус оператора                                                  |
| `e2e`                  | Сквозные тесты в браузере (Playwright)                                                                                                    |
| `packages/contracts`   | Контракты событий (zod): оболочка события, правила совместимости                                                                          |
| `packages/db`          | SQL-миграции (правило expand/contract), раннер миграций, схема Drizzle                                                                    |
| `packages/service-kit` | Общая основа сервисов: конфиг, JSON-логи, корректная остановка, NATS, transactional outbox, очередь задач (pg-boss), метрики              |
| `infra/compose`        | Docker Compose: Traefik, PostgreSQL 16, NATS JetStream ×3, SeaweedFS (S3), api, worker, router, realtime, web ×2; профиль `observability` |
| `ops/`                 | Сборка образов, поэтапное обновление, офлайн-комплект, проверки                                                                           |

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

На сервере обязательно задайте в `infra/compose/.env` свои `JWT_SECRET`, `POSTGRES_PASSWORD`, `BOOTSTRAP_ADMIN_PASSWORD`.

## Обновление без остановки

```bash
ops/build-images.sh v2
API_TAG=v2 ops/rollout.sh api
WEB_TAG=v2 ops/rollout.sh web
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
