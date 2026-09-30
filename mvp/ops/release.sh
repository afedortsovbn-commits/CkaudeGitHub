#!/usr/bin/env bash
# Выпуск релиза без остановки обработки обращений (02-архитектура 6.6, M-UPD-01..03, Ф11).
#   ops/release.sh <тег>                 — обновить прикладные сервисы до образов cc/<сервис>:<тег>
#   ops/release.sh --rollback <тег>      — откат: повторная поэтапная замена на образы предыдущего релиза
#                                          (миграции не выполняются: схема БД совместима с N-1)
# Переменные:
#   FEATURE_FLAGS="a,b"   — включить фиче-флаги ПОСЛЕ обновления всех экземпляров (новая функциональность)
#   MEDIA_TAG=<тег>       — после прикладных сервисов обновить медиа осушением (ops/update-media.sh);
#   MEDIA_NODES="…"       — какие узлы (по умолчанию asterisk-1 asterisk-2; также coturn-N)
#   SERVICES="…"          — состав и порядок (по умолчанию коннекторы → worker → router → realtime → api →
#                           call-control → web)
#   START_SERVICES="…"    — новые сервисы релиза, которые запустить, если они ещё не работают (например,
#                           connector-rocketdata при выпуске Ф13); прочие незапущенные сервисы пропускаются
#   COMPAT_BASE=<ref>     — ревизия предыдущего релиза для проверки совместимости (по умолчанию — последний
#                           тег release-*, иначе origin/main); SKIP_COMPAT=1 — не проверять (сервер без git)
#   MIGRATION_LOCK_TIMEOUT_MS (5000) — сколько миграция ждёт блокировку, прежде чем повторить (не выстраивает
#                           очередь запросов работающих сервисов за собой)
#   PERSIST_TAGS=0        — не записывать тег в infra/compose/.env (по умолчанию записывается, чтобы
#                           последующий `docker compose up` не вернул старые образы)
#   REPORT_DIR (out/releases) — куда положить JSON-отчёт выпуска
# Шаги: 1) предпроверки (образы, здоровье стека, линтер миграций, совместимость контрактов);
#       2) expand-миграции новой версии (старые экземпляры продолжают работать);
#       3) поэтапная замена сервисов (ops/rollout.sh) — при ошибке выпуск останавливается, работающие
#          экземпляры остаются, отчёт подсказывает откат;
#       4) событие app.version — открытые вкладки предлагают обновиться (обновятся вне звонка, M-OP-11);
#       5) фиче-флаги; 6) медиа (по желанию); 7) журнал выпусков (release_log) и отчёт.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.yml}"
ENV_FILE="$(dirname "$COMPOSE_FILE")/.env"
MODE=release
if [ "${1:-}" = --rollback ]; then MODE=rollback; shift; fi
TAG="${1:?укажите тег образов: ops/release.sh <тег>}"
SERVICES="${SERVICES:-connector-telegram connector-email connector-rocketdata worker router realtime api call-control web}"
REPORT_DIR="${REPORT_DIR:-out/releases}"
export MIGRATION_LOCK_TIMEOUT_MS="${MIGRATION_LOCK_TIMEOUT_MS:-5000}"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
log() { echo "[release $(date +%H:%M:%S)] $*"; }
tagvar() { echo "$(echo "$1" | tr 'a-z-' 'A-Z_')_TAG"; }
now_ms() { date +%s%3N; }
T0=$(now_ms)
STEPS=()
step() { STEPS+=("{\"step\":\"$1\",\"status\":\"$2\",\"ms\":$3${4:+,\"note\":\"$4\"}}"); }
# Служебные команды (журнал, флаги, app.version) выполняет образ api новейшей из двух версий (сервис
# migrate): при выпуске — новой, при откате — текущей (в образе версии до Ф11 этих команд нет).
ops_cli() { API_TAG="$OPS_TAG" dc run --rm --no-deps -T migrate node dist/cli/release-ops.js "$@"; }

