/**
 * Lightweight i18n for the web client (RU default + EN).
 *
 * Design: the Russian source string IS the lookup key (the game was authored in
 * Russian). `t("Ваш ход.")` returns the Russian as-is when lang==='ru', or the
 * English translation from EN when lang==='en' (falling back to the Russian key
 * if a translation is missing). Templates use {name} placeholders filled from
 * the params object, e.g. t("Ход игрока {p}.", { p: 1 }).
 *
 * Names that double as data keys (unit/artifact/weapon/spell names, kept in
 * @kc/game-rules in Russian) are translated for DISPLAY only via the same map —
 * the underlying Russian value stays the inventory/recipe key.
 */
export type Lang = 'ru' | 'en';

const STORAGE_KEY = 'kc_lang';

function detectInitial(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    /* ignore */
  }
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav && typeof nav.language === 'string' && nav.language.toLowerCase().startsWith('en')
    ? 'en'
    : 'ru';
}

let lang: Lang = detectInitial();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  if (next !== 'ru' && next !== 'en') return;
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  listeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* a listener must never break the toggle */
    }
  });
}

export function toggleLang(): void {
  setLang(lang === 'ru' ? 'en' : 'ru');
}

/** Subscribe to language changes (e.g. to re-render the UI). */
export function onLangChange(cb: () => void): void {
  listeners.add(cb);
}

function interpolate(tmpl: string, params?: Record<string, unknown>): string {
  if (!params) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : '{' + k + '}'));
}

/** Translate a Russian source string (optionally with {placeholders}). */
export function t(ru: string, params?: Record<string, unknown>): string {
  const tmpl = lang === 'en' ? (EN[ru] ?? ru) : ru;
  return interpolate(tmpl, params);
}

/**
 * English translations keyed by the Russian source. Missing keys fall back to
 * the Russian source string.
 */
