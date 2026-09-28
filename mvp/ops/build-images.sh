#!/usr/bin/env bash
# Сборка образов прикладных сервисов без скачивания чего-либо внутри Docker:
# код собирается на хосте (pnpm, в т.ч. из офлайн-хранилища), затем `pnpm deploy`
# формирует самодостаточный каталог, который копируется в образ.
# Использование: ops/build-images.sh [тег]   (по умолчанию тег dev)
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-${API_TAG:-dev}}"
APPS="${APPS:-api web}"
pnpm install --frozen-lockfile ${PNPM_OFFLINE:+--offline} ${PNPM_STORE:+--store-dir "$PNPM_STORE"}
pnpm build
for app in $APPS; do
  if [ "$app" = web ]; then
    rm -rf out/web && mkdir -p out/web
    (cd apps/web && APP_VERSION="$TAG" pnpm exec vite build --logLevel warn)
    cp -r apps/web/dist out/web/dist && cp infra/docker/web.nginx.conf infra/docker/web-entrypoint.sh out/web/
    docker build -q -f infra/docker/web.Dockerfile -t "cc/web:$TAG" out/web
    echo "собран образ cc/web:$TAG"
    continue
  fi
  rm -rf "out/$app"
  pnpm --filter "@cc/$app" deploy --legacy --prod "out/$app" >/dev/null
  docker build -q -f infra/docker/node-app.Dockerfile --build-arg APP_VERSION="$TAG" -t "cc/$app:$TAG" "out/$app"
  echo "собран образ cc/$app:$TAG"
done
