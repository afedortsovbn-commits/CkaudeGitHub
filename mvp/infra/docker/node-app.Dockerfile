# Образ прикладного сервиса. Контекст сборки — результат `pnpm deploy` (ops/build-images.sh),
# поэтому внутри образа ничего не скачивается: сборка работает без интернета (M-NFR-10).
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node . .
USER node
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
ARG ENTRY=dist/main.js
ENV ENTRY=${ENTRY}
# Готовность = /readyz; во время корректной остановки контейнер становится unhealthy. Запросы с экземпляра
# снимает проверка Traefik (/readyz раз в секунду, метки сервиса), поэтому здесь допускаются 3 неудачи подряд:
# под нагрузкой отдельная проверка может не уложиться в таймаут — это не повод считать экземпляр неисправным (Ф11).
HEALTHCHECK --interval=2s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["sh", "-c", "exec node $ENTRY"]