running_tag() {
  local cid
  cid="$(dc ps -q "$1" 2>/dev/null | head -1 || true)"
  [ -n "$cid" ] && docker inspect -f '{{.Config.Image}}' "$cid" | sed 's/.*://'
}
PREV_TAG="$(running_tag api || true)"
OPS_TAG="$TAG"
[ "$MODE" = rollback ] && [ -n "$PREV_TAG" ] && OPS_TAG="$PREV_TAG"
log "режим: $MODE, ${PREV_TAG:-?} → $TAG, сервисы: $SERVICES"

# ---------------------------------------------------------------- 1. предпроверки
t=$(now_ms)
missing=()
for s in $SERVICES; do
  docker image inspect "cc/$s:$TAG" >/dev/null 2>&1 || missing+=("cc/$s:$TAG")
done
if [ "${#missing[@]}" -gt 0 ]; then
  log "ОШИБКА: нет образов ${missing[*]} — соберите: ops/build-images.sh $TAG"
  exit 1
fi
# Все экземпляры здоровы; кратковременно «unhealthy» под нагрузкой — ждём восстановления до 60 с.
unhealthy=()
for attempt in $(seq 1 30); do
  unhealthy=()
  for s in $SERVICES; do
    for c in $(dc ps -q "$s" 2>/dev/null); do
      st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c")
      [ "$st" = healthy ] || [ "$st" = running ] || unhealthy+=("$s(${c:0:12}:$st)")
    done
  done
  [ "${#unhealthy[@]}" -eq 0 ] && break
  [ "$attempt" = 1 ] && log "ждём восстановления: ${unhealthy[*]}"
  sleep 2
done
if [ "${#unhealthy[@]}" -gt 0 ]; then
  log "ОШИБКА: стек нездоров до выпуска: ${unhealthy[*]} — обновление без простоя невозможно"
  exit 1
fi
if [ "$MODE" = release ] && [ -z "${SKIP_COMPAT:-}" ]; then
  if git rev-parse --git-dir >/dev/null 2>&1; then
    base_args=()
    [ -n "${COMPAT_BASE:-}" ] && base_args=(--base "$COMPAT_BASE")
    node ops/test/migrations-lint.mjs "${base_args[@]}" || { log "ОШИБКА: линтер миграций"; exit 1; }
    node ops/compat/check.mjs "${base_args[@]}" || { log "ОШИБКА: несовместимые изменения контрактов"; exit 1; }
  else
    log "git недоступен — проверка совместимости выполнена в CI (SKIP_COMPAT)"
  fi
fi
step preflight ok $(($(now_ms) - t))

# ---------------------------------------------------------------- 2. миграции (expand)
RELEASE_ID=""
if [ "$MODE" = release ]; then
  t=$(now_ms)
  log "миграции новой версии (expand, lock_timeout ${MIGRATION_LOCK_TIMEOUT_MS} мс; старые экземпляры работают)"
  if ! API_TAG="$TAG" dc run --rm --no-deps -T -e MIGRATION_LOCK_TIMEOUT_MS migrate; then
    log "ОШИБКА: миграции не выполнены — сервисы не обновлялись"
    exit 1
  fi
  step migrations ok $(($(now_ms) - t))
fi
RELEASE_ID="$( (ops_cli release-start "$TAG" "${PREV_TAG:-}" || true) | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | tail -1)"
[ -n "$RELEASE_ID" ] || log "журнал выпусков недоступен (образ без release-ops) — только файл отчёта"

