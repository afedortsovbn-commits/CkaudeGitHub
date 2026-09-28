#!/bin/sh
# Корректная остановка статики (как у прикладных сервисов, 02-архитектура 6.2):
# SIGTERM → /healthz отвечает 503 (Traefik снимает экземпляр) → пауза → плавное завершение nginx,
# не дольше SHUTDOWN_TIMEOUT_S, затем быстрое завершение.
nginx -g 'daemon off;' &
PID=$!
stop() {
  touch /tmp/draining
  sleep "${DRAIN_DELAY_S:-3}"
  nginx -s quit
  i=0
  while kill -0 "$PID" 2>/dev/null && [ "$i" -lt "$(( ${SHUTDOWN_TIMEOUT_S:-5} * 2 ))" ]; do sleep 0.5; i=$((i + 1)); done
  kill -TERM "$PID" 2>/dev/null
  wait "$PID"
  exit 0
}
trap stop TERM INT
wait "$PID"
