#!/usr/bin/env bash
# Установка из офлайн-комплекта на сервере без доступа в интернет.
#   ops/mirror/import.sh [каталог]
# Дальше: PNPM_STORE=<каталог>/pnpm-store PNPM_OFFLINE=1 ops/build-images.sh <тег> (если нужна пересборка)
#         docker compose -f infra/compose/docker-compose.yml up -d
set -euo pipefail
cd "$(dirname "$0")/../.."
IN="${1:-offline-bundle}"
[ -f "$IN/images.tar" ] && docker load -i "$IN/images.tar"
pnpm install --offline --frozen-lockfile --store-dir "$IN/pnpm-store"
echo "готово: образы загружены, зависимости установлены без сети"