const EN: Record<string, string> = {
  // ── App / menu ────────────────────────────────────────────────────────────
  'Рыцари и Замки': 'Knights & Castles',
  'Выберите режим игры': 'Choose a game mode',
  'Сюжет': 'Campaign',
  '2 игрока': '2 players',
  'Онлайн': 'Online',
  'Начать бой': 'Start battle',
  'Загрузка...': 'Loading...',
  'Слабый': 'Easy',
  'Средний': 'Medium',
  'Сложный': 'Hard',
  'Закрыть': 'Close',
  'В меню': 'Menu',
  'вкл': 'on',
  'выкл': 'off',
  'Продолжить кампанию: {name}': 'Continue campaign: {name}',
  'Партия восстановлена.': 'Game restored.',
  'Управление аккаунтом': 'Account',
  'Войти в аккаунт': 'Sign in',
  'Добро пожаловать, {name}!': 'Welcome, {name}!',
  'игрок': 'player',
  'Вы вышли из аккаунта.': 'Signed out.',
  'Об игре': 'About',
  'Играть': 'Play',
  'Настройки': 'Settings',
  'Правила игры': 'Game rules',
  'Начать обучение': 'Start tutorial',
  'Средневековая пошаговая стратегия для 2 игроков на поле 20×10. Уничтожь войско противника или вынуди его капитулировать.':
    'A medieval turn-based strategy for 2 players on a 20×10 board. Destroy the enemy army or force it to surrender.',
  'Кампания': 'Campaign',
  'Следующий уровень': 'Next level',
  'Глава {n}': 'Chapter {n}',
  'Кампания пройдена': 'Campaign complete',
  'Все главы завершены': 'All chapters complete',
  'Продолжить партию': 'Resume game',
  'Создать комнату': 'Create room',
  'Случайный': 'Random',
  'Играть самому': 'Single player',
  'Новичок': 'Novice',
  'Боец': 'Fighter',
  'Мастер': 'Master',
  '2 Игрока — на одном устройстве': '2 Players — same device',
  'Аккаунт': 'Account',
  'аккаунт · нажмите для управления': 'account · tap to manage',
  'нажмите для входа': 'tap to sign in',
  'Выйти из аккаунта': 'Sign out',
  'Звук': 'Sound',
  'Звук выключен': 'Sound off',
  'Звук включён': 'Sound on',
  'Прогресс кампании': 'Campaign progress',
  'Пройдено': 'Completed',
  'Заблокировано': 'Locked',

  // ── In-game side panel ─────────────────────────────────────────────────────
  'Обучение — шаг {n} / 5': 'Tutorial — step {n} / 5',
  'Завершить обучение': 'Finish tutorial',
  'Игрок {p}': 'Player {p}',
  'ИИ думает': 'AI is thinking',
  'Счёт': 'Score',
  'Режим': 'Mode',
  'Активаций осталось: {n}': 'Activations left: {n}',
  'Отменить': 'Undo',
  'Пропустить ход': 'End turn',
  'Угрозы': 'Threats',
  'Щит {p} активен': '{p} shield active',
  'Небо огня {p} активно': 'Sky of Fire {p} active',
  'Активное заклинание': 'Active spell',
  'Игрок {p} • осталось {n} хода': 'Player {p} • {n} turn(s) left',
  'Игрок {p} • +2 урона • осталось {n} хода': 'Player {p} • +2 damage • {n} turn(s) left',
  'Обязательная экипировка': 'Equipment required',
  'Выберите союзника для {name} (+{n} {unit}).': 'Pick an ally for {name} (+{n} {unit}).',
  'брони': 'armour',
  'урона': 'damage',
  'Выбор только на поле.': 'Choose on the board only.',
  'Подходящих юнитов нет.': 'No suitable units.',
  'Подсвеченные юниты готовы принять предмет.': 'Highlighted units can take the item.',
  'Инвентарь артефактов (Игрок {p})': 'Artifact inventory (Player {p})',
  'Превью юнита': 'Unit preview',
  'к урону': 'to damage',
  'к броне': 'to armor',
  'Закрыть превью': 'Close preview',
  'Выбранный юнит': 'Selected unit',
  'Ходы': 'Moves',
  'Юнит в замке — восстановление до максимума (заканчивает ход)':
    'Unit in its castle — restore to full (ends its turn)',
  'Лечиться в замке': 'Heal in castle',
  'Тянуть артефакт': 'Search ruins',
  'Заклинания': 'Spells',
  'Крафт оружия': 'Craft weapon',
  'Крафт брони': 'Craft armour',
  'Сдаться': 'Surrender',
  'Ход {n}': 'Turn {n}',
  'Реванш': 'Rematch',
  'Рестарт': 'Restart',
  'Сюжет: {name}': 'Campaign: {name}',
  'Сюжет: ': 'Campaign: ',
  'Победа. Вы победили.': 'Victory. You win.',
  'Поражение.': 'Defeat.',
  'Победа. Победил игрок {p}.': 'Victory. Player {p} won.',
  'Ход игрока {p}. Осталось активаций: {n}.': "Player {p}'s turn. Activations left: {n}.",

  // ── Turn flow / unit selection ─────────────────────────────────────────────
  'Ход игрока {p}. Активируйте до {n} юнитов.': "Player {p}'s turn. Activate up to {n} units.",
  'Юнит выбран: {name}. Ходов: {moves}.': 'Unit selected: {name}. Moves: {moves}.',
  'Ходов осталось: {n}.': 'Moves left: {n}.',
  'Выберите юнит. Осталось активаций: {n}.': 'Select a unit. Activations left: {n}.',
  'Можно активировать не более 3 юнитов за ход.': 'You may activate at most 3 units per turn.',
  'У юнита не осталось ходов.': 'This unit has no moves left.',
  '{name} завершил ход.': '{name} finished.',
  '{name} пропускает ход.': '{name} skips its turn.',

  // ── Combat log ─────────────────────────────────────────────────────────────
  '{attacker} атакует {target} на {dmg} урона.': '{attacker} hits {target} for {dmg} damage.',
  '{name} повержен.': '{name} is defeated.',
  '{name} восстановился в замке: {parts}.': '{name} recovered in the castle: {parts}.',

  // ── Gear: weapons / armour / pickup ────────────────────────────────────────
  'Экипируйте {name}{armor} одному из своих юнитов на поле.':
    'Equip {name}{armor} to one of your units on the board.',
  ' (броня)': ' (armour)',
  'Сначала экипируйте {name}. Выберите союзника на поле.':
    'Equip {name} first. Pick an ally on the board.',
  'Сначала экипируйте оружие.': 'Equip the weapon first.',
  'Сначала экипируйте скрафченное оружие.': 'Equip the crafted weapon first.',
  'Выберите подходящего союзника для экипировки оружия.':
    'Pick a suitable ally to equip the weapon.',
  'Нужно выбрать подходящего союзника для экипировки.': 'Pick a suitable ally to equip it.',
  '{name} экипировано юниту {unit} (+{n} урона).': '{name} equipped to {unit} (+{n} damage).',
  '{name} экипировано юниту {unit} (+{n} брони).': '{name} equipped to {unit} (+{n} armour).',
  'Оружие экипировано.': 'Weapon equipped.',
  'Броня экипирована.': 'Armour equipped.',
  '{name} подбирает {item} (+{n} урона).': '{name} picks up {item} (+{n} damage).',
  '{name} подбирает {item} (+{n} брони).': '{name} picks up {item} (+{n} armour).',
  'Найдено оружие': 'Weapon found',
  'Найдена броня': 'Armour found',
  'Скрафчено': 'Crafted',
  'Найден артефакт: {name}.': 'Artifact found: {name}.',
  'В руинах ничего не найдено.': 'Nothing found in the ruins.',
  'Найдено оружие, но некому экипировать. Оружие выброшено.':
    'A weapon was found but no one can wield it. It was dropped.',
  '{label}, но некому экипировать. Выброшено.': '{label}, but no one can take it. Dropped.',
  'Скрафчено оружие, но некому экипировать. Оружие выброшено.':
    'Weapon crafted but no one can wield it. It was dropped.',
  'Скрафчена броня, но некому экипировать. Броня выброшена.':
    'Armour crafted but no one can wear it. It was dropped.',
  'Оружие выброшено.': 'Weapon dropped.',
  'Броня выброшена.': 'Armour dropped.',
  'Юнит должен стоять в руинах.': 'The unit must stand on ruins.',

  // ── Spells / crafting ──────────────────────────────────────────────────────
  'Заклинание: {name}.': 'Spell: {name}.',
  'Заклинания доступны только на башне мага.': 'Spells can only be cast from a mage tower.',
  'Недостаточно артефактов для заклинания.': 'Not enough artifacts for the spell.',
  'Недостаточно артефактов для крафта.': 'Not enough artifacts to craft.',
  'Недостаточно артефактов для крафта брони.': 'Not enough artifacts to craft armour.',
  'Заклинание не нужно — оно ничего не сделает.': 'This spell would have no effect.',
  'Все отряды уже имеют максимальное здоровье.': 'All units are already at full health.',
  'Все отряды уже имеют максимальную броню.': 'All units already have full armour.',
  'Бафф урона уже активен.': 'The damage buff is already active.',

  // ── Win / lose ─────────────────────────────────────────────────────────────
  'Победа игрока 1! Замок захвачен!': 'Player 1 wins! Castle captured!',
  'Победа игрока 2! Замок захвачен!': 'Player 2 wins! Castle captured!',
  'Победа игрока {p}.': 'Player {p} wins.',
  'Победил игрок {p}': 'Player {p} won',
  'Игрок {p} сдался.': 'Player {p} surrendered.',
  'Вы победили!': 'You win!',
  '🏆 Вы победили!': '🏆 You win!',
  '🏆 Победа!': '🏆 Victory!',
  '🏆 Победа': '🏆 Victory',
  'Вы проиграли': 'You lose',
  'Вы проиграли.': 'You lose.',
  'Поражение': 'Defeat',

  // ── Online / lobby ─────────────────────────────────────────────────────────
  'Ваш ход': 'Your turn',
  'Ваш ход.': 'Your turn.',
  'Ход соперника': "Opponent's turn",
  'Ход соперника…': "Opponent's turn…",
  'Сейчас ход соперника.': "It's the opponent's turn.",
  'Ожидание соперника': 'Waiting for opponent',
  'Ожидание соперника…': 'Waiting for opponent…',
  'Подключение к матчу…': 'Connecting to match…',
  'Отправка хода…': 'Sending move…',
  'Не удалось отправить ход. Синхронизация…': 'Failed to send the move. Syncing…',
  'Нет связи с сервером. Переподключение…': 'No server connection. Reconnecting…',
  'Не удалось подключиться к серверу.': 'Could not connect to the server.',
  'Соперник отключился — вы победили!': 'Opponent disconnected — you win!',
  'Матч прерван — поражение.': 'Match aborted — defeat.',
  'Матч прерван.': 'Match aborted.',
  'Ждём соперника для реванша…': 'Waiting for opponent to rematch…',
  'Запрос реванша…': 'Requesting a rematch…',
  'Не удалось запросить реванш.': 'Could not request a rematch.',
  'Не удалось встать в очередь.': 'Could not join the queue.',
  'Не удалось создать комнату.': 'Could not create a room.',
  'Не удалось войти в комнату.': 'Could not join the room.',
  'Введите код комнаты.': 'Enter the room code.',
  'Комната не найдена.': 'Room not found.',
  'Комната уже занята.': 'The room is already taken.',
  'Действие отклонено': 'Action rejected',
  'КОД': 'CODE',
  'Скопировано!': 'Copied!',
  'Игра по сети': 'Online game',
  'Создайте комнату и поделитесь кодом, войдите по коду друга или найдите случайного соперника. Регистрация не нужна.':
    "Create a room and share the code, join with a friend's code, or find a random opponent. No sign-up needed.",
  'Войти по коду': 'Join by code',
  'Случайный соперник': 'Random opponent',
  'Комната создана': 'Room created',
  'Передайте код сопернику:': 'Share the code with your opponent:',
  'Скопировать код': 'Copy code',
  'Отмена': 'Cancel',
  'Введите код комнаты:': 'Enter the room code:',
  'Войти в комнату': 'Join room',
  'Назад': 'Back',
  'Поиск соперника': 'Finding an opponent',
  'Ищем случайного соперника…': 'Searching for a random opponent…',
  'Подключение…': 'Connecting…',
  // ── Auth modal ─────────────────────────────────────────────────────────────
  'Войти': 'Sign in',
  'Зарегистрироваться': 'Sign up',
  'Регистрация': 'Sign up',
  'Введите email и пароль.': 'Enter email and password.',
  'Пароль не короче 8 символов.': 'Password must be at least 8 characters.',
  'Не удалось войти. Попробуйте позже.': 'Sign-in failed. Please try again later.',
  // ── Tutorial ───────────────────────────────────────────────────────────────
  'Привет! Нажми на любого синего воина, чтобы выбрать его.':
    'Hi! Tap any blue warrior to select it.',
  'Отлично! Теперь нажми на зелёную клетку — перемести воина вперёд.':
    'Great! Now tap a green cell — move the warrior forward.',
  'Хорошо! Атакуй врага — нажми на красную клетку.':
    'Good! Attack the enemy — tap a red cell.',
  'Нет атак в досягаемости. Заверши ход — активируй ещё 2 воинов или нажми «Пропустить».':
    'No attacks in range. Finish the turn — activate 2 more warriors or press “End turn”.',
  'Ход соперника — наблюдай как играет ИИ…': "Opponent's turn — watch the AI play…",
  'Ещё раз! Выбери следующего синего воина.': 'Again! Select the next blue warrior.',
  '🏆 Обучение пройдено! Теперь ты знаешь основы. Продолжай играть!':
    '🏆 Tutorial complete! You know the basics now. Keep playing!',

  // ── Misc ───────────────────────────────────────────────────────────────────
  'Счёт сессии:': 'Session score:',
  'Не удалось войти через Google.': 'Could not sign in with Google.',

  // ── In-board tutorial overlay ──────────────────────────────────────────────
  'Обучение — шаг {n} / {total}': 'Tutorial — step {n} / {total}',
  'Понятно': 'Got it',
  'Тапни своего воина, чтобы выбрать его.': 'Tap one of your warriors to select it.',
  'Зелёные клетки — куда можно пойти. Красные — кого можно атаковать; число над врагом показывает урон.':
    'Green cells are where you can move. Red cells are who you can attack; the number above an enemy shows the damage.',
  'За ход активируй до 3 воинов. «↶ Отменить» откатит действие, «⚠ Угрозы» покажет, куда бьёт враг.':
    'Activate up to 3 warriors per turn. “↶ Undo” reverts an action, “⚠ Threats” shows where the enemy can strike.',
  'Цель — уничтожить войско противника или захватить его замок. Удачи!':
    'Your goal: destroy the enemy army or capture its castle. Good luck!',

  // ── Unit names (display only — Russian stays the data key) ─────────────────
  'Рыцарь': 'Knight',
  'Конный': 'Cavalry',
  'Лучник': 'Archer',
  'Катапульта': 'Catapult',
  'Арбалетчик': 'Crossbowman',
  'Самурай': 'Samurai',

  // ── Artifacts ──────────────────────────────────────────────────────────────
  'Трава С.': 'Healing Herb',
  'Посох огня': 'Fire Staff',
  'Волшебная палочка': 'Magic Wand',
  'Солнечные часы': 'Sundial',
  'Вода серебряных трав': 'Silverleaf Water',

  // ── Spells (+ descriptions) ────────────────────────────────────────────────
  'Дождь защиты': 'Rain of Protection',
  '+2 HP всем своим': '+2 HP to all your units',
  'Сталь свободы': 'Steel of Freedom',
  'Восстанавливает до +2 защиты, но не выше стартовой':
    'Restores up to +2 armour (not above the starting value)',
  'Небо огня': 'Sky of Fire',
  '+2 урона всем союзникам на 2 хода (этот + следующий)':
    '+2 damage to all allies for 2 turns (this + next)',

  // ── Weapons / armour (+ descriptions) ──────────────────────────────────────
  'Солнечный меч': 'Sun Sword',
  '+3 урона выбранному юниту': '+3 damage to the chosen unit',
  'Синий лук': 'Azure Bow',
  '+2 урона лучнику': '+2 damage to an archer',
  'Кольчуга': 'Chainmail',
  '+2 брони выбранному юниту': '+2 armour to the chosen unit',
  'Латы': 'Plate Armour',
  '+4 брони выбранному юниту': '+4 armour to the chosen unit',

  // ── Army draft presets ─────────────────────────────────────────────────────
  'Сбалансированный': 'Balanced',
  '6 Рыцарей · 2 Конных · 2 Лучника': '6 Knights · 2 Cavalry · 2 Archers',
  'Тяжёлая пехота': 'Heavy infantry',
  '8 Рыцарей · 2 Лучника': '8 Knights · 2 Archers',
  'Кавалерийский натиск': 'Cavalry charge',
  '6 Конных · 2 Рыцаря · 2 Лучника': '6 Cavalry · 2 Knights · 2 Archers',
  'Лучники': 'Archers',
  '4 Лучника · 4 Рыцаря · 2 Конных': '4 Archers · 4 Knights · 2 Cavalry',
  'Осада': 'Siege',
  '2 Катапульты · 4 Рыцаря · 2 Конных · 2 Лучника': '2 Catapults · 4 Knights · 2 Cavalry · 2 Archers',
  'Арбалетчики': 'Crossbowmen',
  '4 Арбалетчика · 4 Рыцаря · 2 Конных': '4 Crossbowmen · 4 Knights · 2 Cavalry',
  'Самураи': 'Samurai',
  '4 Самурая · 2 Рыцаря · 2 Конных · 2 Лучника': '4 Samurai · 2 Knights · 2 Cavalry · 2 Archers',

  // ── AI preset labels ───────────────────────────────────────────────────────
  'Ученик': 'Apprentice',
  'Воин': 'Warrior',
  'Тактик': 'Tactician',

  // ── Story campaign (chapter / game / task names) ───────────────────────────
  'Меч в камне': 'The Sword in the Stone',
  'Рыцари Круглого стола': 'Knights of the Round Table',
  'Закат Камелота': 'The Fall of Camelot',
  'Юность Артура': 'The Youth of Arthur',
  'Корона Логрии': 'The Crown of Logres',
  'Эскалибур': 'Excalibur',
  'Камелот': 'Camelot',
  'Войны с саксами': 'The Saxon Wars',
  'Честь рыцаря': "A Knight's Honour",
  'Поиски Грааля': 'The Quest for the Grail',
  'Битва при Камлане': 'The Battle of Camlann',
  'Безвестный оруженосец': 'The Unknown Squire',
  'Турнир в Лондоне': 'The London Tournament',
  'Непокорные бароны': 'The Rebel Barons',
  'Клятва верности': 'The Oath of Fealty',
  'Битва при Бедегрейне': 'The Battle of Bedegraine',
  'Владычица Озера': 'The Lady of the Lake',
  'Дар Эскалибура': 'The Gift of Excalibur',
  'Основание Камелота': 'The Founding of Camelot',
  'Круглый стол': 'The Round Table',
  'Сэр Ланселот': 'Sir Lancelot',
  'Саксонское вторжение': 'The Saxon Invasion',
  'Гора Бадон': 'Mount Badon',
  'Двенадцать битв': 'The Twelve Battles',
  'Гавейн и Зелёный рыцарь': 'Gawain and the Green Knight',
  'Турнир чемпионов': 'The Tournament of Champions',
  'Священный Грааль': 'The Holy Grail',
  'Сэр Галахад': 'Sir Galahad',
  'Тень измены': 'The Shadow of Betrayal',
  'Предательство Ланселота': "Lancelot's Betrayal",
  'Мордред восстаёт': 'Mordred Rises',
  'Осада Камелота': 'The Siege of Camelot',
  'Последний поход': 'The Last March',
  'Король былого и грядущего': 'The Once and Future King',

  // ── index.html static elements ─────────────────────────────────────────────
  'Средневековая пошаговая стратегия': 'A medieval turn-based strategy',
  '📖 Об игре': '📖 About',
  '⚔️ Играть': '⚔️ Play',
  '⚙️ Настройки': '⚙️ Settings',
  'Сдаться?': 'Surrender?',
  'Противник получит победу. Вы уверены?': 'The opponent will be awarded the win. Are you sure?',
  'Да, сдаюсь': 'Yes, I surrender',
  'Соединение потеряно': 'Connection lost',
  'Переподключаемся к матчу…': 'Reconnecting to the match…',
  'Выйти в меню': 'Exit to menu',
  'Вход': 'Login',
  'или': 'or',
  'Войти через Google': 'Sign in with Google',
  'Пропустить': 'Skip',
  'Далее': 'Next',
  '⚔️ Выбор войска': '⚔️ Choose your army',
  'Выберите состав армии перед боем': 'Pick your army before the battle',
  'Как играть': 'How to play',
  'Имя': 'Name',
  'Пароль': 'Password',
};
