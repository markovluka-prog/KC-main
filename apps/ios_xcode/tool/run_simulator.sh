#!/usr/bin/env bash
# Собирает приложение и запускает его в iOS-симуляторе.
#   tool/run_simulator.sh                 — игра пересобирается, симулятор «iPhone 15» (или первый доступный iPhone)
#   tool/run_simulator.sh --skip-web      — не пересобирать веб-игру
#   tool/run_simulator.sh --open          — только создать проект и открыть в Xcode
#   SIM="iPhone 15 Pro" tool/run_simulator.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_WEB=0; OPEN=0
for a in "$@"; do case "$a" in --skip-web) SKIP_WEB=1;; --open) OPEN=1;; esac; done

command -v xcodebuild >/dev/null || { echo "Нужен Xcode (xcode-select --install и установка из App Store)"; exit 1; }
if ! command -v xcodegen >/dev/null; then
  command -v brew >/dev/null || { echo "Установите Homebrew или xcodegen вручную: https://github.com/yonaskolb/XcodeGen"; exit 1; }
  brew install xcodegen
fi

[ "$SKIP_WEB" = 1 ] && [ -d Resources/www ] || tool/sync_web.sh

echo "→ генерация KnightsCastles.xcodeproj"
xcodegen generate --quiet
if [ "$OPEN" = 1 ]; then open KnightsCastles.xcodeproj; exit 0; fi

# Выбор симулятора: по имени (SIM) или первый доступный iPhone.
SIM="${SIM:-iPhone 15}"
UDID="$(xcrun simctl list devices available | grep -F "$SIM (" | head -1 | grep -oE '[0-9A-F-]{36}' || true)"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available | grep -E "iPhone" | head -1 | grep -oE '[0-9A-F-]{36}' || true)"
fi
[ -n "$UDID" ] || { echo "Нет доступных iPhone-симуляторов: Xcode → Settings → Platforms → скачать iOS"; exit 1; }
echo "→ симулятор: $UDID"

xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator --args -CurrentDeviceUDID "$UDID"

echo "→ сборка"
xcodebuild -project KnightsCastles.xcodeproj -scheme KnightsCastles -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO -quiet build

APP="$(find build/Build/Products -maxdepth 2 -name 'KnightsCastles.app' | head -1)"
echo "→ установка и запуск"
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" com.markovluka.knightsandcastles
echo "Готово: игра запущена в симуляторе."
