# Knights and Castles

Пошаговая browser-игра 20×10, сейчас в режиме single-player (PvP hot-seat / AI / story). Полностью статичная — рендер на canvas, ассеты локальные. Сетевые аккаунты и realtime PvP запланированы на Phase 3/4 (см. [план в `~/.claude/plans/`](#план)).

## Структура

```
KC/
├── packages/
│   ├── game-rules/             # @kc/game-rules — чистые правила (для server-side reuse в Phase 3)
│   │   └── src/
│   │       ├── constants.ts    # UNIT_TYPES, SPELLS, WEAPONS, START_POSITIONS_P1, SAVE_VERSION
│   │       ├── types.ts        # Player, UnitState, BoardLike, Action, GameSnapshot
│   │       ├── board.ts        # insideBoard, manhattan, randomChoice, weightedChoice
│   │       ├── combat.ts       # attackDamage, applyDamageToTarget, computeDamage
│   │       ├── moves.ts        # generateLegalMoves, generateAttackActions + L-attack
│   │       ├── save.ts         # validateSnapshot, readSavedState, writeSnapshot
│   │       └── world.ts        # mutable castle/towers/ruins state (castle col getters)
│   └── web/                    # @kc/web — клиент
│       ├── index.html          # игра (legacy в одном файле, Phase 2 разнесёт по модулям)
│       ├── public/             # ассеты (assets/, tiny-swords/, *.mp3, story.txt)
│       ├── src/
│       │   ├── audio/music.ts  # MusicPlayer (готов к Phase 2 миграции)
│       │   ├── assets/loader.ts
│       │   └── game/           # Unit.ts, Board.ts, ai.ts, ai-config.ts (заготовки Phase 2)
│       └── vite.config.ts
├── marketing/                  # не деплоится — обложки и пресс-материал
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## Что починено в Phase 1 (по аудиту)

- **SEC-001** — fake-auth с паролями plaintext в localStorage **удалён полностью** (HTML модалка, CSS, JS, callsites). Реальная аутентификация — Phase 3 (Cloud Run + Postgres + OAuth, без Firebase).
- **FUNC-001** — AI/story матчи теперь корректно сохраняются и восстанавливаются (`hasContinuableSave`, `restoreSavedState`, `createSaveSnapshot` поддерживают `mode==="ai"`, `currentStoryTask`, `aiDifficulty`, `mapTheme`, `factions`, `sessionWins`). `SAVE_VERSION = 2`.
- **FUNC-002** — лейбл режима в sidebar и в окне победы теперь определяется методом `getGameModeLabel()` (PvP / vs AI: difficulty / Сюжет: название миссии). Hardcoded `"2 Игрока"` остаётся только на одноимённой кнопке меню.
- **FUNC-003** — L-attack (Г-атака рыцарей/конницы) переписана с правильными 8 шахматными смещениями `[±2,±1]` / `[±1,±2]`. Старый битый массив `[[1,0],[1,0],[-1,0],[0,-1]]` не работал как Г.
- **FUNC-004** — текст правил лучника в UI исправлен с `⚔ 2` на `⚔ 3` (синхронизировано с `UNIT_TYPES.archer.damage = 3` в коде).
- **T25** — `validateSerializedUnit` в `game-rules/save.ts` ограничивает восстановленный `damage` сверху (base damage + 10), чтобы не дать накрутить через правку localStorage до server-authoritative валидации в Phase 4.

## Локальная разработка

Требования: **Node 22 LTS**, **pnpm 11+**.

```bash
# Установка зависимостей
pnpm install

# Dev-сервер (Vite, http://localhost:5173)
pnpm dev

# Прод-сборка → packages/web/dist/
pnpm build

# TypeScript typecheck по всему workspace
pnpm typecheck
```

## План

- **Этот файл — Phase 1.** Detailed Phase 1 план: `~/.claude/plans/3-immutable-wind.md`
- **Master-план всех 7 фаз:** `~/.claude/plans/knights-castles-master-plan.md` (refactor → tests/CI → backend → realtime PvP → leaderboard → prod hosting → license + polish)

## Известные ограничения

- Phase 1 — pragmatic delivery: `packages/web/index.html` остаётся monolithic legacy-файлом со всем игровым JS внутри (5700+ строк). Полная разбивка на TS-модули (refactor `KnightsAndCastlesGame` class) запланирована на Phase 2 вместе с тестами и CI.
- Заготовки TS-модулей в `packages/web/src/{game,audio,assets}/` существуют, но **сейчас не используются** клиентом — они будут активированы при Phase 2 разбивке.
- `@kc/game-rules` готов к подключению на сервере в Phase 3 — извлечён, типизирован strict, **не зависит от DOM/canvas**.
- Нет тестов (Phase 2), нет CI (Phase 2), нет деплоя в GCP (Phase 6).

## Лицензии ассетов

См. `packages/web/public/assets/external/horse_sheet_ATTRIBUTION.txt`. Полный license audit (включая Tiny Swords Free Pack) — задача Phase 7.
