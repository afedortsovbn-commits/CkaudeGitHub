#!/usr/bin/env bash
# Сборка образов прикладных сервисов без скачивания чего-либо внутри Docker:
# код собирается на хосте (pnpm, в т.ч. из офлайн-хранилища), затем `pnpm deploy`
# формирует самодостаточный каталог, который копируется в образ.
# Использование: ops/build-images.sh [тег]   (по умолчанию тег dev)
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-${API_TAG:-dev}}"
APPS="${APPS:-api worker router realtime call-control connector-telegram connector-email web}"
pnpm install --frozen-lockfile ${PNPM_OFFLINE:+--offline} ${PNPM_STORE:+--store-dir "$PNPM_STORE"}
pnpm build
# Медиа (Asterisk, Kamailio) — свои образы из шаблонов конфигурации; обновляются осушением (ops/update-media.sh),
# поэтому тег отдельный от прикладных сервисов. SKIP_MEDIA=1 — не пересобирать.
if [ -z "${SKIP_MEDIA:-}" ]; then
  docker build -q -t "cc/asterisk:${MEDIA_TAG:-dev}" infra/asterisk >/dev/null && echo "собран образ cc/asterisk:${MEDIA_TAG:-dev}"
  docker build -q -t "cc/kamailio:${MEDIA_TAG:-dev}" infra/kamailio >/dev/null && echo "собран образ cc/kamailio:${MEDIA_TAG:-dev}"
fi
for app in $APPS; do
  if [ "$app" = web ]; then
    rm -rf out/web && mkdir -p out/web
    (cd apps/web && APP_VERSION="$TAG" pnpm exec vite build --logLevel warn)
    (cd apps/widget && pnpm exec vite build --logLevel warn)
    cp -r apps/web/dist out/web/dist && cp -r apps/widget/dist out/web/dist/widget && cp infra/docker/web.nginx.conf infra/docker/web-entrypoint.sh out/web/
    docker build -q -f infra/docker/web.Dockerfile -t "cc/web:$TAG" out/web
    echo "собран образ cc/web:$TAG"
    continue
  fi
  rm -rf "out/$app"
  pnpm --filter "@cc/$app" deploy --legacy --prod "out/$app" >/dev/null
  docker build -q -f infra/docker/node-app.Dockerfile --build-arg APP_VERSION="$TAG" -t "cc/$app:$TAG" "out/$app"
  echo "собран образ cc/$app:$TAG"
done
