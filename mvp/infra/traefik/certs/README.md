Сертификат домена для Traefik (веб-интерфейс, API, виджет): `cert.pem` (сертификат с цепочкой) и `key.pem`
(закрытый ключ, права 600). Файлы в git не хранятся. Подключение — `TRAEFIK_TLS=../traefik/tls-certs.yml`
в `infra/compose/.env`, затем `docker compose -f infra/compose/docker-compose.yml up -d traefik`.
