# Рыцари и Замки — Xcode-проект (iOS, симулятор)

Нативная оболочка на Swift: `WKWebView` + встроенный локальный сервер (127.0.0.1:8765).
Игра лежит внутри приложения (`Resources/www`) и работает **без интернета**.

## Запуск в симуляторе (Mac с Xcode)
```bash
cd apps/ios_xcode
tool/run_simulator.sh
```
Скрипт сам: ставит `xcodegen` (через Homebrew), собирает веб-игру, создаёт
`KnightsCastles.xcodeproj`, запускает симулятор, собирает и устанавливает приложение.

| Команда | Что делает |
|---|---|
| `tool/run_simulator.sh` | полный цикл: игра → проект → симулятор |
| `tool/run_simulator.sh --skip-web` | без пересборки игры (быстрее) |
| `tool/run_simulator.sh --open` | только создать проект и открыть в Xcode (дальше ▶ Run) |
| `SIM="iPhone 15 Pro" tool/run_simulator.sh` | выбрать другой симулятор |

Инспектор: Safari → Develop → Simulator → страница игры (в Debug-сборке).

## Для App Store
1. `tool/run_simulator.sh --open`, в Xcode: Runner → Signing & Capabilities → ваша Team.
2. Product → Archive → Distribute App (подробнее — `../ios_flutter/APPSTORE.md`, шаги 3–7).

## Структура
- `project.yml` — описание проекта (XcodeGen), `.xcodeproj` из него генерируется
- `Sources/` — `AppDelegate`, `GameViewController`, `LocalServer`, `Info.plist`
- `Resources/` — иконка, `PrivacyInfo.xcprivacy`, `www/` (создаётся `tool/sync_web.sh`)
