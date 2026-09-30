#!/usr/bin/env bash
# Восстановление из резервной копии ops/backup.sh (M-NFR-06, Ф12).
#   ops/restore.sh --verify <каталог>   — проверка копии без влияния на работу: восстановление во временную БД и
#                                         временный бакет, сверка строк по таблицам и sha256 объектов, удаление
#   ops/restore.sh <каталог>            — полное восстановление (авария): прикладные сервисы останавливаются,
#                                         БД пересоздаётся из копии, объекты загружаются в хранилище, сервисы
#                                         запускаются. Подтверждение — ввод «да» или CONFIRM=yes.
# Переменные: SERVICES — какие сервисы остановить на время восстановления (по умолчанию все прикладные).
# Секреты: SECRETS_KEY и JWT_SECRET должны совпадать с копией (файл env в каталоге копии).
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.yml}"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
log() { echo "[restore $(date +%H:%M:%S)] $*" >&2; }
MODE=full
if [ "${1:-}" = --verify ]; then MODE=verify; shift; fi
DIR="${1:?укажите каталог копии: ops/restore.sh [--verify] <каталог>}"
[ -f "$DIR/db.dump" ] && [ -f "$DIR/s3/manifest.json" ] || { echo "в $DIR нет db.dump или s3/manifest.json" >&2; exit 1; }
ABS="$(cd "$DIR" && pwd)"
SERVICES="${SERVICES:-connector-telegram connector-email worker router realtime api call-control web}"
cid="$(dc ps -q api 2>/dev/null | head -1 || true)"
TAG="${API_TAG:-$( [ -n "$cid" ] && docker inspect -f '{{.Config.Image}}' "$cid" | sed 's/.*://' || echo dev)}"
s3cli() { API_TAG="$TAG" dc run --rm --no-deps -T -v "$ABS/s3:/backup:ro" migrate node dist/cli/storage-backup.js "$@"; }
psql_db() { dc exec -T postgres psql -U cc -d "$1" -v ON_ERROR_STOP=1 -Atq "${@:2}"; }

# Сверка числа строк восстановленной БД с дампом (db-rows.txt) — одним запросом; печатает число расхождений.
check_rows() {
  local db="$1" sql
  sql="$(awk '{ printf "%sSELECT %s AS t, count(*) AS n FROM %s", (NR > 1 ? " UNION ALL " : ""), "\x27" $1 "\x27", $1 }' "$ABS/db-rows.txt")"
  [ -n "$sql" ] || { echo 0; return; }
  psql_db "$db" -F ' ' -c "$sql" < /dev/null | sort > "$ABS/.restored-rows.txt"
  diff "$ABS/db-rows.txt" "$ABS/.restored-rows.txt" | grep '^[<>]' >&2 || true
  comm -3 "$ABS/db-rows.txt" "$ABS/.restored-rows.txt" | wc -l | tr -d ' '
  rm -f "$ABS/.restored-rows.txt"
}

if [ "$MODE" = verify ]; then
  T0=$(date +%s)
  DB=cc_restore_check
  BUCKET="cc-restore-check-$(date +%s)"
  log "БД → временная $DB"
  dc exec -T postgres dropdb -U cc --if-exists --force "$DB"
  dc exec -T postgres createdb -U cc "$DB"
  dc exec -T postgres pg_restore -U cc -d "$DB" --no-owner --exit-on-error < "$ABS/db.dump"
  BAD_ROWS="$(check_rows "$DB")"
  TABLES="$(wc -l < "$ABS/db-rows.txt" | tr -d ' ')"
  dc exec -T postgres dropdb -U cc --force "$DB"
  log "S3 → временный бакет $BUCKET"
  s3cli import /backup "$BUCKET" >/dev/null
  S3V="$(s3cli verify /backup "$BUCKET" | tail -1 || true)"
  s3cli drop "$BUCKET" >/dev/null
  OK=$([ "$BAD_ROWS" = 0 ] && echo "$S3V" | grep -q '"ok":true' && echo true || echo false)
  echo "{\"mode\":\"verify\",\"ok\":$OK,\"tables\":$TABLES,\"tablesMismatched\":$BAD_ROWS,\"s3\":$S3V,\"seconds\":$(( $(date +%s) - T0 ))}"
  [ "$OK" = true ] || exit 2
  log "копия пригодна для восстановления"
  exit 0
fi

if [ "${CONFIRM:-}" != yes ]; then
  read -r -p "Все данные будут заменены копией $DIR, прикладные сервисы остановятся. Введите «да»: " ans
  [ "$ans" = да ] || { echo "отменено"; exit 1; }
fi
T0=$(date +%s)
log "останавливаю прикладные сервисы: $SERVICES"
dc stop $SERVICES
log "пересоздаю БД из копии"
dc exec -T postgres dropdb -U cc --force cc
dc exec -T postgres createdb -U cc cc
dc exec -T postgres pg_restore -U cc -d cc --no-owner --exit-on-error < "$ABS/db.dump"
BAD_ROWS="$(check_rows cc)"
[ "$BAD_ROWS" = 0 ] || { log "восстановлены не все строки ($BAD_ROWS таблиц) — сервисы не запускаю"; exit 2; }
log "загружаю объекты хранилища"
s3cli import /backup >/dev/null
S3V="$(s3cli verify /backup | tail -1)"
echo "$S3V" | grep -q '"ok":true' || { log "объекты хранилища не совпали: $S3V"; exit 2; }
log "запускаю сервисы"
dc start $SERVICES
dc up -d --wait --no-recreate $SERVICES >/dev/null
echo "{\"mode\":\"full\",\"ok\":true,\"s3\":$S3V,\"seconds\":$(( $(date +%s) - T0 ))}"
log "восстановлено из $DIR"
