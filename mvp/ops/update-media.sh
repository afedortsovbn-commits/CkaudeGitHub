#!/usr/bin/env bash
# Обновление медиа без обрыва разговоров — осушением узла (02-архитектура 6.4–6.5, M-UPD-02).
#   ops/update-media.sh [узлы…]          — по умолчанию asterisk-1 asterisk-2, по одному
#   ops/update-media.sh coturn-1 coturn-2 — TURN-серверы (класс B)
#   NATS_IMAGE=nats:2.11.x-alpine ops/update-media.sh nats-1 nats-2 nats-3 — кластер NATS (класс A): узлы
#                                          по одному в lame duck mode (клиенты плавно уходят на другие узлы)
#   KAMAILIO_TAG=v2 ops/update-media.sh kamailio — SIP-периметр (класс C, окно ≤ 60 с): пересоздание;
#                                          идущие разговоры продолжаются, браузеры переподключают WSS
#   MEDIA_TAG=v2 ops/update-media.sh     — новый образ cc/asterisk:<тег>
# Asterisk:
#   1. Kamailio переводит узел в «disabled» — новые вызовы идут только на другие узлы;
#   2. ждём, пока на узле не останется каналов (идущие разговоры доживают; звонки операторам из
#      осушаемого узла продолжают идти через Kamailio);
#   3. узел пересоздаётся с новым образом/конфигурацией, ждём готовности;
#   4. Kamailio перечитывает адреса узлов (у нового контейнера может смениться IP) и возвращает узел в работу.
# coturn:
#   1. экземпляр исключается из списка ICE-серверов, который api выдаёт перед каждым вызовом
#      (настройка telephony.turn_disabled — действует сразу);
#   2. ждём, пока на нём не останется TURN-сессий (метрика turn_total_allocations);
#   3. пересоздание, ожидание готовности, возврат в список.
# Если за MAX_DRAIN секунд разговоры не закончились — решение администратора (разговоры не обрываются):
#   в терминале — вопрос (ждать ещё / вернуть узел в работу без обновления / выйти, оставив узел выключенным);
#   без терминала или DRAIN_DECISION=exit — выход с кодом 2, узел остаётся выключенным (повторный запуск
#   продолжит); DRAIN_DECISION=wait — ждать ещё MAX_DRAIN; DRAIN_DECISION=skip — вернуть без обновления.
# Отчёт (JSON): REPORT_FILE, по умолчанию out/releases/media-<дата>.json — по каждому узлу: каналов в начале,
# время осушения, время обновления, образ, итог.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.yml}"
MAX_DRAIN="${MAX_DRAIN:-1800}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
REPORT_FILE="${REPORT_FILE:-out/releases/media-$(date +%Y%m%d-%H%M%S).json}"
if [ $# -gt 0 ]; then NODES=("$@"); else NODES=(asterisk-1 asterisk-2); fi
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
log() { echo "[update-media $(date +%H:%M:%S)] $*"; }
kam() { dc exec -T kamailio kamcmd "$@"; }
REPORT=()
report() { REPORT+=("$1"); }
write_report() {
  mkdir -p "$(dirname "$REPORT_FILE")"
  local IFS=,
  echo "{\"finishedAt\":\"$(date -Iseconds)\",\"maxDrainS\":$MAX_DRAIN,\"nodes\":[${REPORT[*]}]}" >"$REPORT_FILE"
  log "отчёт: $REPORT_FILE"
}
trap write_report EXIT

api_cid() { dc ps -q api | head -1; }
# Служебные команды api (вывод coturn из выдачи ICE) — образом работающего api.
ops_cli() {
  local tag
  tag="$(docker inspect -f '{{.Config.Image}}' "$(api_cid)" | sed 's/.*://')"
  API_TAG="$tag" dc run --rm --no-deps -T migrate node dist/cli/release-ops.js "$@"
}

asterisk_load() {
  dc exec -T "$1" asterisk -rx "core show channels count" 2>/dev/null | awk '/active channel/ {print $1}'
}
# Текущие TURN-сессии экземпляра (Prometheus-экспорт coturn, запрос — из контейнера api в сети cc).
coturn_load() {
  docker exec "$(api_cid)" node -e "
    fetch('http://$1:9641/metrics').then((r) => r.text()).then((t) => {
      const n = t.split('\n').filter((l) => l.startsWith('turn_total_allocations'))
        .reduce((s, l) => s + Number(l.trim().split(/\s+/).pop() || 0), 0);
      console.log(n);
    }).catch(() => console.log('?'));" 2>/dev/null
}

# Ждёт 0 активных сессий на узле; при превышении MAX_DRAIN — решение администратора.
# Возврат: 0 — осушен, 10 — вернуть без обновления.
drain() {
  local node="$1" kind="$2" deadline last="" n decision
  deadline=$((SECONDS + MAX_DRAIN))
  while :; do
    if [ "$kind" = asterisk ]; then n="$(asterisk_load "$node" || echo "?")"; else n="$(coturn_load "$node" || echo "?")"; fi
    [ "$n" = "0" ] && return 0
    if [ "$SECONDS" -ge "$deadline" ]; then
      decision="${DRAIN_DECISION:-}"
      if [ -z "$decision" ] && [ -t 0 ]; then
        echo
        echo "  $node: через ${MAX_DRAIN} с ещё идут разговоры ($n). Разговоры не обрываются. Что делать?"
        echo "    [w] ждать ещё ${MAX_DRAIN} с   [s] вернуть узел в работу без обновления   [e] выйти (узел выключен)"
        read -r -p "  выбор [w/s/e]: " decision
      fi
      case "${decision:-e}" in
        w | wait)
          log "$node: ждём ещё ${MAX_DRAIN} с"
          deadline=$((SECONDS + MAX_DRAIN))
          ;;
        s | skip) return 10 ;;
        *)
          log "$node: через ${MAX_DRAIN} с ещё идут разговоры ($n) — узел оставлен выключенным, требуется решение администратора (повторный запуск продолжит)"
          report "{\"node\":\"$node\",\"kind\":\"$kind\",\"result\":\"drain_timeout\",\"active\":\"$n\"}"
          exit 2
          ;;
      esac
    fi
    [ "$n" != "$last" ] && log "$node: активных сессий: $n, ждём завершения разговоров" && last="$n"
    sleep 2
  done
}

