#!/usr/bin/env bash
# Держит dev-сервер игры живым в Codespace: перезапускает при падении,
# делает порт 5173 публичным и раз в несколько минут «стучится» на публичный адрес.
# Запуск:  setsid nohup scripts/dev-keepalive.sh >/tmp/kc-keepalive.log 2>&1 &
cd "$(dirname "$0")/../packages/web" || exit 1
PORT=5173
URL="https://${CODESPACE_NAME:-local}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}/"
tick=0
while true; do
  if ! curl -fs -o /dev/null "http://localhost:${PORT}/"; then
    echo "$(date -Is) сервер не отвечает — запускаю vite"
    setsid nohup npx vite --host 0.0.0.0 --port "$PORT" --strictPort >/tmp/vite-kc.log 2>&1 </dev/null &
    sleep 10
    [ -n "$CODESPACE_NAME" ] && gh codespace ports visibility "${PORT}:public" -c "$CODESPACE_NAME" >/dev/null 2>&1
  fi
  tick=$((tick + 1))
  # раз в ~4 минуты — обращение к публичному адресу (трафик через проброс портов)
  if [ $((tick % 8)) -eq 0 ] && [ -n "$CODESPACE_NAME" ]; then curl -s -o /dev/null "$URL"; fi
  sleep 30
done
