# Д-097: синтез речи edge-tts (голос «Светлана»). Нужен интернет и при сборке (pip), и при работе (сервис
# Microsoft) — поэтому только профили test/demo; в закрытом контуре — локальный движок (Д-003).
FROM python:3.12-slim
RUN pip install --no-cache-dir edge-tts==7.3.1
WORKDIR /app
COPY server.py .
USER nobody
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"
CMD ["python", "server.py"]
