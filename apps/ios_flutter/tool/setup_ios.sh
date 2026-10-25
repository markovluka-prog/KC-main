#!/usr/bin/env bash
# Один раз на Mac: создаёт папку ios/ и настраивает её под App Store.
# Нужны: Xcode, Flutter (flutter doctor без ошибок), CocoaPods.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID="${BUNDLE_ID:-com.markovluka.knightsandcastles}"

flutter create --platforms=ios --org "${BUNDLE_ID%.*}" --project-name knights_castles .
PLIST=ios/Runner/Info.plist
PB=/usr/libexec/PlistBuddy
set_plist() { $PB -c "Set :$1 $2" "$PLIST" 2>/dev/null || $PB -c "Add :$1 ${3:-string} $2" "$PLIST"; }

set_plist CFBundleDisplayName "Рыцари и Замки"
set_plist UIRequiresFullScreen true bool
set_plist UIStatusBarHidden true bool
set_plist ITSAppUsesNonExemptEncryption false bool   # нет своего шифрования → без экспорт-анкеты

# Только горизонтальная ориентация.
$PB -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
$PB -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
$PB -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationLandscapeLeft" "$PLIST"
$PB -c "Add :UISupportedInterfaceOrientations:1 string UIInterfaceOrientationLandscapeRight" "$PLIST"
$PB -c "Delete :UISupportedInterfaceOrientations~ipad" "$PLIST" 2>/dev/null || true
$PB -c "Add :UISupportedInterfaceOrientations~ipad array" "$PLIST"
$PB -c "Add :UISupportedInterfaceOrientations~ipad:0 string UIInterfaceOrientationLandscapeLeft" "$PLIST"
$PB -c "Add :UISupportedInterfaceOrientations~ipad:1 string UIInterfaceOrientationLandscapeRight" "$PLIST"

# Встроенный сервер слушает localhost по http — это разрешаем, остальное остаётся под ATS.
$PB -c "Delete :NSAppTransportSecurity" "$PLIST" 2>/dev/null || true
$PB -c "Add :NSAppTransportSecurity dict" "$PLIST"
$PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST"

cp ios_extras/PrivacyInfo.xcprivacy ios/Runner/PrivacyInfo.xcprivacy
echo "Добавьте ios/Runner/PrivacyInfo.xcprivacy в таргет Runner в Xcode (File → Add Files…)."

# Минимальная версия iOS для flutter_inappwebview.
sed -i '' 's/^# platform :ios.*/platform :ios, "14.0"/' ios/Podfile 2>/dev/null || true

flutter pub get
dart run flutter_launcher_icons
echo "Готово. Дальше: tool/sync_web.sh, затем flutter run, потом APPSTORE.md."
