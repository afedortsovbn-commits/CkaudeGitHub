#!/usr/bin/env bash
# Публикация всех образов в собственный реестр внутри контура (например, registry:2 или Harbor).
#   ops/mirror/push-registry.sh registry.local:5000
# После этого в .env: POSTGRES_IMAGE=registry.local:5000/postgres:16-alpine и т.д.
set -euo pipefail
cd "$(dirname "$0")/../.."
REG="${1:?укажите адрес реестра}"
docker compose -f infra/compose/docker-compose.yml --profile observability config --images | sort -u | while read -r img; do
  name="${img#docker.io/}"; name="${name#library/}"
  docker tag "$img" "$REG/$name" && docker push -q "$REG/$name" && echo "→ $REG/$name"
done
