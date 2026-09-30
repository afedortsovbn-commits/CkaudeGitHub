# Статика веб-приложения. Контекст — apps/web/dist (собирается на хосте, без сети внутри Docker).
ARG NGINX_IMAGE=nginx:1.29-alpine
FROM ${NGINX_IMAGE}
COPY web.nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/
COPY --chmod=755 web-entrypoint.sh /web-entrypoint.sh
# Как у прикладных сервисов (Ф11): часто при старте, затем раз в 10 с; остановку отслеживает проверка Traefik.
HEALTHCHECK --interval=10s --start-interval=1s --start-period=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/web-entrypoint.sh"]
