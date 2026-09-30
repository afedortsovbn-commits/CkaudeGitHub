#!/usr/bin/env bash
# Сборка образов прикладных сервисов без скачивания чего-либо внутри Docker:
# код собирается на хосте (pnpm, в т.ч. из офлайн-хранилища), затем `pnpm deploy`
# формирует самодостаточный каталог, который копируется в образ.
# Использование: ops/build-images.sh [тег]   (по умолчанию тег dev)
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-${API_TAG:-dev}}"
APPS="${APPS:-api worker router realtime call-control connector-telegram connector-email web mock-selfservice}"
pnpm install --frozen-lockfile ${PNPM_OFFLINE:+--offline} ${PNPM_STORE:+--store-dir "$PNPM_STORE"}
pnpm build
# Медиа (Asterisk, Kamailio) — свои образы из шаблонов конфигурации; обновляются осушением (ops/update-media.sh),
# поэтому тег отдельный от прикладных сервисов. SKIP_MEDIA=1 — не пересобирать.
if [ -z "${SKIP_MEDIA:-}" ]; then
  docker build -q -t "cc/asterisk:${MEDIA_TAG:-dev}" infra/asterisk >/dev/null && echo "собран образ cc/asterisk:${MEDIA_TAG:-dev}"
  docker build -q -t "cc/kamailio:${MEDIA_TAG:-dev}" infra/kamailio >/dev/null && echo "собран образ cc/kamailio:${MEDIA_TAG:-dev}"
fi
# Ресурсы предыдущей версии web (Ф11, 02-архитектура 6.2 п.8): открытые вкладки старой версии подгружают
# модули по хэшированным именам — новый образ хранит и их. Предыдущая версия — PREV_WEB_IMAGE, иначе образ
# работающего сервиса web; переносятся только её собственные ресурсы (список в её version.json), поэтому
# в образе всегда ресурсы текущей и одной предыдущей версии.
keep_previous_web_assets() {
  local dist="$1" img="${PREV_WEB_IMAGE:-}" cid tmp
  if [ -z "$img" ]; then
    cid="$(docker compose -f "${COMPOSE_FILE:-infra/compose/docker-compose.yml}" ps -q web 2>/dev/null | head -1 || true)"
    [ -n "$cid" ] && img="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  fi
  if [ -z "$img" ] || ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "web: предыдущая версия не найдена — ресурсы только текущей сборки"
    return 0
  fi
  tmp="$(mktemp -d)"
  cid="$(docker create "$img")"
  docker cp -q "$cid:/usr/share/nginx/html/assets" "$tmp/assets" 2>/dev/null || true
  docker cp -q "$cid:/usr/share/nginx/html/version.json" "$tmp/version.json" 2>/dev/null || true
  docker rm "$cid" >/dev/null
  node -e '
    const fs = require("fs"), path = require("path");
    const [tmp, dist] = process.argv.slice(1);
    let prev = { version: "?", assets: null };
    try { prev = JSON.parse(fs.readFileSync(path.join(tmp, "version.json"), "utf8")); } catch {}
    const dir = path.join(tmp, "assets");
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => "assets/" + f) : [];
    const own = prev.assets ?? all; // образ до Ф11 — без списка: переносим всё
    let n = 0;
    for (const f of own) {
      const src = path.join(tmp, f), dst = path.join(dist, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.copyFileSync(src, dst); n++; }
    }
    const vf = path.join(dist, "version.json");
    const cur = JSON.parse(fs.readFileSync(vf, "utf8"));
    fs.writeFileSync(vf, JSON.stringify({ ...cur, previous: { version: prev.version, assets: own.length } }, null, 1) + "\n");
    console.log(`web: перенесены ресурсы предыдущей версии ${prev.version}: ${n} файлов`);
  ' "$tmp" "$dist"
  rm -rf "$tmp"
}

for app in $APPS; do
  if [ "$app" = web ]; then
    rm -rf out/web && mkdir -p out/web
    (cd apps/web && APP_VERSION="$TAG" pnpm exec vite build --logLevel warn)
    (cd apps/widget && pnpm exec vite build --logLevel warn)
    cp -r apps/web/dist out/web/dist && cp -r apps/widget/dist out/web/dist/widget && cp infra/docker/web.nginx.conf infra/docker/web-entrypoint.sh out/web/
    keep_previous_web_assets out/web/dist
    docker build -q -f infra/docker/web.Dockerfile -t "cc/web:$TAG" out/web
    echo "собран образ cc/web:$TAG"
    continue
  fi
  rm -rf "out/$app"
  pnpm --filter "@cc/$app" deploy --legacy --prod "out/$app" >/dev/null
  # Только для проверок (ops/zero-downtime-test): дополнительные миграции «версии N+1» в образе api.
  if [ "$app" = api ] && [ -n "${EXTRA_MIGRATIONS_DIR:-}" ]; then
    cp "$EXTRA_MIGRATIONS_DIR"/*.sql "out/$app/node_modules/@cc/db/migrations/"
    echo "api: добавлены миграции из $EXTRA_MIGRATIONS_DIR: $(ls "$EXTRA_MIGRATIONS_DIR" | tr '\n' ' ')"
  fi
  docker build -q -f infra/docker/node-app.Dockerfile --build-arg APP_VERSION="$TAG" -t "cc/$app:$TAG" "out/$app"
  echo "собран образ cc/$app:$TAG"
done
