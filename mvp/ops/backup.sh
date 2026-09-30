#!/usr/bin/env bash
# Резервная копия БД и S3-хранилища (M-NFR-06, Ф12) — на работающей системе, без остановки обработки обращений.
#   ops/backup.sh [каталог]        (по умолчанию out/backups/<ГГГГММДД-ччммсс>)
# Переменные:
#   KEEP=N          — оставить N последних копий в out/backups (по умолчанию все)
#   WITH_ENV=0      — не копировать infra/compose/.env (секреты: без SECRETS_KEY из него не расшифровать токены
#                     каналов и 2FA; по умолчанию копируется с правами 600 — храните копию как секрет)
# Состав копии:
#   db.dump        — pg_dump (custom), согласованный снимок БД (MVCC: запись не блокируется)
#   db-rows.txt    — число строк каждой таблицы по самому дампу (для проверки восстановления)
#   s3/            — объекты хранилища и manifest.json (размер и sha256 каждого)
#   backup.json    — версия, миграции, размеры и контрольные суммы
# Проверка копии без влияния на работу: ops/restore.sh --verify <каталог>. PITR и кластер PostgreSQL — позже.
set -euo pipefail
# Копия содержит персональные данные и секреты — доступ только владельцу.
umask 077
cd "$(dirname "$0")/.."
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.yml}"
ENV_FILE="$(dirname "$COMPOSE_FILE")/.env"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
log() { echo "[backup $(date +%H:%M:%S)] $*" >&2; }
DIR="${1:-out/backups/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$DIR/s3"
ABS="$(cd "$DIR" && pwd)"
T0=$(date +%s)

cid="$(dc ps -q api 2>/dev/null | head -1 || true)"
TAG="${API_TAG:-$( [ -n "$cid" ] && docker inspect -f '{{.Config.Image}}' "$cid" | sed 's/.*://' || echo dev)}"

log "БД → $DIR/db.dump"
dc exec -T postgres pg_dump -U cc -d cc -Fc -Z 6 > "$ABS/db.dump"
# Строки по таблицам — из самого дампа (COPY-блоки): эталон для проверки восстановления.
dc exec -T postgres pg_restore --data-only -f - < "$ABS/db.dump" \
  | awk '/^COPY /{t=$2; n=0; next} /^\\\.$/{ if (t != "") print t, n; t=""; next } t != "" {n++}' \
  | sort > "$ABS/db-rows.txt"
MIGRATIONS="$(dc exec -T postgres psql -U cc -d cc -Atc "SELECT coalesce(json_agg(name ORDER BY name), '[]') FROM schema_migrations")"

log "S3-хранилище → $DIR/s3"
S3_RESULT="$(API_TAG="$TAG" dc run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$ABS/s3:/backup" migrate \
  node dist/cli/storage-backup.js export /backup)"

if [ "${WITH_ENV:-1}" = 1 ] && [ -f "$ENV_FILE" ]; then
  install -m 600 "$ENV_FILE" "$ABS/env"
  log "скопирован $ENV_FILE (секреты!)"
fi

node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path");
  const [dir, tag, migrations, s3, t0] = process.argv.slice(1);
  const db = fs.readFileSync(path.join(dir, "db.dump"));
  const rows = fs.readFileSync(path.join(dir, "db-rows.txt"), "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { const [t, n] = l.split(" "); return [t, Number(n)]; });
  const report = {
    createdAt: new Date().toISOString(),
    version: tag,
    migrations: JSON.parse(migrations),
    db: { file: "db.dump", bytes: db.length, sha256: crypto.createHash("sha256").update(db).digest("hex"),
          tables: rows.length, rows: rows.reduce((a, [, n]) => a + n, 0) },
    s3: JSON.parse(s3),
    env: fs.existsSync(path.join(dir, "env")),
    seconds: Math.round(Date.now() / 1000 - Number(t0)),
  };
  fs.writeFileSync(path.join(dir, "backup.json"), JSON.stringify(report, null, 1) + "\n");
  console.log(JSON.stringify(report));
' "$ABS" "$TAG" "$MIGRATIONS" "$(echo "$S3_RESULT" | tail -1)" "$T0"

if [ -n "${KEEP:-}" ]; then
  ls -1d out/backups/*/ 2>/dev/null | sort | head -n "-$KEEP" | while read -r old; do
    log "удаляю старую копию $old"
    rm -rf "$old"
  done
fi
log "готово: $DIR"