wait_ready() {
  local node="$1" kind="$2" cid deadline
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  cid="$(dc ps -q "$node")"
  while :; do
    if [ "$kind" = asterisk ]; then
      [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = healthy ] && return 0
    else
      [ "$(coturn_load "$node")" != "?" ] && return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 1
  done
}

for node in "${NODES[@]}"; do
  case "$node" in
    asterisk-*) kind=asterisk ;;
    coturn-*) kind=coturn ;;
    kamailio) kind=kamailio ;;
    nats-*) kind=nats ;;
    *) log "неизвестный узел $node (asterisk-N, coturn-N, nats-N или kamailio)"; exit 1 ;;
  esac
  if [ "$kind" = nats ]; then
    # Класс A: lame duck mode (SIGUSR2) — узел перестаёт принимать подключения и плавно закрывает клиентов,
    # те переподключаются к другим узлам; потоки JetStream (R3) продолжают работу на двух узлах.
    t0=$SECONDS
    cid="$(dc ps -q "$node")"
    log "$node: lame duck mode — клиенты переходят на другие узлы кластера"
    docker kill -s SIGUSR2 "$cid" >/dev/null
    timeout "$HEALTH_TIMEOUT" docker wait "$cid" >/dev/null 2>&1 || docker stop -t 10 "$cid" >/dev/null
    dc up -d --no-deps --force-recreate "$node" >/dev/null 2>&1
    cid="$(dc ps -q "$node")"
    deadline=$((SECONDS + HEALTH_TIMEOUT))
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = healthy ]; do
      [ "$SECONDS" -lt "$deadline" ] || { log "$node: не стал healthy"; report "{\"node\":\"$node\",\"kind\":\"nats\",\"result\":\"unhealthy\"}"; exit 1; }
      sleep 1
    done
    image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
    log "$node: обновлён ($image) за $((SECONDS - t0)) с, JetStream готов"
    report "{\"node\":\"$node\",\"kind\":\"nats\",\"result\":\"updated\",\"image\":\"$image\",\"updateS\":$((SECONDS - t0))}"
    continue
  fi
  if [ "$kind" = kamailio ]; then
    # Класс C: осушить нельзя (один экземпляр). Разговоры не затрагиваются (медиа идёт мимо Kamailio,
    # Record-Route — по имени), новые вызовы и регистрации ждут; окно — время до готовности.
    t0=$SECONDS
    log "kamailio: пересоздание (окно: новые вызовы не принимаются, браузеры переподключат WSS)"
    dc up -d --no-deps --force-recreate kamailio >/dev/null 2>&1
    cid="$(dc ps -q kamailio)"
    deadline=$((SECONDS + HEALTH_TIMEOUT))
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = healthy ]; do
      [ "$SECONDS" -lt "$deadline" ] || { log "kamailio: не стал healthy"; report "{\"node\":\"kamailio\",\"kind\":\"kamailio\",\"result\":\"unhealthy\"}"; exit 1; }
      sleep 0.5
    done
    image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
    log "kamailio: готов ($image), окно $((SECONDS - t0)) с"
    report "{\"node\":\"kamailio\",\"kind\":\"kamailio\",\"result\":\"updated\",\"image\":\"$image\",\"windowS\":$((SECONDS - t0))}"
    continue
  fi
  t0=$SECONDS
  if [ "$kind" = asterisk ]; then
    uri="sip:${node}:5060"
    start_load="$(asterisk_load "$node" || echo "?")"
    log "$node: осушение ($start_load каналов) — новые вызовы направляются на другие узлы"
    kam dispatcher.set_state d 1 "$uri" >/dev/null
  else
    start_load="$(coturn_load "$node" || echo "?")"
    log "$node: вывод из выдачи ICE-серверов ($start_load TURN-сессий) — новые вызовы его не используют"
    ops_cli turn disable "$node" >/dev/null
  fi
  rc=0
  drain "$node" "$kind" || rc=$?
  drain_s=$((SECONDS - t0))
  if [ "$rc" = 10 ]; then
    log "$node: возвращается в работу без обновления (решение администратора)"
    if [ "$kind" = asterisk ]; then kam dispatcher.set_state ap 1 "$uri" >/dev/null; else ops_cli turn enable "$node" >/dev/null; fi
    report "{\"node\":\"$node\",\"kind\":\"$kind\",\"result\":\"skipped\",\"atStart\":\"$start_load\",\"drainS\":$drain_s}"
    continue
  fi
  log "$node: сессий нет (осушение ${drain_s} с), обновление узла"
  t1=$SECONDS
  dc up -d --no-deps --force-recreate "$node" >/dev/null 2>&1
  if ! wait_ready "$node" "$kind"; then
    log "$node: не стал готов за ${HEALTH_TIMEOUT} с — остаётся выключенным"
    report "{\"node\":\"$node\",\"kind\":\"$kind\",\"result\":\"unhealthy\",\"atStart\":\"$start_load\",\"drainS\":$drain_s}"
    exit 1
  fi
  cid="$(dc ps -q "$node")"
  if [ "$kind" = asterisk ]; then
    # Новый контейнер может получить другой IP: dispatcher перечитывает список (адреса разрешаются заново).
    kam dispatcher.reload >/dev/null
    kam dispatcher.set_state ap 1 "$uri" >/dev/null
  else
    ops_cli turn enable "$node" >/dev/null
  fi
  image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
  log "$node: обновлён ($image) за $((SECONDS - t1)) с, снова принимает вызовы"
  report "{\"node\":\"$node\",\"kind\":\"$kind\",\"result\":\"updated\",\"image\":\"$image\",\"atStart\":\"$start_load\",\"drainS\":$drain_s,\"updateS\":$((SECONDS - t1))}"
done
log "готово"
