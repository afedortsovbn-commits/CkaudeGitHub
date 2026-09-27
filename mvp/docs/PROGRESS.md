# Журнал фаз MVP

## Ф0. Каркас, инфраструктура, service-kit — выполнена (27.09.2026)

**Сделано**

- Монорепозиторий `mvp/`: pnpm 10 + Turborepo, TypeScript 5.9 (strict), ESLint 9, Prettier, Vitest 3.
- `packages/contracts` — оболочка события (UUIDv7, версия, тип `domain.entity.action`, аддитивная совместимость).
- `packages/db` — SQL-миграции `NNNN_(expand|contract)_*.sql`, раннер под advisory lock с контрольными суммами,
  таблицы `outbox`, `event` (append-only, защищена триггером), `feature_flag`; схема Drizzle.
- `packages/service-kit` — конфиг (zod), JSON-логи pino с маскированием секретов, `Lifecycle` (корректная
  остановка: readiness 503 → пауза → хуки по порядку → выход, аварийный тайм-аут), подключение к NATS с
  бесконечным переподключением, `ensureStream`, transactional outbox + `OutboxRelay` (SKIP LOCKED, Nats-Msg-Id),
  метрики Prometheus.
- `apps/api` — NestJS 11 + Fastify: `/api/v1/ping`, `/api/v1/demo/events` (демонстрация outbox), `/healthz`,
  `/readyz`, `/metrics`; во время остановки отвечает `Connection: close` и закрывает освободившиеся keep-alive.
- `infra/compose` — Traefik 3.6 (HTTPS, health-check `/readyz` раз в секунду, retry), PostgreSQL 16,
  NATS 2.11 кластер ×3 (JetStream R3), SeaweedFS (S3), одноразовый сервис миграций, api ×2;
  профиль `observability`: Prometheus, Grafana, Loki, Promtail.
- `ops/rollout.sh` — поэтапное обновление; `ops/build-images.sh` — сборка без сети внутри Docker;
  `ops/mirror/*` — офлайн-комплект, импорт, публикация в свой реестр; `ops/licenses/check.mjs`;
  `ops/test/migrations-lint.mjs` (правило expand/contract); тесты `rollout-under-load`, `nats-failover`.
- CI: `.github/workflows/mvp.yml` — формат, lint, build, typecheck, unit-тесты, лицензии, линтер миграций,
  squawk; отдельная задача — поэтапное обновление под нагрузкой и отказ узла NATS в Docker.

**Проверено (критерии готовности)**
| Проверка | Результат |
|---|---|
| `docker compose up` с нуля | все сервисы healthy, миграции применены |
| Балансировка | запросы по очереди на 2 экземпляра api |
| Outbox | 5 событий записаны в БД и опубликованы в NATS |
| Поэтапное обновление api под нагрузкой 50 rps, 60 с (3 прогона: v1→v2, v2→v3, v3→v4) | 3000/3000 успешных, 0 ошибок, p99 ≈ 205 мс (с искусственной задержкой 200 мс); старые экземпляры останавливаются за 3–4 с с кодом 0 |
| Перезапуск узла-лидера NATS во время публикации 2000 сообщений (2 прогона) | 2000/2000, без потерь и дублей, лидер переизбран |
| Офлайн-установка зависимостей и сборка при заблокированном реестре npm | успешно |
| Лицензии (98 пакетов) | только MIT, Apache-2.0, BSD-3-Clause, ISC, 0BSD, Unlicense |
| Unit-тесты | 13/13 |

**Решения и отступления от плана**

- S3-хранилище — **SeaweedFS** (Apache 2.0) вместо MinIO (В-36): риски смены лицензии/политики сборок MinIO.
- Вместо внешнего плагина docker-rollout — собственный `ops/rollout.sh` (меньше внешних зависимостей).
- **Traefik 3.6+ обязателен** для Docker Engine 29+: Traefik 3.5 обращается к Docker API 1.24 и получает отказ.
- Версии зафиксированы на проверенных линиях (TypeScript 5.9, NestJS 11, zod 3, Vitest 3), а не на только что
  вышедших мажорных (TypeScript 7, NestJS 12) — обновление отдельной задачей.
- Метрики NATS в Prometheus не собираются (нужен prometheus-nats-exporter) — при развитии мониторинга.

**Известные ограничения**

- Сертификат HTTPS — самоподписанный сертификат Traefik; для сервера — свой сертификат или ACME.
- Задача CI `zero-downtime` скачивает образы из Docker Hub; при его лимитах — использовать зеркало/свой реестр.
- Kamailio/Asterisk/coturn — в Ф5; остальные сервисы (realtime, router, worker, коннекторы) — в своих фазах.

**Как проверить** — см. `README.md`, разделы «Быстрый старт» и «Обновление без остановки».
