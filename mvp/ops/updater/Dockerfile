# Служба обновления (Д-065): выполняет обновления, подтверждённые администратором в интерфейсе
# («Система → Обновление системы»). Внутри — docker CLI с compose (управляет стеком через /var/run/docker.sock),
# psql (журнал хода в БД), node (скрипты ops/), jq, tar. Скрипты берутся из каталога развёртывания (/deploy).
# Сборка: docker build -t cc/updater:<тег> ops/updater (для закрытого контура образ входит в офлайн-комплект).
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
RUN apk add --no-cache bash coreutils jq tar gzip postgresql16-client docker-cli docker-cli-compose
COPY updater.sh /usr/local/bin/updater.sh
RUN chmod +x /usr/local/bin/updater.sh
WORKDIR /deploy
CMD ["/usr/local/bin/updater.sh"]
