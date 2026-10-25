#!/usr/bin/env bash
# Собирает веб-игру и кладёт её в Resources/www (она попадёт в приложение).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"

echo "→ сборка веб-игры"
# game-rules отдельно собирать не нужно: веб-сборка берёт его из исходников (alias в vite.config.ts).
( cd "$ROOT" && NODE_OPTIONS="--max-old-space-size=6144" pnpm --filter @kc/web build )

echo "→ копирование в Resources/www"
rm -rf Resources/www && mkdir -p Resources/www
cp -R "$ROOT/packages/web/dist/." Resources/www/
rm -f Resources/www/map-editor.html Resources/www/map-preview.html Resources/www/sprite-preview.html
du -sh Resources/www
