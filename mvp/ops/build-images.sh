#!/usr/bin/env bash
# Сборка образов прикладных сервисов без скачивания чего-либо внутри Docker:
# код собирается на хосте (pnpm, в т.ч. из офлайн-хранилища), затем `pnpm deploy`
# формирует самодостаточный каталог, который копируется в образ.
# Использование: ops/build-images.sh [тег]   (по умолчанию тег dev)
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-${API_TAG:-dev}}"
APPS="${APPS:-api}"
pnpm install --frozen-lockfile ${PNPM_OFFLINE:+--offline} ${PNPM_STORE:+--store-dir "$PNPM_STORE"}
pnpm build
for app in $APPS; do
  rm -rf "out/$app"
  pnpm --filter "@cc/$app" deploy --legacy --prod "out/$app" >/dev/null
  docker build -q -f infra/docker/node-app.Dockerfile --build-arg APP_VERSION="$TAG" -t "cc/$app:$TAG" "out/$app"
  echo "собран образ cc/$app:$TAG"
done