finish() {
  local status="$1" note="${2:-}"
  local total=$(($(now_ms) - T0))
  local steps
  steps="$(IFS=,; echo "${STEPS[*]}")"
  local report="{\"mode\":\"$MODE\",\"tag\":\"$TAG\",\"prevTag\":\"${PREV_TAG:-}\",\"status\":\"$status\",\"totalMs\":$total,\"steps\":[$steps]${note:+,\"note\":\"$note\"}}"
  mkdir -p "$REPORT_DIR"
  local file="$REPORT_DIR/release-$TAG-$(date +%Y%m%d-%H%M%S).json"
  echo "$report" >"$file"
  [ -n "$RELEASE_ID" ] && ops_cli release-finish "$RELEASE_ID" "$status" "$report" >/dev/null || true
  log "отчёт: $file"
}

# ---------------------------------------------------------------- 3. поэтапная замена
for s in $SERVICES; do
  if [ -z "$(dc ps -q "$s" 2>/dev/null)" ] && [[ " ${START_SERVICES:-} " != *" $s "* ]]; then
    log "$s не запущен — пропуск"
    step "rollout:$s" skipped 0
    continue
  fi
  t=$(now_ms)
  log "── $s → $TAG"
  if ! env "$(tagvar "$s")=$TAG" ops/rollout.sh "$s"; then
    step "rollout:$s" failed $(($(now_ms) - t))
    finish failed "ошибка обновления $s"
    log "ОШИБКА: $s не обновлён (старые экземпляры продолжают работать). Уже обновлённые сервисы работают на $TAG."
    [ -n "${PREV_TAG:-}" ] && log "откат: ops/release.sh --rollback $PREV_TAG"
    exit 1
  fi
  step "rollout:$s" ok $(($(now_ms) - t))
done

# ---------------------------------------------------------------- 4. новая версия интерфейса
if [[ " $SERVICES " == *" web "* ]]; then
  if ops_cli announce-version "$TAG" >/dev/null; then
    log "app.version $TAG — открытые вкладки предложат обновиться (сами обновятся вне звонка)"
  fi
fi

# ---------------------------------------------------------------- 5. фиче-флаги
if [ -n "${FEATURE_FLAGS:-}" ] && [ "$MODE" = release ]; then
  t=$(now_ms)
  ops_cli flags enable "$FEATURE_FLAGS" >/dev/null
  log "включены фиче-флаги: $FEATURE_FLAGS"
  step flags ok $(($(now_ms) - t)) "$FEATURE_FLAGS"
fi

# ---------------------------------------------------------------- 6. медиа
if [ -n "${MEDIA_TAG:-}" ] && [ "$MODE" = release ]; then
  t=$(now_ms)
  # shellcheck disable=SC2086 — список узлов через пробел
  if ! MEDIA_TAG="$MEDIA_TAG" ops/update-media.sh ${MEDIA_NODES:-}; then
    step media failed $(($(now_ms) - t))
    finish failed "осушение/обновление медиа не завершено"
    exit 1
  fi
  step media ok $(($(now_ms) - t)) "$MEDIA_TAG"
fi

# ---------------------------------------------------------------- 7. фиксация тега и отчёт
if [ "${PERSIST_TAGS:-1}" = 1 ]; then
  touch "$ENV_FILE"
  # Теги отдельных сервисов перекрыли бы общий — удаляем их, общий тег — новый.
  sed -i -E '/^(API|WORKER|ROUTER|REALTIME|WEB|CONNECTOR_TELEGRAM|CONNECTOR_EMAIL|CONNECTOR_ROCKETDATA|CALL_CONTROL)_TAG=/d' "$ENV_FILE"
  echo "API_TAG=$TAG" >>"$ENV_FILE"
  if [ -n "${MEDIA_TAG:-}" ] && [ "$MODE" = release ]; then
    sed -i -E '/^MEDIA_TAG=/d' "$ENV_FILE"
    echo "MEDIA_TAG=$MEDIA_TAG" >>"$ENV_FILE"
  fi
  log "тег $TAG записан в $ENV_FILE"
fi
finish "$([ "$MODE" = rollback ] && echo rolled_back || echo succeeded)"
log "готово за $((($(now_ms) - T0) / 1000)) с: $SERVICES → $TAG"
