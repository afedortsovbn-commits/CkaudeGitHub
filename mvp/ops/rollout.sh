#!/usr/bin/env bash
# Поэтапное обновление сервиса без остановки обработки (02-архитектура, 6.2).
#   ops/rollout.sh <сервис>            — например: API_TAG=v2 ops/rollout.sh api
# Алгоритм:
#   1. поднимаются N новых экземпляров (новый образ/конфигурация) рядом с N старыми;
#   2. ждём, пока все новые станут healthy (готовность /readyz) — Traefik начинает слать им трафик;
#   3. старые экземпляры по одному получают SIGTERM: readiness → 503, пауза, завершение текущих
#      запросов и задач, закрытие соединений (service-kit Lifecycle); затем удаляются.
# Собственная реализация вместо внешнего плагина — меньше внешних зависимостей (M-NFR-10).
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE="${1:?укажите сервис}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.yml}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
STOP_TIMEOUT="${STOP_TIMEOUT:-35}"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
log() { echo "[rollout $(date +%H:%M:%S)] $*"; }

mapfile -t OLD < <(dc ps -q "$SERVICE")
COUNT=${#OLD[@]}
if [ "$COUNT" -eq 0 ]; then
  log "сервис $SERVICE не запущен — обычный запуск"
  dc up -d --no-deps "$SERVICE"
  exit 0
fi
log "$SERVICE: работает $COUNT экз., поднимаю ещё $COUNT новой версии"
dc up -d --no-deps --no-recreate --scale "$SERVICE=$((COUNT * 2))" "$SERVICE" >/dev/null 2>&1

mapfile -t ALL < <(dc ps -q "$SERVICE")
NEW=()
for c in "${ALL[@]}"; do
  [[ " ${OLD[*]} " == *" $c "* ]] || NEW+=("$c")
done
if [ "${#NEW[@]}" -ne "$COUNT" ]; then
  log "ошибка: ожидалось $COUNT новых экземпляров, получено ${#NEW[@]}"; exit 1
fi

deadline=$((SECONDS + HEALTH_TIMEOUT))
for c in "${NEW[@]}"; do
  while :; do
    st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c")
    [ "$st" = healthy ] && break
    # «unhealthy» у только что запущенного экземпляра — ещё не отказ: под нагрузкой старт может занять больше
    # start-period, а статус станет healthy после первой успешной проверки. Отказ — остановка контейнера
    # или истечение HEALTH_TIMEOUT.
    running=$(docker inspect -f '{{.State.Running}}' "$c")
    if [ "$running" != true ] || [ "$SECONDS" -ge "$deadline" ]; then
      log "новый экземпляр ${c:0:12} не стал healthy ($st за ${HEALTH_TIMEOUT} с) — откат: удаляю новые, старые продолжают работать"
      log "  последние строки журнала нового экземпляра:"
      docker logs --tail 20 "$c" 2>&1 | sed 's/^/    /' || true
      docker stop -t "$STOP_TIMEOUT" "${NEW[@]}" >/dev/null; docker rm "${NEW[@]}" >/dev/null
      exit 1
    fi
    sleep 1
  done
  log "новый экземпляр ${c:0:12} готов ($(docker inspect -f '{{.Config.Image}}' "$c"))"
done
# Балансировщик проверяет готовность раз в секунду — даём ему включить новые экземпляры.
sleep 2

for c in "${OLD[@]}"; do
  log "останавливаю старый экземпляр ${c:0:12} (корректная остановка до ${STOP_TIMEOUT} с)"
  t0=$SECONDS
  docker stop -t "$STOP_TIMEOUT" "$c" >/dev/null
  code=$(docker inspect -f '{{.State.ExitCode}}' "$c")
  log "  остановлен за $((SECONDS - t0)) с, код выхода $code"
  if [ "$code" != 0 ]; then
    STOP_WARN=1
    log "  последние строки журнала старого экземпляра:"
    docker logs --tail 30 "$c" 2>&1 | sed 's/^/    /' || true
  fi
  docker rm "$c" >/dev/null
done
[ -z "${STOP_WARN:-}" ] || { log "ОШИБКА: не все старые экземпляры завершились корректно (см. логи)"; exit 3; }
log "готово: $SERVICE обновлён, экземпляров: $(dc ps -q "$SERVICE" | wc -l)"
