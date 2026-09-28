#!/usr/bin/env bash
# Офлайн-комплект (M-NFR-10): всё, что нужно для установки и сборки без интернета.
#   ops/mirror/export.sh [каталог]   (по умолчанию offline-bundle/)
# Состав: images.tar — все Docker-образы из compose (инфраструктура + собранные cc/*);
#         pnpm-store/ — все npm-пакеты по pnpm-lock.yaml; images.txt — список образов.
# Перенос: скопировать каталог и репозиторий на сервер без интернета и выполнить ops/mirror/import.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-offline-bundle}"
mkdir -p "$OUT"
# Образы из compose + базовые образы для пересборки приложений без интернета.
{
  docker compose -f infra/compose/docker-compose.yml --profile observability config --images
  echo "${NODE_IMAGE:-node:22-alpine}"
  echo "${NGINX_IMAGE:-nginx:1.29-alpine}"
  # Базы образов медиа (infra/asterisk, infra/kamailio) — чтобы пересобирать их без интернета.
  echo "${ASTERISK_IMAGE:-andrius/asterisk:22}"
  echo "${KAMAILIO_RPMS_IMAGE:-kamailio/kamailio-store:6.0.5-centos-9.amd64}"
  echo "${BASE_IMAGE:-almalinux:9}"
} | sort -u > "$OUT/images.txt"
echo "образов: $(wc -l < "$OUT/images.txt")"
if [ -z "${SKIP_IMAGES:-}" ]; then
  while read -r img; do
    [[ "$img" == cc/* ]] || docker pull -q "$img" >/dev/null
  done < "$OUT/images.txt"
  docker save -o "$OUT/images.tar" $(cat "$OUT/images.txt")
  echo "образы сохранены: $OUT/images.tar ($(du -h "$OUT/images.tar" | cut -f1))"
fi
# pnpm fetch нужен только lockfile; выполняем его во временном каталоге, чтобы не трогать node_modules.
STORE="$(cd "$OUT" && pwd)/pnpm-store"
TMP="$(mktemp -d)"
cp pnpm-lock.yaml pnpm-workspace.yaml package.json "$TMP/"
(cd "$TMP" && CI=true pnpm fetch --store-dir "$STORE" >/dev/null)
rm -rf "$TMP"
echo "npm-пакеты сохранены: $STORE ($(du -sh "$STORE" | cut -f1))"
