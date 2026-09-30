#!/usr/bin/env bash
# Демо-стенд MVP одной командой (Ф12): демо-данные (оргструктура, сотрудники, темы, IVR «сеть АЗС», боты, шаблоны,
# база знаний, интеграции) и заглушки внешних систем (Telegram Bot API, почта GreenMail, SIP-транк, самообслуживание
# и LLM). Сценарий показа — docs/сценарий-демонстрации.md.
#   ops/demo.sh up      — собрать образы (если их нет) и запустить стек (по умолчанию)
#   ops/demo.sh reset   — удалить данные стенда и запустить заново с чистыми демо-данными
#   ops/demo.sh check   — автоматически пройти демо-сценарии в браузере (Playwright, e2e)
#   ops/demo.sh down    — остановить стенд (данные сохраняются)
# Переменные: TAG (dev) — тег образов; BOOTSTRAP_ADMIN_PASSWORD (Admin12345!), DEMO_PASSWORD (Demo12345!).
# Только для демонстрации и проверок: на рабочем сервере не запускать (SEED_DEMO, заглушки, известные пароли).
set -euo pipefail
cd "$(dirname "$0")/.."
CMD="${1:-up}"
TAG="${TAG:-dev}"
export API_TAG="$TAG" MEDIA_TAG="${MEDIA_TAG:-$TAG}" MOCK_TELEGRAM_TAG="$TAG"
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-test}" SEED_DEMO=true
export BOOTSTRAP_ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-Admin12345!}" DEMO_PASSWORD="${DEMO_PASSWORD:-Demo12345!}"
# Заглушки внутри контура: webhook Telegram и ссылки в письмах — на Traefik, исходящие звонки — на имитатор транка,
# письма 2-й линии — в GreenMail.
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://traefik}" TRUNK_HOST="${TRUNK_HOST:-trunk-sim:5060}"
export TICKET_SMTP_HOST="${TICKET_SMTP_HOST:-mail}" TICKET_SMTP_PORT="${TICKET_SMTP_PORT:-3025}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.yml}"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

build_if_missing() {
  local missing=0 s
  for s in api worker router realtime call-control connector-telegram connector-email connector-rocketdata web mock-telegram mock-selfservice; do
    docker image inspect "cc/$s:$TAG" >/dev/null 2>&1 || missing=1
  done
  for s in asterisk kamailio; do docker image inspect "cc/$s:$MEDIA_TAG" >/dev/null 2>&1 || missing=1; done
  if [ "$missing" = 1 ]; then
    echo "сборка образов cc/*:$TAG …"
    APPS="api worker router realtime call-control connector-telegram connector-email connector-rocketdata web mock-telegram mock-selfservice" \
      ops/build-images.sh "$TAG"
  fi
}

up() {
  build_if_missing
  dc up -d --wait
  cat <<INFO

Демо-стенд запущен (версия $TAG).
  Интерфейс сотрудников   https://localhost          (самоподписанный сертификат — принять в браузере)
  Софтфон (WSS)           https://localhost:8443     (открыть один раз и принять сертификат)
  Сайт с чатом            https://localhost/widget/demo.html            — чат без бота
                          https://localhost/widget/demo.html?key=demo-webchat-bot   — чат с ботом
  «Клиент звонит»         https://localhost/demo-call  — номер 2000 (IVR «сеть АЗС»), 1000 (сразу в очередь)
  Почта клиентов          GreenMail: SMTP 127.0.0.1:3025, IMAP 127.0.0.1:3143 (без TLS, пароль любой)
  Telegram (мок)          адрес Bot API в настройке бота: http://mock-telegram:3000
                          клиент пишет: curl -X POST http://127.0.0.1:8081/__test/<токен>/message \\
                            -H 'content-type: application/json' -d '{"chatId":1001,"text":"Здравствуйте","firstName":"Иван"}'

Вход (пароль сотрудников — $DEMO_PASSWORD):
  admin@cc.local / $BOOTSTRAP_ADMIN_PASSWORD   администратор
  supervisor@demo.local                         супервизор (область — только предприятие «Север»)
  operator1@demo.local … operator3@demo.local  операторы
  resp1@demo.local … resp4@demo.local, curator1@demo.local, curator2@demo.local — 2-я линия

Сценарий показа: docs/сценарий-демонстрации.md; автоматический прогон: ops/demo.sh check
INFO
}

case "$CMD" in
  up) up ;;
  reset)
    dc down -v --remove-orphans
    up
    ;;
  down) dc stop ;;
  check)
    cd e2e
    E2E_ADMIN_PASSWORD="$BOOTSTRAP_ADMIN_PASSWORD" E2E_DEMO_PASSWORD="$DEMO_PASSWORD" \
      pnpm exec playwright test --grep "демо-сценарий"
    ;;
  *)
    echo "команды: up | reset | check | down" >&2
    exit 1
    ;;
esac
