#!/usr/bin/env bash
# Обновление медиасервера Asterisk без обрыва разговоров — осушением узла (02-архитектура 6.4, M-UPD-02).
#   ops/update-media.sh [узлы…]          — по умолчанию asterisk-1 asterisk-2, по одному
#   MEDIA_TAG=v2 ops/update-media.sh     — новый образ cc/asterisk:<тег>
# Для каждого узла:
#   1. Kamailio переводит узел в «disabled» — новые вызовы идут только на другие узлы;
#   2. ждём, пока на узле не останется каналов (идущие разговоры доживают; звонки операторам из
#      осушаемого узла продолжают идти через Kamailio);
#   3. узел пересоздаётся с новым образом/конфигурацией, ждём готовности;
#   4. Kamailio перечитывает адреса узлов (у нового контейнера может смениться IP) и возвращает узел в работу.
# Если за MAX_DRAIN секунд разговоры не закончились — скрипт останавливается и ждёт решения администратора:
# узел остаётся выключенным, разговоры не обрываются (повторный запуск продолжит).
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.yml}"
MAX_DRAIN="${MAX_DRAIN:-1800}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
if [ $# -gt 0 ]; then NODES=("$@"); else NODES=(asterisk-1 asterisk-2); fi
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
log() { echo "[update-media $(date +%H:%M:%S)] $*"; }
kam() { dc exec -T kamailio kamcmd "$@"; }

channels() {
  dc exec -T "$1" asterisk -rx "core show channels count" 2>/dev/null | awk '/active channel/ {print $1}'
}

for node in "${NODES[@]}"; do
  uri="sip:${node}:5060"
  log "$node: осушение — новые вызовы направляются на другие узлы"
  kam dispatcher.set_state d 1 "$uri" >/dev/null
  deadline=$((SECONDS + MAX_DRAIN))
  last=""
  while :; do
    n="$(channels "$node" || echo "?")"
    [ "$n" = "0" ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      log "$node: через ${MAX_DRAIN} с ещё идут разговоры ($n каналов) — узел оставлен выключенным, требуется решение администратора"
      exit 2
    fi
    [ "$n" != "$last" ] && log "$node: активных каналов: $n, ждём завершения разговоров" && last="$n"
    sleep 2
  done
  log "$node: разговоров нет, обновление узла"
  dc up -d --no-deps --force-recreate "$node" >/dev/null 2>&1
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  cid="$(dc ps -q "$node")"
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = healthy ]; do
    [ "$SECONDS" -lt "$deadline" ] || { log "$node: не стал healthy — остаётся выключенным"; exit 1; }
    sleep 1
  done
  # Новый контейнер может получить другой IP: dispatcher перечитывает список (адреса разрешаются заново).
  kam dispatcher.reload >/dev/null
  kam dispatcher.set_state ap 1 "$uri" >/dev/null
  log "$node: обновлён ($(docker inspect -f '{{.Config.Image}}' "$cid")), снова принимает вызовы"
done
log "готово"
