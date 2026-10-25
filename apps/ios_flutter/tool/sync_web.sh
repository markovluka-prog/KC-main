#!/usr/bin/env bash
# Собирает веб-игру и кладёт её внутрь Flutter-приложения (assets/www).
# Запускать из apps/ios_flutter после каждого изменения игры.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"

echo "→ сборка веб-игры"
( cd "$ROOT" && pnpm --filter @kc/game-rules build && pnpm --filter @kc/web build )

echo "→ копирование в assets/www"
rm -rf assets/www && mkdir -p assets/www
cp -R "$ROOT/packages/web/dist/." assets/www/
# Инструменты разработчика в приложение не нужны.
rm -f assets/www/map-editor.html assets/www/map-preview.html assets/www/sprite-preview.html

echo "→ список папок в pubspec.yaml (Flutter не заходит в подпапки сам)"
python3 - <<'PY'
import os, re
dirs = sorted(d for d, _, fs in os.walk('assets/www') if fs)
block = "  # ASSETS-BEGIN (генерируется tool/sync_web.sh — не править вручную)\n  assets:\n"
block += "".join(f"    - {d}/\n" for d in dirs)
block += "  # ASSETS-END"
src = open('pubspec.yaml', encoding='utf-8').read()
src = re.sub(r"  # ASSETS-BEGIN.*?# ASSETS-END", block, src, flags=re.S)
open('pubspec.yaml', 'w', encoding='utf-8').write(src)
print(f"  папок: {len(dirs)}")
PY
du -sh assets/www
