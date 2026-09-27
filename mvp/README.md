# Контакт-центр — MVP

Омниканальный контакт-центр: телефония и IVR, текстовые каналы, единое рабочее место оператора,
вторая линия с согласованием, обновления без остановки обработки обращений.

Требования, архитектура и план — в [`../Контакт-центр/planning/`](../Контакт-центр/planning/).
Журнал выполненных фаз — [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Состав (текущая фаза — Ф0: каркас)

| Каталог                | Что это                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/api`             | Основной сервис (NestJS + Fastify): `/api/v1/*`, `/healthz`, `/readyz`, `/metrics`                         |
| `packages/contracts`   | Контракты событий (zod): оболочка события, правила совместимости                                           |
| `packages/db`          | SQL-миграции (правило expand/contract), раннер миграций, схема Drizzle                                     |
| `packages/service-kit` | Общая основа сервисов: конфиг, JSON-логи, корректная остановка, NATS, transactional outbox, метрики        |
| `infra/compose`        | Docker Compose: Traefik, PostgreSQL 16, NATS JetStream ×3, SeaweedFS (S3), api ×2; профиль `observability` |
| `ops/`                 | Сборка образов, поэтапное обновление, офлайн-комплект, проверки                                            |

## Быстрый старт

Нужны: Node.js 22, pnpm 10, Docker с Compose (Docker Engine 29+ требует Traefik 3.6+, он и используется).

```bash
cd mvp
ops/build-images.sh dev                                   # сборка кода и образа cc/api:dev
docker compose -f infra/compose/docker-compose.yml up -d --wait
curl -k https://localhost/api/v1/ping                     # ответы по очереди от двух экземпляров
docker compose -f infra/compose/docker-compose.yml --profile observability up -d   # Prometheus :9090, Grafana :3001
```

## Обновление без остановки

```bash
ops/build-images.sh v2
API_TAG=v2 ops/rollout.sh api
```

Скрипт поднимает новые экземпляры рядом со старыми, ждёт их готовности, затем корректно останавливает
старые: `readyz` → 503, пауза, пока балансировщик снимет экземпляр, завершение текущих запросов,
закрытие соединений. Проверка под нагрузкой:

```bash
node ops/test/rollout-under-load.mjs v2 50 60   # 50 запросов/с в течение 60 с, во время обновления — 0 ошибок
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
pnpm format:check && pnpm licenses:check && pnpm migrations:lint
```

## Правила для разработки

См. [план, раздел 1](../Контакт-центр/planning/03-план-разработки.md): каждый сервис строится на `service-kit`
(health/readiness, корректная остановка), миграции — только expand в текущем релизе, события — через outbox,
изменения контрактов — только аддитивные.
