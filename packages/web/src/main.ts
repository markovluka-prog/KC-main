// Migration in progress (Phase 2): inline-script port to TS module.
// @ts-nocheck - strictification will land incrementally in future sessions.
// Source: index.html lines 1877-7644 (legacy <script> block).

import {
  COLS,
  ROWS,
  SAVE_KEY,
  SAVE_VERSION,
  PARTS,
  PART_COLORS,
  PART_IMAGES,
  emptyBackpack,
  RUINS_LOOT_TABLE,
  UNIT_TYPES,
  WEAPONS,
  ARMORS,
  mulberry32,
  weightedChoiceWith,
  START_POSITIONS_P1,
  DEFAULT_TOWERS,
  DEFAULT_RUINS,
  insideBoard,
  manhattan,
  randomChoice,
  weightedChoice,
  generateLegalMoves,
  generateAttackActions,
  computeDamage as gameRulesComputeDamage,
  attackDamage,
  applyDamageToTarget,
  isContinuableSnapshot,
  validateSerializedUnit,
  getCastleP1Col,
  getCastleP2Col,
  setCastleP1Col,
  setCastleP2Col,
  getTowers,
  setTowers,
  getConstructions,
  setConstructions,
  getBridgeDurability,
  setBridgeDurability,
  getRuins,
  setRuins,
  getRuins2,
  setRuins2,
  getAllRuins,
  getTerrain,
  setTerrain,
  scatterHiddenPickups,
  archerRadiusFor,
  catapultMaxRangeFor,
  CATAPULT_MIN_RANGE,
  CROSSBOW_PIERCE_RANGE,
  CROSSBOW_PIERCE_COST,
  MAGE_MAX_ENERGY,
  MAGE_ENERGY_REGEN_PER_TURN,
  MAGE_ATTACK_DAMAGE,
  MAGE_ATTACK_ENERGY_PER_CELL,
  MAGE_ATTACK_ENERGY_PER_HP,
  MAGE_WARD_ENERGY_PER_DAMAGE,
  MAGE_DRAIN_ENERGY_PER_HP,
  MAGE_BURN_BRIDGE_ENERGY_PER_CELL,
  MAGE_HEAL_ENERGY_PER_HP,
  MAGE_HEAL_ENERGY_PER_CELL,
} from '@kc/game-rules';
// Storage adapter lives in a separate sub-path so the main barrel stays
// localStorage-free (Phase 1.5 S1 — server bundle can import only the main
// entry without pulling DOM globals).
import {
  readSavedState as readSavedStateFromStore,
  writeSnapshot,
  clearSave as clearSaveInStore,
} from '@kc/game-rules/storage';
import { MusicPlayer } from './audio/music.js';
import { AssetStore } from './assets/loader.js';
import { Unit } from './game/Unit.js';
import { Board } from './game/Board.js';
import { AIPlayer } from './game/ai.js';
import { ApiClient } from './api/client.js';
import { isNativeAuthAvailable } from './net/auth-google.js';
import { isAdminEmail } from './admin.js';
import { sanitizeNickname } from './util/nickname.js';
import { SupabaseMatchClient } from './net/supabase-match-client.js';
import { t as tr, getLang, setLang, toggleLang, onLangChange } from './i18n.js';
import {
  CELL_SIZE,
  WIDTH,
  HEIGHT,
  FIELD_Y_OFFSET,
  BOARD_SCALE,
  BOARD_OFFSET_X,
  BOARD_OFFSET_Y,
  toKey,
} from './state/constants.js';
import {
  createParticle as fxCreateParticle,
  createExplosion as fxCreateExplosion,
  createFloatingText as fxCreateFloatingText,
  createArrow as fxCreateArrow,
  updateParticles as fxUpdateParticles,
  updateFloatingTexts as fxUpdateFloatingTexts,
  updateArrows as fxUpdateArrows,
  drawParticles as fxDrawParticles,
  drawFloatingTexts as fxDrawFloatingTexts,
  drawArrows as fxDrawArrows,
  type ArrowProjectile,
} from './render/fx.js';
import { COLORS } from './render/palette.js';
import { drawBrokenColumn as shapesBrokenColumn } from './render/shapes.js';

(function () {
  "use strict";

  // CELL_SIZE / WIDTH / HEIGHT / BOARD_* imported from ./state/constants and
  // COLORS from ./render/palette (Increments 1 & 3).

  // Phase 2: mutable world state (CASTLE/TOWERS/RUINS) lives in @kc/game-rules/world.
  // The block below seeds defaults on script load so the first render has values.
  setTowers([]);
  setConstructions([]);
  setBridgeDurability({});
  setRuins({ ...DEFAULT_RUINS });
  setRuins2(null);
  // getCastleP1Col() / getCastleP2Col() default to 3 (set in world.ts on module init).

  const KEY_SPACE = "Space";

  // UI surfaces that own their own scrolling/tapping, so the global touch
  // guards (page-bounce + double-tap-zoom blockers) must leave them alone.
  // Covers the sidebar, the menu, and every modal overlay — when adding a new
  // modal, add its selector here so it scrolls and taps on touch devices.
  const TOUCH_SCROLL_SURFACES = [
    "#sidebar",
    "#menuOverlay",
    ".menu-panel-left",
    ".menu-panel-right",
    ".submenu-overlay", // #aboutModal / #playModal / #settingsModal
    "#draftModal",
    "#rulesModal",
    "#authModal",
    "#onlineModal",
    "#onlineDisconnectModal",
    "#surrenderModal",
    "#tutorialOverlay",
  ].join(", ");

  // SAVE_KEY / SAVE_VERSION imported from @kc/game-rules at top.
  // SEC-001 fix (Phase 1 plan): ACCOUNT_KEY removed — fake local-auth deleted.
  // Real authentication is scheduled for Phase 3 (server-side via OAuth + Postgres).
  const PROGRESS_KEY = 'kac_progress_v2';

  // Default story structure (replaced by story.txt when loaded)
  let STORY_CHAPTERS = [
    { title: 'Меч в камне', games: [
      { title: 'Юность Артура', tasks: [
        { aiPreset: { label:'Новичок', frameWait:26, combinationLimit:10, randomMoveChance:0.20, mistakeChance:0.12, skipChance:0.05, threatBlindness:0.35, spellReluctance:0.70, scoreNoise:400,  useMinimax:false, minimaxDepth:0, focusFireWeight:0.4, comboDetection:true,  territoryWeight:0.4, sacrificeEval:false, useMCTS:true, mctsTimeBudgetMs:80,  mctsRolloutDepth:2, mctsBreadth:3, smartSpells:false, economyWeight:0.2, castleApproachWeight:0.5, opponentThreatWeight:0.5, cohesionWeight:0.2, archerKiteWeight:0.4, cavalryFlankWeight:0.4, knightTankWeight:0.3, searchBreadth:3, searchNodeBudget:600,  searchTimeBudgetMs:60  }, name:'Безвестный оруженосец' },
        { aiPreset: { label:'Ученик',  frameWait:22, combinationLimit:20, randomMoveChance:0.10, mistakeChance:0.07, skipChance:0.02, threatBlindness:0.20, spellReluctance:0.45, scoreNoise:200,  useMinimax:false, minimaxDepth:0, focusFireWeight:0.6, comboDetection:true,  territoryWeight:0.6, sacrificeEval:false, useMCTS:true, mctsTimeBudgetMs:150, mctsRolloutDepth:3, mctsBreadth:4, smartSpells:false, economyWeight:0.5, castleApproachWeight:0.7, opponentThreatWeight:0.7, cohesionWeight:0.3, archerKiteWeight:0.5, cavalryFlankWeight:0.5, knightTankWeight:0.4, searchBreadth:4, searchNodeBudget:1500, searchTimeBudgetMs:100 }, name:'Турнир в Лондоне' },
        { aiPreset: { label:'Воин',    frameWait:16, combinationLimit:80, randomMoveChance:0.04, mistakeChance:0.03, skipChance:0.00, threatBlindness:0.04, spellReluctance:0.15, scoreNoise:100,  useMinimax:false, minimaxDepth:0, focusFireWeight:0.7, comboDetection:true,  territoryWeight:0.8,  sacrificeEval:false, useMCTS:true, mctsTimeBudgetMs:280, mctsRolloutDepth:4, mctsBreadth:5, smartSpells:true,  economyWeight:0.7, castleApproachWeight:1.0, opponentThreatWeight:0.9, cohesionWeight:0.5, archerKiteWeight:0.7, cavalryFlankWeight:0.7, knightTankWeight:0.6, searchBreadth:5, searchNodeBudget:3000, searchTimeBudgetMs:150 }, name:'Меч из камня' }
      ]},
      { title: 'Корона Логрии', tasks: [
        { aiPreset: { label:'Ученик', frameWait:22, combinationLimit:20, randomMoveChance:0.10, mistakeChance:0.07, skipChance:0.02, threatBlindness:0.20, spellReluctance:0.45, scoreNoise:200,  useMinimax:false, minimaxDepth:0, focusFireWeight:0.6, comboDetection:true,  territoryWeight:0.6,  sacrificeEval:false, useMCTS:true, mctsTimeBudgetMs:150, mctsRolloutDepth:3, mctsBreadth:4, smartSpells:false, economyWeight:0.5, castleApproachWeight:0.7, opponentThreatWeight:0.7, cohesionWeight:0.3, archerKiteWeight:0.5, cavalryFlankWeight:0.5, knightTankWeight:0.4, searchBreadth:4, searchNodeBudget:1500, searchTimeBudgetMs:100 }, name:'Непокорные бароны' },
        { aiPreset: { label:'Воин',   frameWait:16, combinationLimit:80, randomMoveChance:0.04, mistakeChance:0.03, skipChance:0.00, threatBlindness:0.04, spellReluctance:0.15, scoreNoise:100,  useMinimax:false, minimaxDepth:0, focusFireWeight:0.7, comboDetection:true,  territoryWeight:0.8,  sacrificeEval:false, useMCTS:true, mctsTimeBudgetMs:280, mctsRolloutDepth:4, mctsBreadth:5, smartSpells:true,  economyWeight:0.7, castleApproachWeight:1.0, opponentThreatWeight:0.9, cohesionWeight:0.5, archerKiteWeight:0.7, cavalryFlankWeight:0.7, knightTankWeight:0.6, searchBreadth:5, searchNodeBudget:3000, searchTimeBudgetMs:150 }, name:'Клятва верности' },
        { aiPreset: { label:'Тактик', frameWait:12, combinationLimit:100, randomMoveChance:0.00, mistakeChance:0.00, skipChance:0.00, threatBlindness:0.00, spellReluctance:0.00, scoreNoise:0,   useMinimax:true,  minimaxDepth:1, focusFireWeight:0.9,  comboDetection:true,  territoryWeight:1.0,  sacrificeEval:true,  useMCTS:true, mctsTimeBudgetMs:450, mctsRolloutDepth:6, mctsBreadth:6, smartSpells:true,  economyWeight:1.0, castleApproachWeight:1.2, opponentThreatWeight:1.2, cohesionWeight:0.7, archerKiteWeight:1.0, cavalryFlankWeight:1.0, knightTankWeight:0.9, searchBreadth:8, searchNodeBudget:9000, searchTimeBudgetMs:300 }, name:'Битва при Бедегрейне' }
      ]}
    ]},
    { title: 'Рыцари Круглого стола', games: [
      { title: 'Камелот', tasks: [
        { aiPreset: { label:'Воин',   frameWait:16, combinationLimit:80, randomMoveChance:0.04, mistakeChance:0.03, skipChance:0.00, threatBlindness:0.04, spellReluctance:0.15, scoreNoise:100,  useMinimax:false, minimaxDepth:0, focusFireWeight:0.7, comboDetection:true,  territoryWeight:0.8,  sacrificeEval:false, useMCTS:true, mctsTimeBudgetMs:280, mctsRolloutDepth:4, mctsBreadth:5, smartSpells:true,  economyWeight:0.7, castleApproachWeight:1.0, opponentThreatWeight:0.9, cohesionWeight:0.5, archerKiteWeight:0.7, cavalryFlankWeight:0.7, knightTankWeight:0.6, searchBreadth:5, searchNodeBudget:3000, searchTimeBudgetMs:150 }, name:'Основание Камелота' },
        { aiPreset: { label:'Воин',   frameWait:16, combinationLimit:80, randomMoveChance:0.04, mistakeChance:0.03, skipChance:0.00, threatBlindness:0.04, spellReluctance:0.15, scoreNoise:100,  useMinimax:false, minimaxDepth:0, focusFireWeight:0.7, comboDetection:true,  territoryWeight:0.8,  sacrificeEval:false, useMCTS:true, mctsTimeBudgetMs:280, mctsRolloutDepth:4, mctsBreadth:5, smartSpells:true,  economyWeight:0.7, castleApproachWeight:1.0, opponentThreatWeight:0.9, cohesionWeight:0.5, archerKiteWeight:0.7, cavalryFlankWeight:0.7, knightTankWeight:0.6, searchBreadth:5, searchNodeBudget:3000, searchTimeBudgetMs:150 }, name:'Круглый стол' },
        { aiPreset: { label:'Тактик', frameWait:12, combinationLimit:100, randomMoveChance:0.00, mistakeChance:0.00, skipChance:0.00, threatBlindness:0.00, spellReluctance:0.00, scoreNoise:0,   useMinimax:true,  minimaxDepth:1, focusFireWeight:0.9,  comboDetection:true,  territoryWeight:1.0,  sacrificeEval:true,  useMCTS:true, mctsTimeBudgetMs:450, mctsRolloutDepth:6, mctsBreadth:6, smartSpells:true,  economyWeight:1.0, castleApproachWeight:1.2, opponentThreatWeight:1.2, cohesionWeight:0.7, archerKiteWeight:1.0, cavalryFlankWeight:1.0, knightTankWeight:0.9, searchBreadth:8, searchNodeBudget:9000, searchTimeBudgetMs:300 }, name:'Сэр Ланселот' }
      ]},
      { title: 'Войны с саксами', tasks: [
        { aiPreset: { label:'Тактик', frameWait:12, combinationLimit:100, randomMoveChance:0.00, mistakeChance:0.00, skipChance:0.00, threatBlindness:0.00, spellReluctance:0.00, scoreNoise:0,   useMinimax:true,  minimaxDepth:1, focusFireWeight:0.9,  comboDetection:true,  territoryWeight:1.0,  sacrificeEval:true,  useMCTS:true, mctsTimeBudgetMs:450, mctsRolloutDepth:6, mctsBreadth:6, smartSpells:true,  economyWeight:1.0, castleApproachWeight:1.2, opponentThreatWeight:1.2, cohesionWeight:0.7, archerKiteWeight:1.0, cavalryFlankWeight:1.0, knightTankWeight:0.9, searchBreadth:8, searchNodeBudget:9000, searchTimeBudgetMs:300 }, name:'Саксонское вторжение' },
        { aiPreset: { label:'Тактик', frameWait:12, combinationLimit:100, randomMoveChance:0.00, mistakeChance:0.00, skipChance:0.00, threatBlindness:0.00, spellReluctance:0.00, scoreNoise:0,   useMinimax:true,  minimaxDepth:1, focusFireWeight:0.9,  comboDetection:true,  territoryWeight:1.0,  sacrificeEval:true,  useMCTS:true, mctsTimeBudgetMs:450, mctsRolloutDepth:6, mctsBreadth:6, smartSpells:true,  economyWeight:1.0, castleApproachWeight:1.2, opponentThreatWeight:1.2, cohesionWeight:0.7, archerKiteWeight:1.0, cavalryFlankWeight:1.0, knightTankWeight:0.9, searchBreadth:8, searchNodeBudget:9000, searchTimeBudgetMs:300 }, name:'Гора Бадон' },
        { aiPreset: { label:'Мастер', frameWait:10, combinationLimit:200, randomMoveChance:0.00, mistakeChance:0.00, skipChance:0.00, threatBlindness:0.00, spellReluctance:0.00, scoreNoise:0, useMinimax:true, minimaxDepth:2, focusFireWeight:1.0, comboDetection:true, territoryWeight:1.0, sacrificeEval:true, useMCTS:true, mctsTimeBudgetMs:800, mctsRolloutDepth:7, mctsBreadth:7, smartSpells:true, economyWeight:1.2, castleApproachWeight:1.2, opponentThreatWeight:1.5, cohesionWeight:0.7, archerKiteWeight:1.0, cavalryFlankWeight:1.0, knightTankWeight:1.0, searchBreadth:12, searchNodeBudget:20000, searchTimeBudgetMs:600 }, name:'Турнир чемпионов' }
      ]}
    ]}
  ];

  // Parse story.txt format into STORY_CHAPTERS structure
  function parseStoryTxt(text) {
    const aiPresets = {};
    const defaultPresetFields = {
      frameWait: 20, combinationLimit: 80, randomMoveChance: 0.0, mistakeChance: 0.0,
      skipChance: 0.0, threatBlindness: 0.0, spellReluctance: 0.0, scoreNoise: 0,
      useMinimax: false, minimaxDepth: 0, focusFireWeight: 0.5, comboDetection: true,
      territoryWeight: 0.7, sacrificeEval: false,
      useMCTS: false, mctsTimeBudgetMs: 0, mctsRolloutDepth: 0, mctsBreadth: 0,
      smartSpells: false, economyWeight: 0.5,
      castleApproachWeight: 0.5, opponentThreatWeight: 0.7, cohesionWeight: 0.4,
      archerKiteWeight: 0.5, cavalryFlankWeight: 0.5, knightTankWeight: 0.5,
      searchBreadth: 5, searchNodeBudget: 2000, searchTimeBudgetMs: 120
    };
    let currentPreset = null;
    const chapters = [];
    let currentChapter = null;
    let currentGame = null;

    text.split('\n').forEach(rawLine => {
      // Strip inline comment (# after content)
      let raw = rawLine;
      const inlineHash = rawLine.search(/\s+#(?!#)/);
      if (inlineHash > 0) raw = rawLine.slice(0, inlineHash);
      const line = raw.trim();
      if (!line) return;

      // AI preset block header: [AI: Name]
      const aiMatch = line.match(/^\[AI:\s*(.+?)\]$/i);
      if (aiMatch) {
        const name = aiMatch[1].trim();
        currentPreset = Object.assign({}, defaultPresetFields, { label: name });
        aiPresets[name.toLowerCase()] = currentPreset;
        return;
      }

      // key=value inside a preset block
      if (currentPreset && !line.startsWith('#') && !line.startsWith('[') && line.includes('=')) {
        const eqIdx = line.indexOf('=');
        const k = line.slice(0, eqIdx).trim();
        const v = line.slice(eqIdx + 1).trim();
        if (k) {
          if (v === 'true')  currentPreset[k] = true;
          else if (v === 'false') currentPreset[k] = false;
          else if (v !== '' && !isNaN(v)) currentPreset[k] = parseFloat(v);
        }
        return;
      }

      // ## Game (subchapter) — must check BEFORE generic # handler
      if (line.startsWith('## ')) {
        if (!currentChapter) return;
        currentPreset = null;
        currentGame = { title: line.slice(3).trim(), tasks: [] };
        currentChapter.games.push(currentGame);
        return;
      }

      // Lines starting with # are comments or chapter titles
      if (line.startsWith('#')) {
        // Chapter line: # Глава N — Title
        if (line.startsWith('# ')) {
          const content = line.slice(2).trim();
          if (/^Глава\s/i.test(content)) {
            currentPreset = null;
            currentChapter = { title: content, games: [] };
            chapters.push(currentChapter);
            currentGame = null;
          }
        }
        return; // all other # lines are comments — skip
      }

      // Task line: PresetName | Task name
      if (currentGame && line.includes('|')) {
        const sep = line.indexOf('|');
        const presetName = line.slice(0, sep).trim();
        const taskName   = line.slice(sep + 1).trim();
        if (!taskName) return;
        const preset = aiPresets[presetName.toLowerCase()]
          || aiPresets['воин']
          || Object.assign({}, defaultPresetFields, { label: presetName });
        currentGame.tasks.push({ aiPreset: preset, name: taskName });
      }
    });
    return chapters.length > 0 ? chapters : null;
  }

  // Phase 2: MusicPlayer imported from ./audio/music.js (strict TS).
  // Legacy back-compat: expose `muted` property by reading isMuted() if any
  // call-site reads it directly.

  const AI_DIFFICULTY = {
    easy: {
      label: "Слабый",
      frameWait: 24,
      combinationLimit: 10,
      randomMoveChance: 0.30,
      mistakeChance: 0.20,
      skipChance: 0.10,
      threatBlindness: 0.50,
      spellReluctance: 0.70,
      scoreNoise: 3000,
      useMinimax: false,
      minimaxDepth: 0,
      focusFireWeight: 0.0,
      comboDetection: false,
      territoryWeight: 0.3,
      sacrificeEval: false
    },
    medium: {
      label: "Средний",
      frameWait: 14,
      combinationLimit: 80,
      randomMoveChance: 0.0,
      mistakeChance: 0.05,
      skipChance: 0.0,
      threatBlindness: 0.0,
      spellReluctance: 0.15,
      scoreNoise: 500,
      useMinimax: false,
      minimaxDepth: 0,
      focusFireWeight: 0.5,
      comboDetection: true,
      territoryWeight: 0.7,
      sacrificeEval: false
    },
    hard: {
      label: "Сложный",
      frameWait: 10,
      combinationLimit: 200,
      randomMoveChance: 0.0,
      mistakeChance: 0.0,
      skipChance: 0.0,
      threatBlindness: 0.0,
      spellReluctance: 0.0,
      scoreNoise: 0,
      useMinimax: true,
      minimaxDepth: 2,
      focusFireWeight: 1.0,
      comboDetection: true,
      territoryWeight: 1.0,
      sacrificeEval: true
    }
  };

  function isMobileDevice() {
    return (
      window.matchMedia("(max-width: 860px)").matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
  }

  // toKey now imported from ./state/constants (Increment 1).

  function otherPlayer(player) {
    return player === 1 ? 2 : 1;
  }

  function cloneRecipeText(recipe) {
    return Object.keys(recipe)
      .map((name) => recipe[name] + "x " + tr(name))
      .join(", ");
  }

  // Phase 2: randomChoice + weightedChoice imported from @kc/game-rules.
  // The inline weightedChoice took a list of {weight} objects; our import
  // takes parallel (items, weights) arrays. Wrap to preserve the legacy
  // contract so we don't have to touch every callsite right now.
  function weightedChoiceLegacy(list) {
    const weights = list.map((item) => Math.max(0, (item && item.weight) || 0));
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) return list[0];
    return weightedChoice(list, weights);
  }


  // ── Пул из 100 проверенных карт (сиды mulberry32) ───────────────────────────
  const MAP_POOL = [12,13,15,16,18,20,25,27,29,32,36,37,42,49,50,64,67,77,83,93,100,103,107,122,126,128,129,131,135,148,149,150,156,157,161,164,166,168,171,173,184,187,191,194,214,216,223,226,232,235,237,242,253,256,265,268,270,272,283,293,296,297,307,316,317,319,323,327,331,339,344,350,353,355,357,367,373,376,379,382,389,395,398,404,410,413,417,424,431,437,443,445,457,459,468,471,479,485,487,488];

  function mulberry32(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s += 0x6D2B79F5;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // BFS step-distance from (sr,sc) to (tr,tc) over the current terrain, routing
  // around river/mountain (bridges are passable). −1 if unreachable. Used to
  // verify both castles are an equally long march from the single ruins.
  function terrainPathDist(sr: number, sc: number, tr: number, tc: number): number {
    const blocked = (r: number, c: number): boolean =>
      getTerrain().some((t) => t.row === r && t.col === c && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'));
    if (sr < 0 || sc < 0 || sr >= ROWS || sc >= COLS) return -1;
    const dist = new Int16Array(ROWS * COLS).fill(-1);
    dist[sr * COLS + sc] = 0;
    let frontier = [[sr, sc]];
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    while (frontier.length) {
      const next: number[][] = [];
      for (const [r, c] of frontier) {
        if (r === tr && c === tc) return dist[r * COLS + c];
        for (const [dr, dc] of dirs) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= ROWS || nc >= COLS) continue;
          if (dist[nr * COLS + nc] !== -1) continue;
          // Allow stepping ONTO the target even if it's "blocked" (ruins/tower);
          // otherwise treat blocked terrain as a wall.
          if (!(nr === tr && nc === tc) && blocked(nr, nc)) continue;
          dist[nr * COLS + nc] = dist[r * COLS + c] + 1;
          next.push([nr, nc]);
        }
      }
      frontier = next;
    }
    return dist[tr * COLS + tc];
  }

  // Shortest march distance from a castle's door to the nearest cell of the ruins.
  function castleToRuinsDist(castleCol: number, doorRow: number): number {
    const ru = getRuins();
    let best = Infinity;
    for (let r = ru.top; r < ru.top + ru.height; r++) {
      for (let c = ru.left; c < ru.left + ru.width; c++) {
        const d = terrainPathDist(doorRow, castleCol + 2, r, c);
        if (d >= 0 && d < best) best = d;
      }
    }
    return best === Infinity ? -1 : best;
  }

  // Generate a map, then keep regenerating until both castles are an EQUALLY
  // close march to the ruins (path-distance through bridges/around mountains),
  // within a small tolerance. Keeps the most-balanced attempt as a fallback.
  function randomizeMapPositions(seed?: number) {
    const TOL = 2; // acceptable |P1dist − P2dist| in steps
    const MAX_TRIES = 25;
    let bestDiff = Infinity;
    let bestSnapshot: { terrain: any[]; ruins: any; ruins2: any; towers: any[]; constructions: any[]; bridgeDurability: any; col: number } | null = null;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      randomizeMapPositionsOnce(seed);
      const p1 = castleToRuinsDist(getCastleP1Col(), 2); // P1 door row ≈ 2 (top)
      const p2 = castleToRuinsDist(getCastleP2Col(), ROWS - 3); // P2 door row ≈ 17 (bottom)
      // Both must be reachable; otherwise this layout is unusable — retry.
      if (p1 >= 0 && p2 >= 0) {
        const diff = Math.abs(p1 - p2);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestSnapshot = {
            terrain: getTerrain().map((t) => ({ ...t })),
            ruins: { ...getRuins() },
            ruins2: getRuins2() ? { ...getRuins2() } : null,
            towers: getTowers().map((t) => ({ ...t })),
            constructions: getConstructions().map((c) => ({ ...c })),
            bridgeDurability: { ...getBridgeDurability() },
            col: getCastleP1Col(),
          };
        }
        if (diff <= TOL) return; // balanced enough — keep this map
      }
      if (seed !== undefined) break; // deterministic seed: don't loop on the same map
    }
    // No attempt hit the tolerance — restore the most-balanced one we saw.
    if (bestSnapshot) {
      setCastleP1Col(bestSnapshot.col);
      setCastleP2Col(bestSnapshot.col);
      setRuins(bestSnapshot.ruins);
      setRuins2(bestSnapshot.ruins2);
      setTowers(bestSnapshot.towers);
      setConstructions(bestSnapshot.constructions);
      setBridgeDurability(bestSnapshot.bridgeDurability);
      setTerrain(bestSnapshot.terrain);
    }
  }

  function randomizeMapPositionsOnce(seed?: number) {
    const maxCastleCol = COLS - 4;
    // Both teams share the same castle column so armies face each other directly.
    const sharedCastleCol = Math.floor(Math.random() * (maxCastleCol + 1));
    setCastleP1Col(sharedCastleCol);
    setCastleP2Col(sharedCastleCol);

    const overlapsCastle = (left, width, castleCol) =>
      left < castleCol + 4 && left + width > castleCol;

    // SINGLE ruins area, placed BETWEEN the two castles — vertically on the centre
    // line AND horizontally aligned with the castle column — so the march from
    // each castle is short and the same length on both sides. Both castles share
    // sharedCastleCol (a 4-wide zone), so the ruins sit roughly under its middle
    // with a tiny ±1 jitter. Earlier this column was fully random, which sometimes
    // dropped the ruins on a far flank (e.g. col 17 vs castle col 5 → a 17-cell
    // march that looked like "the cavalry never gets there").
    const ruinsTop = Math.floor((ROWS - 2) / 2); // 9 on a 20-row board
    const centreCol = sharedCastleCol + 1 + (Math.floor(Math.random() * 3) - 1); // ±1 jitter
    const ruinsCol = Math.max(0, Math.min(COLS - 2, centreCol));
    setRuins({ ...getRuins(), left: ruinsCol, top: ruinsTop });
    // Only one ruins area now (was two).
    setRuins2(null);

    // 0 башен на старте, пустые стройплощадки и прочность мостов
    setTowers([]);
    setConstructions([]);
    setBridgeDurability({});

    const ruins = getRuins();
    const ruins2 = getRuins2();
    const terrain: Array<{ row: number; col: number; type: string }> = [];

    // ── 1. Извилистая река ───────────────────────────────────────────────────
    // Река идёт слева направо, но может 1-2 раза "переступить" на ±1 строку,
    // создавая мягкий изгиб. На каждом переходе добавляется угловая клетка
    // (обе строки в одном столбце) — визуальная связность гарантирована.
    const rng = seed !== undefined ? mulberry32(seed) : Math.random;
    let baseRow = 8 + Math.floor(rng() * 4); // 8–11
    // Перевыбираем если пересекает руины
    for (let g = 0; g < 20; g++) {
      let clash = false;
      for (let r = ruins.top; r < ruins.top + ruins.height; r++)
        if (r === baseRow) { clash = true; break; }
      if (!clash) break;
      baseRow = 8 + Math.floor(rng() * 4);
    }

    // Строим путь реки: массив riverPath[c] = строка в колонке c
    // Река сильно изгибается — сдвиг на ±1 каждые 3-4 колонки, итоговый
    // диапазон до ±4 строк от базовой. Создаёт S-образные и зигзагообразные
    // формы вместо почти прямой линии.
    const riverPath: number[] = [];
    let curRow = baseRow;
    for (let c = 0; c < COLS; c++) {
      riverPath.push(curRow);
      // Сдвиг каждые 2-3 колонки — частые изгибы, чтобы река заметно петляла
      // (а не шла почти прямой линией). Соединительные клетки на изгибах (см.
      // ниже) делают эти переходы сплошной линией с плавными поворотами.
      if (c >= 2 && c <= COLS - 3 && c % (2 + Math.floor(rng() * 2)) === 0) {
        const shift = rng() < 0.5 ? 1 : -1;
        const next = curRow + shift;
        if (next >= 5 && next <= 14) {
          curRow = next;
        }
      }
    }

    // Окно руин: река не должна проходить сквозь руины, поэтому позже мы
    // поднимем её на плато выше руин — на 1 столбец шире самих руин с каждой
    // стороны. Тогда резкий подъём/спуск приходится на столбцы ВНЕ руин, а
    // клетки реки в столбцах руин всегда выше них, и соединительные клетки
    // изгибов (см. ниже) не попадают внутрь руин и не вырезаются очисткой.
    const ruinCeiling = ruins.top - 1;
    const fixL = Math.max(0, ruins.left - 1);
    const fixR = Math.min(COLS - 1, ruins.left + ruins.width); // включительно

    // ── 2. Мосты: по одному в каждой из 2 зон (30% шанс третьего в центре) ──
    // Мост ОБЯЗАН стоять на прямом участке реки, иначе он упирается в изгиб и
    // им нельзя воспользоваться. Поэтому в выбранной колонке мы принудительно
    // выпрямляем реку на 3 клетки (c-1, c, c+1) — так клетка моста становится
    // единственной водой в столбце, рядом нет изгибов и проход сквозной.
    const zones = rng() < 0.3 ? 3 : 2;
    const zoneW = Math.floor(COLS / zones);
    const bridgeCols = new Set<number>();
    for (let z = 0; z < zones; z++) {
      const lo = z * zoneW + 1;
      const hi = Math.min((z + 1) * zoneW - 2, COLS - 2);
      let c = lo + Math.floor(rng() * Math.max(1, hi - lo));
      c = Math.max(1, Math.min(COLS - 2, c));
      // Мост не должен стоять вплотную к руинам: иначе плато над руинами (ниже)
      // создаст ступеньку прямо у моста и перекроет проход. Если выбор попал в
      // полосу [fixL-1, fixR+1], сдвигаем мост за её пределы, не выходя из зоны.
      if (c >= fixL - 1 && c <= fixR + 1) {
        if (fixR + 2 <= hi) c = fixR + 2;
        else if (fixL - 2 >= lo) c = fixL - 2;
        // Зона целиком внутри полосы — выходим за её пределы даже за границы
        // зоны: вправо, если до края поля есть место, иначе влево. Для любого
        // положения руин хотя бы один вариант валиден, так что мост всегда
        // оказывается вне полосы руин и плато его не задевает.
        else if (fixR + 2 <= COLS - 2) c = fixR + 2;
        else c = fixL - 2;
      }
      // Выпрямляем реку вокруг моста, чтобы переход был сквозным.
      riverPath[c - 1] = riverPath[c];
      riverPath[c + 1] = riverPath[c];
      bridgeCols.add(c);
    }

    // Equal-march guarantee: also put a bridge in the ruins' own column. The
    // ruins straddle the river line, so this bridge is the shared gateway both
    // armies funnel to — making the approach the same distance from each side
    // (the path-balance retry in randomizeMapPositions still verifies it).
    {
      const rc = Math.max(1, Math.min(COLS - 2, ruins.left));
      riverPath[rc - 1] = riverPath[rc];
      riverPath[rc + 1] = riverPath[rc];
      bridgeCols.add(rc);
    }

    // Post-fix плато: поднимаем реку над руинами ПОСЛЕ расстановки мостов, чтобы
    // выпрямление под мост не затёрло подъём (иначе скачок снова пришёлся бы в
    // столбец руин и река разорвалась бы при очистке клеток руин).
    for (let c = fixL; c <= fixR; c++) {
      if (riverPath[c] > ruinCeiling) riverPath[c] = ruinCeiling;
    }

    // Заполняем реку и мосты
    const riverSet = new Map<string, string>(); // key -> type
    for (let c = 0; c < COLS; c++) {
      const r = riverPath[c];
      riverSet.set(r + ',' + c, bridgeCols.has(c) ? 'bridge' : 'river');
    }
    // Поворотные (соединительные) клетки: на изгибе река меняет строку между
    // столбцами c и c+1, поэтому клетки (r,c) и (rNext,c+1) касаются лишь углом.
    // Заполняем вертикальный участок в столбце c+1 от строки r до rNext — так
    // река остаётся одной сплошной линией, соединённой по граням, а не по
    // диагонали (надёжно и при сдвиге больше чем на один ряд).
    for (let c = 0; c < COLS - 1; c++) {
      const r = riverPath[c];
      const rNext = riverPath[c + 1];
      if (rNext === r) continue;
      const lo = Math.min(r, rNext);
      const hi = Math.max(r, rNext);
      for (let rr = lo; rr <= hi; rr++) {
        const key = rr + ',' + (c + 1);
        if (!riverSet.has(key)) riverSet.set(key, 'river'); // угол непроходим
      }
    }
    // Удаляем клетки реки (в т.ч. поворотные), которые попали в зоны руин
    for (const area of [ruins, ruins2]) {
      if (area.width <= 0 || area.height <= 0) continue;
      for (let rr = area.top; rr < area.top + area.height; rr++) {
        for (let cc = area.left; cc < area.left + area.width; cc++) {
          riverSet.delete(rr + ',' + cc);
        }
      }
    }
    for (const [key, type] of riverSet) {
      const [r, c] = key.split(',').map(Number);
      terrain.push({ row: r, col: c, type });
    }

    // ── 3. Строим blocked (река + замки + руины + башни) ────────────────────
    const blocked = new Set<string>(riverSet.keys());
    for (let c = getCastleP1Col(); c < getCastleP1Col() + 4; c++)
      for (let r = 0; r < 5; r++) blocked.add(r + ',' + c);
    for (let c = getCastleP2Col(); c < getCastleP2Col() + 4; c++)
      for (let r = ROWS - 5; r < ROWS; r++) blocked.add(r + ',' + c);
    for (const area of [ruins, ruins2]) {
      if (area.width <= 0 || area.height <= 0) continue;
      for (let r = area.top; r < area.top + area.height; r++)
        for (let c = area.left; c < area.left + area.width; c++)
          blocked.add(r + ',' + c);
    }
    for (const t of getTowers()) blocked.add(t.row + ',' + t.col);

    // Держим 2 колонки вокруг каждого моста свободными от гор
    const clearCols = new Set<number>();
    for (const bc of bridgeCols)
      for (let dc = -2; dc <= 2; dc++) clearCols.add(bc + dc);

    // ── 4. Горные кластеры: 2 симметричных фланга + 1 опциональный центр ────
    // Формы кластеров: L, линия, точка — создают разные виды укрытий
    const clusterShapes: Array<Array<[number, number]>> = [
      [[0, 0], [1, 0], [2, 0]],          // вертикальная линия (стена)
      [[0, 0], [0, 1], [0, 2]],          // горизонтальная линия
      [[0, 0], [1, 0], [1, 1]],          // L-угол
      [[0, 0], [-1, 0], [0, 1]],         // L-угол зеркало
      [[0, 0], [1, 0], [0, 1], [1, 1]],  // квадрат 2×2
      [[0, 0], [1, 0]],                   // пара
    ];

    const placeCluster = (cr: number, cc: number) => {
      const shape = clusterShapes[Math.floor(rng() * clusterShapes.length)];
      for (const [dr, dc] of shape) {
        const mr = cr + dr;
        const mc = cc + dc;
        if (mr < 3 || mr >= ROWS - 3 || mc < 0 || mc >= COLS) continue;
        const key = mr + ',' + mc;
        if (blocked.has(key) || clearCols.has(mc)) continue;
        blocked.add(key);
        terrain.push({ row: mr, col: mc, type: 'mountain' });
      }
    };

    // 2 симметричных фланговых кластера
    const numFlank = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < numFlank; i++) {
      // Случайная позиция в левой половине (подальше от замков и реки)
      let cr = 0, cc = 0, ok = false;
      for (let att = 0; att < 40 && !ok; att++) {
        cr = 4 + Math.floor(rng() * (ROWS - 8));
        cc = 1 + Math.floor(rng() * (COLS / 2 - 3));
        ok = !blocked.has(cr + ',' + cc) && !clearCols.has(cc);
      }
      if (!ok) continue;
      placeCluster(cr, cc);                    // левый фланг
      placeCluster(cr, COLS - 1 - cc);        // правый (симметрия)
    }

    // Центральный кластер (40%) — создаёт препятствие прямо по центру
    if (rng() < 0.4) {
      let cr = 0, cc = 0, ok = false;
      for (let att = 0; att < 30 && !ok; att++) {
        cr = 5 + Math.floor(rng() * (ROWS - 10));
        cc = Math.floor(COLS / 2) - 1 + Math.floor(rng() * 3);
        ok = !blocked.has(cr + ',' + cc) && !clearCols.has(cc);
      }
      if (ok) placeCluster(cr, cc);
    }

    // Острова убраны: проходимая клетка 'island' посреди реки позволяла
    // переходить водный рубеж где угодно. Река теперь сплошная преграда,
    // пересекать её можно только по мостам.

    setTerrain(terrain);
  }

  // Phase 2: insideBoard, manhattan, randomChoice — imported from @kc/game-rules.

  const ARMY_PRESETS = [
    {
      id: 'balanced',
      name: 'Сбалансированный',
      desc: '6 Рыцарей · 2 Конных · 2 Лучника · 1 Маг',
      icon: '⚔️',
      units: [
        {type:'knight', row:0,col:0},{type:'archer', row:0,col:1},{type:'archer', row:0,col:2},{type:'knight', row:0,col:3},
        {type:'knight', row:1,col:0},{type:'knight', row:1,col:3},
        {type:'knight', row:2,col:0},{type:'knight', row:2,col:3},
        {type:'cavalry',row:3,col:1},{type:'cavalry',row:3,col:2},
        {type:'mage',   row:2,col:1},
      ],
    },
    {
      id: 'heavy',
      name: 'Тяжёлая пехота',
      desc: '8 Рыцарей · 2 Лучника · 1 Маг',
      icon: '🛡️',
      units: [
        {type:'knight', row:0,col:0},{type:'archer', row:0,col:1},{type:'archer', row:0,col:2},{type:'knight', row:0,col:3},
        {type:'knight', row:1,col:0},{type:'knight', row:1,col:3},
        {type:'knight', row:2,col:0},{type:'knight', row:2,col:3},
        {type:'knight', row:3,col:1},{type:'knight', row:3,col:2},
        {type:'mage',   row:2,col:1},
      ],
    },
    {
      id: 'cavalry',
      name: 'Кавалерийский натиск',
      desc: '6 Конных · 2 Рыцаря · 2 Лучника · 1 Маг',
      icon: '🐎',
      units: [
        {type:'knight',  row:0,col:0},{type:'archer',  row:0,col:1},{type:'archer',  row:0,col:2},{type:'knight',  row:0,col:3},
        {type:'cavalry', row:1,col:0},{type:'cavalry', row:1,col:3},
        {type:'cavalry', row:2,col:0},{type:'cavalry', row:2,col:3},
        {type:'cavalry', row:3,col:1},{type:'cavalry', row:3,col:2},
        {type:'mage',    row:2,col:1},
      ],
    },
    {
      id: 'ranged',
      name: 'Лучники',
      desc: '4 Лучника · 4 Рыцаря · 2 Конных · 1 Маг',
      icon: '🏹',
      units: [
        {type:'archer', row:0,col:0},{type:'archer', row:0,col:1},{type:'archer', row:0,col:2},{type:'archer', row:0,col:3},
        {type:'knight', row:1,col:0},{type:'knight', row:1,col:3},
        {type:'cavalry',row:2,col:0},{type:'cavalry',row:2,col:3},
        {type:'knight', row:3,col:1},{type:'knight', row:3,col:2},
        {type:'mage',   row:2,col:1},
      ],
    },
    {
      id: 'siege',
      name: 'Осада',
      desc: '2 Катапульты · 4 Рыцаря · 2 Конных · 2 Лучника · 1 Маг',
      icon: '🪨',
      units: [
        {type:'catapult',row:0,col:0},{type:'archer', row:0,col:1},{type:'archer', row:0,col:2},{type:'catapult',row:0,col:3},
        {type:'knight', row:1,col:0},{type:'knight', row:1,col:3},
        {type:'knight', row:2,col:0},{type:'knight', row:2,col:3},
        {type:'cavalry',row:3,col:1},{type:'cavalry',row:3,col:2},
        {type:'mage',   row:2,col:1},
      ],
    },
    {
      id: 'crossbowmen',
      name: 'Арбалетчики',
      desc: '4 Арбалетчика · 4 Рыцаря · 2 Конных · 1 Маг',
      icon: '🎯',
      units: [
        {type:'crossbow',row:0,col:0},{type:'crossbow',row:0,col:1},{type:'crossbow',row:0,col:2},{type:'crossbow',row:0,col:3},
        {type:'knight', row:1,col:0},{type:'knight', row:1,col:3},
        {type:'cavalry',row:2,col:0},{type:'cavalry',row:2,col:3},
        {type:'knight', row:3,col:1},{type:'knight', row:3,col:2},
        {type:'mage',   row:2,col:1},
      ],
    },
    {
      id: 'samurai',
      name: 'Самураи',
      desc: '4 Самурая · 2 Рыцаря · 2 Конных · 2 Лучника · 1 Маг',
      icon: '⚡',
      units: [
        {type:'samurai',row:0,col:0},{type:'archer', row:0,col:1},{type:'archer', row:0,col:2},{type:'samurai',row:0,col:3},
        {type:'samurai',row:1,col:0},{type:'samurai',row:1,col:3},
        {type:'knight', row:2,col:0},{type:'knight', row:2,col:3},
        {type:'cavalry',row:3,col:1},{type:'cavalry',row:3,col:2},
        {type:'mage',   row:2,col:1},
      ],
    },
    {
      id: 'mages',
      name: 'Боевые маги',
      desc: '3 Мага · 4 Рыцаря · 2 Конных · 2 Лучника',
      icon: '🔮',
      units: [
        {type:'mage',   row:0,col:0},{type:'archer', row:0,col:1},{type:'archer', row:0,col:2},{type:'mage',   row:0,col:3},
        {type:'knight', row:1,col:0},{type:'knight', row:1,col:3},
        {type:'knight', row:2,col:0},{type:'knight', row:2,col:3},
        {type:'cavalry',row:3,col:1},{type:'cavalry',row:3,col:2},
        {type:'mage',   row:2,col:1},
      ],
    },
  ];

  // Phase 2: Unit class imported from ./game/Unit.js (strict TS).

  // Phase 2: Board class imported from ./game/Board.js (strict TS).

  // Phase 2: AIPlayer imported from ./game/ai.ts (strict TS,
  // ~830 lines of typed AI heuristics). KnightsAndCastlesGame implements
  // the AIGameAPI interface structurally.

  class KnightsAndCastlesGame {
    constructor(canvas, sidebar, assets) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.sidebar = sidebar;
      this.assets = assets;
      this.canvasWrap = document.getElementById("canvasWrap");
      this.music = new MusicPlayer(
        document.getElementById('audioHall'),
        document.getElementById('audioBattle'),
      );

      this.screen = "menu";
      this.mode = null;
      this.aiDifficulty = null;
      this.currentStoryTask = null; // { ci, gi, ti, task } for story mode
      // Phase 3 T3.19 — auth state. Populated by the Google sign-in popup
      // callback or the email login form. Token kept in memory only
      // (XSS-resistant by design).
      this.authUser = null;
      this.authAccessToken = null;
      this.authMode = 'login'; // 'login' | 'signup' — current auth-modal tab
      this.api = new ApiClient({
        baseUrl: '/api',
        onAuthLost: () => {
          this.authUser = null;
          this.authAccessToken = null;
          this.clearAuthUserCache();
        },
      });
      this.mapTheme = 'land'; // 'land' | 'sea'
      this.p1Faction = 'blue';
      this.p2Faction = 'red';
      // ---- Online (Track A) state. `online` flips the game class into a
      // server-authoritative bridge: local actions are sent to the server and
      // the board is rebuilt from each authoritative state-update. ----
      this.online = false;
      this.net = null; // MatchClient
      this.myPlayer = null; // 1 | 2 — which side this client controls
      this.matchId = null;
      this.onlineToken = null;
      this.connState = 'closed';
      this.onlineStatus = null; // 'waiting' | 'in_progress' | 'finished' | 'aborted'
      this.turnEndsAt = null; // epoch ms of the current turn deadline
      this.onlineEnded = false; // game-over already surfaced
      this.onlineWaiting = false; // true while a created room awaits an opponent
      // Batch online play: the whole turn is played locally (optimistically) and
      // submitted to the server as ONE batch of ServerActions at end-of-turn.
      this.pendingActions = []; // queued ServerActions for the in-progress turn
      this.turnSubmitting = false; // true between flush and the authoritative echo
      // Seeded RNG mirror so optimistic ruins loot matches the server exactly.
      this.rngSeed = 0;
      this.rngCursor = 0;
      // A dead unit's whole backpack (parts + weapon + armour), dropped as one
      // object on its death cell (drop/pickup) — see [[per-unit-backpack]].
      this.droppedBackpacks = [];
      // Hidden artifacts/weapons/armour buried at match start. Invisible, never
      // respawn, claimed by the first unit that steps on the cell.
      this.hiddenPickups = [];
      this.player1Bottom = false;
      this.sessionWins = { 1: 0, 2: 0 };
      this.board = new Board(this.player1Bottom);
      this.currentPlayer = 1;
      this.maxActivatedPerTurn = 3;
      this.activatedCount = 0;
      this.selectedUnit = null;
      this.previewUnitId = null;
      this.winner = null;
      this.turnNumber = 1;
      this.message = "";
      this.lastEvent = "";
      // shieldTurns: mage ward now drives this per-hit (see mage-ward). damageBuff
      // has no way to be set any more — the old "Небо огня" spell is gone — but
      // the combat formula still reads it defensively, so it stays zeroed here.
      this.shieldTurns = { 1: 0, 2: 0 };
      this.damageBuff = { 1: 0, 2: 0 };
      this.pendingWeaponEquip = null;
      // Free item-transfer UI state — which unit's transfer panel is open,
      // which adjacent ally is picked as the recipient, and which items are
      // checked. None of this is server state; it's purely local UI.
      this.transferOpenUnitId = null;
      this.transferTargetId = null;
      this.transferSelection = {};
      this.weaponTargetMap = new Map();
      this.boardScale = BOARD_SCALE;
      this.boardOffsetX = BOARD_OFFSET_X;
      this.boardOffsetY = BOARD_OFFSET_Y;

      this.moveMap = new Map();
      this.attackMap = new Map();
      // Same key as attackMap (landing cell), but holds EVERY attack that can
      // land there instead of just the last one written. Cavalry can have two
      // different jump/L-attack actions — different victims — share a landing
      // cell; see rebuildHighlights.
      this.attackChoices = new Map();
      // Set when a click lands on a cavalry collision cell (two different
      // victims, one shared landing square) and the player must pick which
      // enemy they meant. { landRow, landCol, options: AttackAction[] } | null.
      this.pendingAttackChoice = null;
      this.saveQueued = false;
      this.pendingSavedState = this.readSavedState();
      this.fullscreenRequested = false;
      this.victoryOverlay = document.getElementById("victoryOverlay");
      
      // ANIMATION SYSTEM
      this.particles = [];
      this.arrowProjectiles = []; // Anim #4: flying arrows
      this.rockMode = false; // catapult boulder-aiming mode
      this.rockTargets = [];
      this.buildMode = null; // knight construction mode ('tower' | 'bridge' | null)
      this.buildTargets = [];
      // Mage ability targeting mode: 'attack' | 'drain' | 'heal' | 'burn-bridge' | 'ward' | null.
      this.mageMode = null;
      this.mageTargets = [];
      // Ward's own multi-select state — see toggleMageWardMode/pickMageWardUnit/confirmMageWard.
      this.mageWardPicks = new Set();
      // mage-attack's damage picker — see pickMageAttackTarget/confirmMageAttack.
      this.pendingMageAttack = null;
      this.frameCount = 0;
      this.unitAnimations = new Map();
      this.floatingTexts = [];
      this.undoStack = []; // P0: in-memory snapshot stack for in-turn undo
      this.showThreat = false; // P0: enemy threat-zone overlay toggle
      // Subtle grass tufts marking buried loot. Flip to false for fully
      // invisible pickups (the original 'you never see them' rule).
      this.showBuriedHints = true;
      this.highlightPulse = 0;
      this.highlightFrames = new Map(); // Anim #2: per-cell spawn frame for wave
      this.turnEndWave = 0;            // Anim #7: radial wave on turn end (frames)
      this.boardFadeIn = 0;            // Anim #13: canvas fade-in on game start (0→1)
      this.towerFlashTimer = 0;        // Anim #10: tower-capture glow
      this.towerFlashCol = -1;
      this.towerFlashRow = -1;
      this.tutorialMode = false;
      this.tutorialStep = 0; // 0=select 1=move 2=attack/end 3=ai_turn 4=select2 5=done
      this.cameraShake = 0;
      this.cameraShakeX = 0;
      this.cameraShakeY = 0;

      this.ai = new AIPlayer(this, 2, 'medium');
      // The AI now plans with a phase/goal strategy (see ai.ts computeStrategy);
      // the old learned Q-brain was removed because it never actually learned.

      this.bindEvents();
      this.bindAuthMessageHandler();
      this.bindAuthModal();
      this.bindDraftModal();
      this.installLangToggle();
      this.applyLanguage();
      onLangChange(() => this.applyLanguage());
      this.applyResponsiveCanvasSize();
      this.renderSidebar();
      this.loop();
    }

    /** Floating flag button to switch RU⇄EN (visible on every screen). */
    installLangToggle() {
      // Language toggle removed on request — the button crowded the HUD.
      return;
      if (document.getElementById('langToggle')) return;
      const btn = document.createElement('button');
      btn.id = 'langToggle';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Language');
      btn.style.cssText =
        'position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);right:calc(env(safe-area-inset-right,0px) + 8px);' +
        'z-index:99999;width:44px;height:34px;border-radius:8px;border:1px solid rgba(255,255,255,.35);' +
        'background:rgba(20,24,40,.72);color:#fff;font-size:20px;line-height:1;cursor:pointer;' +
        'display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);' +
        'box-shadow:0 2px 8px rgba(0,0,0,.35);padding:0;';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleLang();
      });
      document.body.appendChild(btn);
      this._langToggleBtn = btn;
    }

    /** Re-render everything for the current language and refresh static text. */
    applyLanguage() {
      const lang = getLang();
      if (this._langToggleBtn) {
        // Show the flag of the language you'll switch TO.
        this._langToggleBtn.textContent = lang === 'ru' ? '🇬🇧' : '🇷🇺';
        this._langToggleBtn.title = lang === 'ru' ? 'English' : 'Русский';
      }
      try {
        document.title = tr('Рыцари и Замки');
        document.documentElement.setAttribute('lang', lang);
        document.querySelectorAll('[data-i18n]').forEach((el) => {
          const key = el.getAttribute('data-i18n');
          if (key) el.textContent = tr(key);
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
          const key = el.getAttribute('data-i18n-placeholder');
          if (key) el.setAttribute('placeholder', tr(key));
        });
        // Language-specific images (e.g. the cover art). EN swaps to the *_en
        // file; if that file is missing it falls back to the Russian original.
        document.querySelectorAll('[data-i18n-src]').forEach((el) => {
          const enSrc = el.getAttribute('data-i18n-src');
          if (!el.dataset.i18nSrcRu) el.dataset.i18nSrcRu = el.getAttribute('src') || '';
          const ruSrc = el.dataset.i18nSrcRu;
          const want = lang === 'en' && enSrc ? enSrc : ruSrc;
          if (lang === 'en' && enSrc) {
            el.onerror = () => {
              el.onerror = null;
              el.src = ruSrc;
            };
          }
          if (el.getAttribute('src') !== want) el.src = want;
        });
      } catch (e) {
        /* ignore DOM hiccups */
      }
      // Refresh the JS-rendered menu buttons whenever the menu overlay is on
      // screen — NOT gated on this.screen, which can be 'game' while the menu
      // overlay is still shown (e.g. after returning from a match), leaving the
      // tr()-built buttons stale in the old language while data-i18n text flips.
      const menuOn = document.getElementById('menuOverlay')?.classList.contains('active');
      if (this.screen === 'menu' || menuOn) {
        const mb = document.getElementById('menuButtons');
        if (mb) mb.innerHTML = this._buildMenuButtonsHTML();
      }
      // Re-render any open sub-menu modal so its tr()-built content tracks lang.
      const subModals = {
        aboutModal: () => this._buildAboutModalHTML(),
        playModal: () => this._buildPlayModalHTML(),
        settingsModal: () => this._buildSettingsModalHTML(),
      };
      for (const [id, build] of Object.entries(subModals)) {
        const m = document.getElementById(id);
        if (!m || !m.classList.contains('active')) continue;
        const body = document.getElementById(id + 'Body');
        if (body) body.innerHTML = build();
      }
      if (this.updateOnlineHud) this.updateOnlineHud();
      this.renderSidebar();
    }

    /** Translate a data-derived name (unit/artifact/spell/weapon/story title)
     *  for DISPLAY only — the Russian value stays the underlying data key. */
    trName(s) {
      return typeof s === 'string' ? tr(s) : s;
    }

    bindEvents() {
      // Global button ripple
      document.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('.btn:not(:disabled), .menu-arrow-btn');
        if (!btn) return;
        const rect = btn.getBoundingClientRect();
        const r = document.createElement('span');
        r.className = 'btn-ripple';
        r.style.left = (e.clientX - rect.left) + 'px';
        r.style.top  = (e.clientY - rect.top)  + 'px';
        btn.appendChild(r);
        r.addEventListener('animationend', () => r.remove(), { once: true });
      }, { passive: true });

      this.canvas.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) {
          return;
        }
        this.requestFullscreenIfNeeded();
        const rect = this.canvas.getBoundingClientRect();
        const sourceX = typeof event.clientX === "number" ? event.clientX : 0;
        const sourceY = typeof event.clientY === "number" ? event.clientY : 0;
        const x = (sourceX - rect.left) * (WIDTH / rect.width);
        const y = (sourceY - rect.top) * (HEIGHT / rect.height);
        this.handleCanvasClick(x, y);
      });

      this.canvas.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.skipSelected();
      });

      document.addEventListener("keydown", (event) => {
        const active = document.activeElement;
        const isFormField =
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.isContentEditable);

        // a11y (WCAG 2.1.1): Enter/Space activates a focused role="button"
        // element (our clickable <div>/<span> cards). Native <button> already
        // activates itself, so skip those here.
        if ((event.key === "Enter" || event.code === KEY_SPACE) && active && !isFormField) {
          const activatable = active.closest('[role="button"]');
          if (activatable && !activatable.matches("button")) {
            event.preventDefault();
            activatable.click();
            return;
          }
        }

        // Space = skip turn — but never when focus sits on an interactive
        // control or form field (otherwise it both activates and skips).
        if (event.code === KEY_SPACE && !isFormField) {
          const interactive =
            active &&
            active.closest &&
            active.closest('button, a, [role="button"], input, textarea, select');
          if (interactive) return;
          event.preventDefault();
          this.skipSelected();
        }
      });

      // Scrollable UI surfaces where native touch scrolling / tapping must keep
      // working — the sidebar, every menu, and every modal overlay. Anything
      // outside this set is the game board, where we suppress page bounce and
      // double-tap zoom. Keeping the list here (vs. per-handler) means a new
      // modal only has to be added in one place.
      const isInteractiveSurface = (target) =>
        !!(target && target.closest && target.closest(TOUCH_SCROLL_SURFACES));

      document.addEventListener(
        "touchmove",
        (event) => {
          if (isInteractiveSurface(event.target)) {
            return;
          }
          if (event.cancelable) {
            event.preventDefault();
          }
        },
        { passive: false }
      );

      // #2/#6: on iPad/iOS Safari `user-scalable=no` is ignored, so the page
      // can still pinch-zoom and get stuck zoomed-in over the board. Block the
      // iOS-specific pinch gesture events directly.
      const preventGesture = (event) => {
        event.preventDefault();
      };
      document.addEventListener("gesturestart", preventGesture, { passive: false });
      document.addEventListener("gesturechange", preventGesture, { passive: false });
      document.addEventListener("gestureend", preventGesture, { passive: false });

      // Block double-tap-to-zoom outside scrollable panels (menu/sidebar still
      // need normal taps and scrolling).
      let lastTouchEnd = 0;
      document.addEventListener(
        "touchend",
        (event) => {
          // Only the game board blocks double-tap zoom. Inside menus/modals,
          // preventDefault() here would also cancel the synthesized click, so
          // rapid taps (e.g. picking an army then tapping "Начать бой") would
          // silently fail.
          if (
            !isInteractiveSurface(event.target) &&
            event.timeStamp - lastTouchEnd <= 300 &&
            event.cancelable
          ) {
            event.preventDefault();
          }
          lastTouchEnd = event.timeStamp;
        },
        { passive: false }
      );

      window.addEventListener("resize", () => {
        this.applyResponsiveCanvasSize();
      });
      window.addEventListener("orientationchange", () => {
        this.applyResponsiveCanvasSize();
      });
      window.addEventListener("pagehide", () => {
        this.saveProgressNow();
      });
      window.addEventListener("beforeunload", () => {
        this.saveProgressNow();
      });

      this.sidebar.addEventListener("click", (event) => {
        const target = event.target.closest("button[data-action]");
        if (!target) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const action = target.dataset.action;
        // #5: during the AI's turn the human must not act for the bot. Block
        // in-game unit actions; menu/back/restart/surrender stay available.
        if (
          this.mode === "ai" &&
          this.currentPlayer === 2 &&
          (action === "equip-weapon" ||
            action === "skip" ||
            action === "draw-part" ||
            action === "craft" ||
            action === "craft-armor" ||
            action === "castle-heal" ||
            action === "throw-rock" ||
            action === "build-tower-mode" ||
            action === "build-bridge-mode" ||
            action === "mage-attack-mode" ||
            action === "mage-drain-mode" ||
            action === "mage-heal-mode" ||
            action === "mage-burn-bridge-mode" ||
            action === "mage-ward-mode" ||
            action === "mage-ward-pick" ||
            action === "mage-ward-confirm" ||
            action === "mage-attack-damage-step" ||
            action === "mage-attack-confirm" ||
            action === "mage-attack-cancel")
        ) {
          return;
        }
        // Online: block in-game unit actions when it isn't this client's turn.
        if (
          this.online &&
          (this.currentPlayer !== this.myPlayer || this.turnSubmitting) &&
          (action === "equip-weapon" ||
            action === "skip" ||
            action === "draw-part" ||
            action === "craft" ||
            action === "craft-armor" ||
            action === "castle-heal" ||
            action === "throw-rock" ||
            action === "build-tower-mode" ||
            action === "build-bridge-mode" ||
            action === "mage-attack-mode" ||
            action === "mage-drain-mode" ||
            action === "mage-heal-mode" ||
            action === "mage-burn-bridge-mode" ||
            action === "mage-ward-mode" ||
            action === "mage-ward-pick" ||
            action === "mage-ward-confirm" ||
            action === "mage-attack-damage-step" ||
            action === "mage-attack-confirm" ||
            action === "mage-attack-cancel" ||
            action === "end-turn")
        ) {
          this.message = tr("Сейчас ход соперника.");
          this.renderSidebar();
          return;
        }
        if (action === "undo") {
          this.performUndo();
          return;
        }
        if (action === "throw-rock") {
          this.toggleRockMode();
          return;
        }
        if (action === "build-tower-mode") {
          this.toggleBuildMode('tower');
          return;
        }
        if (action === "build-bridge-mode") {
          this.toggleBuildMode('bridge');
          return;
        }
        if (action === "mage-attack-mode") {
          this.toggleMageMode('attack');
          return;
        }
        if (action === "mage-drain-mode") {
          this.toggleMageMode('drain');
          return;
        }
        if (action === "mage-heal-mode") {
          this.toggleMageMode('heal');
          return;
        }
        if (action === "mage-burn-bridge-mode") {
          this.toggleMageMode('burn-bridge');
          return;
        }
        if (action === "mage-ward-mode") {
          this.toggleMageWardMode();
          return;
        }
        if (action === "mage-ward-pick") {
          this.pickMageWardUnit(Number(target.dataset.unitId));
          return;
        }
        if (action === "mage-attack-damage-step") {
          this.stepMageAttackDamage(Number(target.dataset.step));
          return;
        }
        if (action === "mage-attack-confirm") {
          this.recordUndo();
          this.confirmMageAttack();
          return;
        }
        if (action === "mage-attack-cancel") {
          this.pendingMageAttack = null;
          this.mageMode = null;
          this.mageTargets = [];
          this.renderSidebar();
          return;
        }
        // P0 undo: snapshot before any human action that mutates game state.
        if (
          action === "skip" ||
          action === "draw-part" ||
          action === "craft" ||
          action === "craft-armor" ||
          action === "castle-heal" ||
          action === "mage-ward-confirm"
        ) {
          this.recordUndo();
        }
        if (action === 'finish-tutorial') {
          this.tutorialMode = false;
          this.tutorialStep = 0;
          this.renderSidebar();
          return;
        }
        if (action === "equip-weapon") {
          const unitId = Number(target.dataset.unitId);
          this.equipPendingWeapon(unitId);
          return;
        }
        if (this.pendingWeaponEquip) {
          this.blockUntilWeaponEquipped();
          return;
        }
        if (action === "start-pvp") {
          this.requestFullscreenIfNeeded();
          this.showDraftScreen('pvp', null, null);
          return;
        }
        if (action === "continue-save") {
          this.requestFullscreenIfNeeded();
          const saved = this.readSavedState();
          if (saved && this.restoreSavedState(saved)) {
            this.pendingSavedState = null;
            this.renderSidebar();
          }
          return;
        }
        if (action === "skip") {
          this.skipSelected();
          return;
        }
        if (action === "end-turn") {
          this.endTurn();
          return;
        }
        if (action === "surrender") {
          this.showSurrenderModal();
          return;
        }
        if (action === "back-menu") {
          if (this.pendingWeaponEquip) {
            this.message = tr("Сначала экипируйте оружие.");
            this.renderSidebar();
            return;
          }
          this.stopConfetti();
          this.backToMenu();
          return;
        }
        if (action === "restart") {
          this.stopConfetti();
          this.startMatch(this.mode, this.aiDifficulty, this.currentStoryTask, this.lastCustomPositions);
          return;
        }
        if (action === "draw-part") {
          this.drawArtifact();
          return;
        }
        if (action === "clear-preview") {
          this.previewUnitId = null;
          this.renderSidebar();
          return;
        }
        if (action === "craft") {
          const idx = Number(target.dataset.idx);
          this.craftWeapon(idx);
        }
        if (action === "craft-armor") {
          const idx = Number(target.dataset.idx);
          this.craftArmor(idx);
          return;
        }
        if (action === "castle-heal") {
          this.applyCastleHealing();
          return;
        }
        if (action === "mage-ward-confirm") {
          this.confirmMageWard();
          return;
        }
        if (action === "transfer-open") {
          this.transferOpenUnitId = Number(target.dataset.unitId);
          this.transferTargetId = null;
          this.transferSelection = {};
          this.renderSidebar();
          return;
        }
        if (action === "transfer-pick-target") {
          this.transferTargetId = Number(target.dataset.unitId);
          this.transferSelection = {};
          this.renderSidebar();
          return;
        }
        if (action === "transfer-toggle") {
          this.toggleTransferSelection(target.dataset.kind, target.dataset.part);
          this.renderSidebar();
          return;
        }
        if (action === "transfer-confirm") {
          this.confirmTransfer();
          return;
        }
        if (action === "transfer-cancel") {
          this.transferOpenUnitId = null;
          this.transferTargetId = null;
          this.transferSelection = {};
          this.renderSidebar();
          return;
        }
      });

      // Mute button
      const muteBtn = document.getElementById('muteBtn');
      if (muteBtn) {
        muteBtn.textContent = this.music.isMuted() ? '🔇' : '🔊';
        muteBtn.addEventListener('click', () => {
          const muted = this.music.toggleMute();
          muteBtn.textContent = muted ? '🔇' : '🔊';
        });
      }

      // Mobile menu arrow buttons
      const _closeMenuPanels = () => {
        document.getElementById('menuLeft')?.classList.remove('panel-open');
        document.getElementById('menuRight')?.classList.remove('panel-open');
        document.getElementById('menuArrowLeft')?.classList.remove('panel-open');
        document.getElementById('menuArrowRight')?.classList.remove('panel-open');
        document.getElementById('menuBackdrop')?.classList.remove('visible');
      };
      const arrowLeft = document.getElementById('menuArrowLeft');
      if (arrowLeft) {
        arrowLeft.addEventListener('click', () => {
          const leftPanel = document.getElementById('menuLeft');
          const isOpen = leftPanel?.classList.contains('panel-open');
          _closeMenuPanels();
          if (!isOpen) {
            leftPanel?.classList.add('panel-open');
            arrowLeft.classList.add('panel-open');
            document.getElementById('menuBackdrop')?.classList.add('visible');
          }
        });
      }
      const arrowRight = document.getElementById('menuArrowRight');
      if (arrowRight) {
        arrowRight.addEventListener('click', () => {
          const rightPanel = document.getElementById('menuRight');
          const isOpen = rightPanel?.classList.contains('panel-open');
          _closeMenuPanels();
          if (!isOpen) {
            rightPanel?.classList.add('panel-open');
            arrowRight.classList.add('panel-open');
            document.getElementById('menuBackdrop')?.classList.add('visible');
          }
        });
      }
      document.getElementById('menuBackdrop')?.addEventListener('click', _closeMenuPanels);

      // B3: rules modal — close on ✕ or backdrop click.
      const rulesModal = document.getElementById('rulesModal');
      document.getElementById('rulesModalClose')?.addEventListener('click', () => {
        rulesModal?.classList.remove('active');
      });
      rulesModal?.addEventListener('click', (event) => {
        if (event.target === rulesModal) rulesModal.classList.remove('active');
      });
      document.getElementById('rulesModalBody')?.addEventListener('click', (event) => {
        const btn = (event.target as Element).closest('[data-action]') as HTMLElement | null;
        if (!btn) return;
        if (btn.dataset.action === 'start-tutorial') {
          rulesModal?.classList.remove('active');
          this.requestFullscreenIfNeeded();
          this.startTutorial();
        }
      });

      // B4: tutorial controls (Далее / Понятно / Пропустить).
      document.getElementById('tutNext')?.addEventListener('click', () => {
        if (!this._tutSteps) return;
        if (this._tutIndex < this._tutSteps.length - 1) {
          this._tutIndex += 1;
          this.showTutorialStep();
        } else {
          this.finishTutorial();
        }
      });
      document.getElementById('tutSkip')?.addEventListener('click', () => this.finishTutorial());

      // Menu action handler — document-level so sub-modals (outside #menuOverlay)
      // also bubble up correctly.
      document.addEventListener('click', (event) => {
        const target = event.target as Element;

        // ── Close sub-modal buttons ──
        const closeBtn = target.closest('[data-close-modal]') as HTMLElement | null;
        if (closeBtn) {
          const id = closeBtn.dataset.closeModal;
          if (id) document.getElementById(id)?.classList.remove('active');
          return;
        }

        // ── Backdrop click closes sub-modals ──
        if (target.classList.contains('submenu-overlay') && target.classList.contains('active')) {
          target.classList.remove('active');
          return;
        }

        // ── Dynamic content: account bar, story stars ──
        if (target.closest('#settingsAccountBar')) {
          event.preventDefault();
          this.showAccountModal();
          return;
        }
        const levelDot = target.closest('.chain-star[data-chapter][data-game][data-task]') as HTMLElement | null;
        if (levelDot && !levelDot.classList.contains('locked')) {
          event.preventDefault();
          const ci = parseInt(levelDot.dataset.chapter);
          const gi = parseInt(levelDot.dataset.game);
          const ti = parseInt(levelDot.dataset.task);
          this.startStoryLevel(ci, gi, ti);
          return;
        }

        // ── Only handle data-action when menu is active ──
        const menuActive = document.getElementById('menuOverlay')?.classList.contains('active');
        const subModalActive = ['playModal', 'aboutModal', 'settingsModal'].some(
          id => document.getElementById(id)?.classList.contains('active')
        );
        if (!menuActive && !subModalActive) return;

        const btn = target.closest('[data-action]') as HTMLElement | null;
        if (!btn) return;
        event.preventDefault();
        const action = btn.dataset.action;

        // ── 3 main nav buttons ──
        if (action === 'show-play') { this.showPlayModal(); return; }
        if (action === 'show-about') { this.showAboutModal(); return; }
        if (action === 'show-settings') { this.showSettingsModal(); return; }

        if (action === 'save-nickname') { this.saveNickname(); return; }

        if (action === 'show-account') { this.showAccountModal(); return; }
        if (action === 'google-signin') { this.startGoogleSignin(); return; }
        if (action === 'signout') { this.signout(); return; }

        if (action === 'toggle-mute-settings') {
          const muted = this.music.toggleMute();
          const muteBtn = document.getElementById('muteBtn');
          if (muteBtn) muteBtn.textContent = muted ? '🔇' : '🔊';
          const body = document.getElementById('settingsModalBody');
          if (body) body.innerHTML = this._buildSettingsModalHTML();
          return;
        }
        if (action === 'show-rules') {
          const body = document.getElementById('rulesModalBody');
          if (body) body.innerHTML = this._buildRulesHTML();
          document.getElementById('rulesModal')?.classList.add('active');
          return;
        }
        if (action === 'continue-story') {
          this.requestFullscreenIfNeeded();
          const nextTask = this.findNextStoryTask();
          if (nextTask) { this._closeSubModals(); this.startMatch('ai', null, nextTask); }
          return;
        }
        if (action === 'start-pvp') {
          this.requestFullscreenIfNeeded();
          this._closeSubModals();
          this.showDraftScreen('pvp', null, null);
          return;
        }
        if (action === 'start-ai-easy') {
          this.requestFullscreenIfNeeded();
          this._closeSubModals();
          this.showDraftScreen('ai', 'easy', null);
          return;
        }
        if (action === 'start-ai-medium') {
          this.requestFullscreenIfNeeded();
          this._closeSubModals();
          this.showDraftScreen('ai', 'medium', null);
          return;
        }
        if (action === 'start-ai-hard') {
          this.requestFullscreenIfNeeded();
          this._closeSubModals();
          this.showDraftScreen('ai', 'hard', null);
          return;
        }
        if (action === 'start-ai-impossible') {
          this.requestFullscreenIfNeeded();
          this._closeSubModals();
          this.showDraftScreen('ai', 'impossible', null);
          return;
        }
        if (action === 'play-online' || action === 'play-online-create') {
          this.requestFullscreenIfNeeded();
          this._closeSubModals();
          this.openOnlineMenu();
          return;
        }
        if (action === 'play-online-random') {
          this.requestFullscreenIfNeeded();
          this._closeSubModals();
          this.openOnlineMenu('random');
          return;
        }
        if (action === 'start-tutorial') {
          this.requestFullscreenIfNeeded();
          this._closeSubModals();
          document.getElementById('rulesModal')?.classList.remove('active');
          this.startTutorial();
          return;
        }
        if (action === 'continue-save') {
          this.requestFullscreenIfNeeded();
          const saved = this.readSavedState();
          if (saved && this.restoreSavedState(saved)) {
            this.pendingSavedState = null;
            this._closeSubModals();
            this.hideNewMenu();
            this.renderSidebar();
          }
          return;
        }
      });

      // Track A: online modal (create/join/random) + disconnect overlay.
      const onlineModal = document.getElementById('onlineModal');
      if (onlineModal && !this._onlineHandlerBound) {
        this._onlineHandlerBound = true;
        onlineModal.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-action]');
          if (!btn) return;
          event.preventDefault();
          const action = btn.dataset.action;
          if (action === 'online-close') return this.hideOnlineModal(true);
          if (action === 'online-show-create') return this.onlineCreateRoom();
          if (action === 'online-show-join') return this.renderOnlineModal('join');
          if (action === 'online-show-random') return this.onlineQueue();
          if (action === 'online-join-go') {
            const input = document.getElementById('onlineCodeInput');
            return this.onlineJoinRoom(input ? input.value : '');
          }
          if (action === 'online-copy') {
            const codeEl = document.getElementById('onlineCodeText');
            if (codeEl && navigator.clipboard) {
              navigator.clipboard.writeText(codeEl.textContent || '').catch(() => {});
              const hint = document.getElementById('onlineCopyHint');
              if (hint) hint.textContent = tr('Скопировано!');
            }
            return;
          }
          if (action === 'online-cancel') return this.cancelOnlineFlow();
          if (action === 'online-menu') return this.renderOnlineModal('menu');
        });
        // Submit code on Enter.
        onlineModal.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && event.target && event.target.id === 'onlineCodeInput') {
            event.preventDefault();
            this.onlineJoinRoom(event.target.value);
          }
        });
      }
      const disconnectModal = document.getElementById('onlineDisconnectModal');
      if (disconnectModal && !this._disconnectHandlerBound) {
        this._disconnectHandlerBound = true;
        disconnectModal.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-action]');
          if (btn && btn.dataset.action === 'online-leave') {
            disconnectModal.classList.remove('active');
            this.backToMenu();
            this.showNewMenu();
          }
        });
      }

      // SEC-001 fix (Phase 1 plan): account modal event listener removed
      // along with the modal HTML; real auth in Phase 3.

      // ✅ iOS FIX: Victory overlay - только один обработчик
      if (this.victoryOverlay && !this._victoryHandlerBound) {
        this._victoryHandlerBound = true;
        this.victoryOverlay.addEventListener("click", (event) => {
          const target = event.target.closest("button[data-action]");
          if (!target) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const action = target.dataset.action;
          if (action === "online-rematch") {
            this.stopConfetti();
            this.requestRematch();
            return;
          }
          if (action === "restart") {
            this.stopConfetti();
            this.startMatch(this.mode, this.aiDifficulty, this.currentStoryTask, this.lastCustomPositions);
            return;
          }
          if (action === "back-menu") {
            if (this.pendingWeaponEquip) {
              this.message = tr("Сначала экипируйте оружие.");
              this.renderSidebar();
              return;
            }
            this.stopConfetti();
            this.backToMenu();
          }
        });
      }
    }

    applyResponsiveCanvasSize() {
      const wrap = this.canvasWrap || this.canvas.parentElement;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const safeScale = Math.max(0.1, Math.min(rect.width / WIDTH, rect.height / HEIGHT));
      const drawWidth  = Math.floor(WIDTH  * safeScale);
      const drawHeight = Math.floor(HEIGHT * safeScale);
      const physW = Math.floor(drawWidth  * dpr);
      const physH = Math.floor(drawHeight * dpr);
      // Пропускаем если ничего не изменилось
      if (this._lastPhysW === physW && this._lastPhysH === physH) return;
      this._lastPhysW = physW;
      this._lastPhysH = physH;
      this.canvas.width  = physW;
      this.canvas.height = physH;
      this.canvas.style.width  = drawWidth  + "px";
      this.canvas.style.height = drawHeight + "px";
      // setTransform сбрасывает предыдущий масштаб перед применением нового
      this.ctx.setTransform(safeScale * dpr, 0, 0, safeScale * dpr, 0, 0);
    }

    requestFullscreenIfNeeded() {
      if (this.fullscreenRequested || !isMobileDevice()) {
        return;
      }
      this.fullscreenRequested = true;
      if (document.fullscreenElement) {
        return;
      }
      const target = document.documentElement;
      if (!target || typeof target.requestFullscreen !== "function") {
        return;
      }
      try {
        const promise = target.requestFullscreen({ navigationUI: "hide" });
        if (promise && typeof promise.catch === "function") {
          promise.catch(() => {});
        }
      } catch (error) {
        try {
          const fallback = target.requestFullscreen();
          if (fallback && typeof fallback.catch === "function") {
            fallback.catch(() => {});
          }
        } catch (fallbackError) {
          // Полноэкранный режим может быть недоступен, это не критично.
        }
      }
    }

    queueSaveProgress() {
      if (this.online) return; // online matches are server-side, not localStorage
      if (this.screen !== "game" || this.winner !== null || this.saveQueued) {
        return;
      }
      this.saveQueued = true;
      setTimeout(() => {
        this.saveQueued = false;
        this.saveProgressNow();
      }, 0);
    }

    saveProgressNow() {
      if (this.online) return; // online matches are server-side, not localStorage
      if (this.screen !== "game" || this.winner !== null) return;
      // Phase 2: writeSnapshot from @kc/game-rules handles storage + quotas.
      writeSnapshot(this.createSaveSnapshot());
    }

    createSaveSnapshot() {
      return {
        version: SAVE_VERSION,
        screen: this.screen,
        mode: this.mode,
        currentPlayer: this.currentPlayer,
        activatedCount: this.activatedCount,
        turnNumber: this.turnNumber,
        winner: this.winner,
        message: this.message,
        lastEvent: this.lastEvent,
        player1Bottom: this.player1Bottom,
        castleP1Col: getCastleP1Col(),
        castleP2Col: getCastleP2Col(),
        shieldTurns: {
          1: this.shieldTurns[1] || 0,
          2: this.shieldTurns[2] || 0
        },
        damageBuff: {
          1: this.damageBuff[1] || 0,
          2: this.damageBuff[2] || 0
        },
        pendingWeaponEquip: this.pendingWeaponEquip
          ? {
              name: this.pendingWeaponEquip.name,
              amount: this.pendingWeaponEquip.amount,
              icon: this.pendingWeaponEquip.icon || "",
              allowedTypes: Array.isArray(this.pendingWeaponEquip.allowedTypes)
                ? this.pendingWeaponEquip.allowedTypes.slice()
                : null,
              forbidTypes: Array.isArray(this.pendingWeaponEquip.forbidTypes)
                ? this.pendingWeaponEquip.forbidTypes.slice()
                : null,
              archerOnly: !!this.pendingWeaponEquip.archerOnly
            }
          : null,
        previewUnitId: this.previewUnitId,
        selectedUnitId: this.selectedUnit ? this.selectedUnit.id : null,
        units: this.board.units.map((u) => ({
          id: u.id,
          player: u.player,
          type: u.type,
          row: u.row,
          col: u.col,
          maxHp: u.maxHp,
          hp: u.hp,
          startArmor: u.startArmor,
          armor: u.armor,
          maxArmor: u.maxArmor,
          damage: u.damage,
          maxMoves: u.maxMoves,
          movesLeft: u.movesLeft,
          done: u.done,
          activated: u.activated,
          visualRow: u.visualRow,
          visualCol: u.visualCol,
          dying: u.dying,
          deathProgress: u.deathProgress,
          weapon: u.weapon
            ? {
                name: u.weapon.name,
                icon: u.weapon.icon || "",
                amount: u.weapon.amount
              }
            : null,
          armorGear: u.armorGear
            ? {
                name: u.armorGear.name,
                icon: u.armorGear.icon || "",
                amount: u.armorGear.amount
              }
            : null,
          backpack: Object.assign({}, u.backpack),
          wardedBy: u.wardedBy ?? null,
          ...(u.type === 'mage' ? { energy: u.energy, maxEnergy: u.maxEnergy, warding: u.warding.slice() } : {}),
        })),
        droppedBackpacks: this.droppedBackpacks.map((d) => ({
          row: d.row,
          col: d.col,
          parts: Object.assign({}, d.parts),
          weapon: d.weapon ? { ...d.weapon } : null,
          armorGear: d.armorGear ? { ...d.armorGear } : null,
        })),
        // Buried pickups must persist — re-scattering on reload would both
        // duplicate loot and move it out from under the cells players probed.
        hiddenPickups: (this.hiddenPickups || []).map((p) => ({ ...p })),
        // FUNC-001 fix (Phase 1 plan): persist enough state to resume an
        // AI/story match — previously the snapshot only worked for PvP.
        aiDifficulty: this.aiDifficulty,
        currentStoryTask: this.currentStoryTask
          ? {
              ci: this.currentStoryTask.ci,
              gi: this.currentStoryTask.gi,
              ti: this.currentStoryTask.ti
            }
          : null,
        mapTheme: this.mapTheme,
        p1Faction: this.p1Faction,
        p2Faction: this.p2Faction,
        sessionWins: {
          1: this.sessionWins[1] || 0,
          2: this.sessionWins[2] || 0
        },
        towers: getTowers().map((t) => ({ row: t.row, col: t.col })),
        constructions: getConstructions().map((c) => ({ ...c })),
        bridgeDurability: { ...getBridgeDurability() },
        ruins: { ...getRuins() },
        ruins2: { ...getRuins2() },
        terrain: getTerrain().map((t) => ({ row: t.row, col: t.col, type: t.type })),
      };
    }

    // Phase 2: readSavedState/clearSave/hasContinuableSave delegate to
    // @kc/game-rules/save. readSavedStateFromStore returns a fully-validated
    // GameSnapshot (incl. T25 damage cap on units) — restoreSavedState below
    // re-extracts the fields it cares about, idempotent on already-sanitised input.
    readSavedState() {
      return readSavedStateFromStore();
    }

    clearSave() {
      clearSaveInStore();
    }

    hasContinuableSave() {
      // FUNC-001 fix is preserved in @kc/game-rules/save.isContinuableSnapshot:
      // accepts both PvP and AI matches (story = AI + currentStoryTask).
      return isContinuableSnapshot(this.readSavedState());
    }

    // ── Account ──────────────────────────────────────────────
    // Returns the signed-in user's display label (Google or email login),
    // or null when signed out. Drives the account bar in the menu.
    getCurrentUser() {
      if (!this.authUser) return null;
      return this.authUser.displayName || this.authUser.email || tr('игрок');
    }

    _AUTH_CACHE_KEY = 'kc_auth_user';

    saveAuthUserCache(user) {
      try {
        localStorage.setItem(this._AUTH_CACHE_KEY, JSON.stringify({
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          emailVerified: user.emailVerified,
          isGuest: user.isGuest,
        }));
      } catch (_) {}
    }

    loadAuthUserCache() {
      try {
        const raw = localStorage.getItem(this._AUTH_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.id !== 'string') return null;
        return parsed;
      } catch (_) { return null; }
    }

    clearAuthUserCache() {
      try { localStorage.removeItem(this._AUTH_CACHE_KEY); } catch (_) {}
    }

    async tryAutoLogin() {
      // 1. Google OAuth popup fallback: the callback page wrote to sessionStorage
      //    when there was no opener window.
      try {
        const pending = sessionStorage.getItem('kc.pendingAuth');
        if (pending) {
          sessionStorage.removeItem('kc.pendingAuth');
          const data = JSON.parse(pending);
          if (data && typeof data.accessToken === 'string' && data.user) {
            this.authAccessToken = data.accessToken;
            this.authUser = data.user;
            this.api.setAccessToken(data.accessToken);
            this.saveAuthUserCache(data.user);
            this.syncProgressFromServer();
            return true;
          }
        }
      } catch (_) {}

      // 2. Try to renew via the HttpOnly refresh-token cookie (set by the server
      //    on login). Access token stays in memory — never in localStorage.
      try {
        const ok = await this.api.refresh();
        if (ok) {
          const user = await this.api.me();
          this.authAccessToken = this.api.getAccessToken();
          this.authUser = user;
          this.saveAuthUserCache(user);
          this.syncProgressFromServer();
          return true;
        }
      } catch (_) {}

      // 3. Refresh failed — clear stale cache so UI doesn't show stale name.
      this.clearAuthUserCache();
      return false;
    }

    // ── Progress ──────────────────────────────────────────────
    _defaultProgress() {
      return {
        chapters: STORY_CHAPTERS.map(ch => ({
          games: ch.games.map(g => ({ tasks: g.tasks.map(() => false) }))
        }))
      };
    }
    _mergeProgress(raw) {
      // Merge saved progress with current story structure (handles story updates)
      const result = { chapters: [] };
      STORY_CHAPTERS.forEach((ch, ci) => {
        const chP = (raw.chapters && raw.chapters[ci]) || { games: [] };
        result.chapters.push({
          games: ch.games.map((g, gi) => {
            const gP = (chP.games && chP.games[gi]) || { tasks: [] };
            return { tasks: g.tasks.map((_, ti) => !!(gP.tasks && gP.tasks[ti])) };
          })
        });
      });
      return result;
    }
    loadProgress() {
      try {
        const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY));
        if (raw && Array.isArray(raw.chapters)) return this._mergeProgress(raw);
      } catch(e) {}
      return this._defaultProgress();
    }
    saveProgress(data) {
      try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(data)); } catch(e) {}
      // Mirror to the server for logged-in (non-guest) users so progress follows
      // the account across devices. Fully best-effort: any failure is ignored and
      // the localStorage copy remains the source of truth.
      this.pushProgressToServer(data);
    }

    /** True when a real (non-guest) account is signed in. */
    _hasAccount() {
      return !!(this.authAccessToken && this.authUser && !this.authUser.isGuest);
    }

    /** Debounced fire-and-forget upload of the progress blob to the server. */
    pushProgressToServer(data) {
      if (!this._hasAccount() || !this.api) return;
      clearTimeout(this._progressPushTimer);
      this._progressPushTimer = setTimeout(() => {
        this.api.putProgress(data).catch(() => {});
      }, 600);
    }

    /** OR-merge two progress objects (a completed task in either stays completed). */
    _mergeTwoProgress(a, b) {
      const na = this._mergeProgress(a || { chapters: [] });
      const nb = this._mergeProgress(b || { chapters: [] });
      const result = { chapters: [] };
      na.chapters.forEach((chA, ci) => {
        const chB = nb.chapters[ci] || { games: [] };
        result.chapters.push({
          games: chA.games.map((gA, gi) => {
            const gB = chB.games[gi] || { tasks: [] };
            return { tasks: gA.tasks.map((tA, ti) => !!tA || !!(gB.tasks && gB.tasks[ti])) };
          }),
        });
      });
      return result;
    }

    /**
     * Pull server progress for the signed-in account, union it with the local
     * copy, persist the merged result both locally and back to the server, then
     * refresh any open progress UI. Best-effort — silently no-ops if offline or
     * not signed in.
     */
    async syncProgressFromServer() {
      if (!this._hasAccount() || !this.api) return;
      try {
        const serverData = await this.api.getProgress();
        const local = this.loadProgress();
        const merged = serverData ? this._mergeTwoProgress(local, serverData) : local;
        try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(merged)); } catch (e) {}
        // Push the unioned result up so the server reflects this device's progress too.
        this.api.putProgress(merged).catch(() => {});
        // Refresh visible progress (menu campaign card + settings tree).
        if (document.getElementById('menuOverlay')?.classList.contains('active')) {
          this.renderNewMenu();
          const settings = document.getElementById('settingsModal');
          if (settings && settings.classList.contains('active')) {
            const sb = document.getElementById('settingsModalBody');
            if (sb) sb.innerHTML = this._buildSettingsModalHTML();
          }
        }
      } catch (e) {}
    }

    // ── New menu ──────────────────────────────────────────────
    renderNewMenu() {
      const overlay = document.getElementById('menuOverlay');
      if (!overlay) return;
      overlay.classList.add('active');
      this.music.playHall();
      document.getElementById('menuButtons').innerHTML = this._buildMenuButtonsHTML();
    }

    showNewMenu() { this.renderNewMenu(); }

    hideNewMenu() {
      const overlay = document.getElementById('menuOverlay');
      if (overlay) overlay.classList.remove('active');
      this._closeSubModals();
    }

    _closeSubModals() {
      ['aboutModal', 'playModal', 'settingsModal'].forEach(id => {
        document.getElementById(id)?.classList.remove('active');
      });
    }

    showPlayModal() {
      this._closeSubModals();
      const body = document.getElementById('playModalBody');
      if (body) body.innerHTML = this._buildPlayModalHTML();
      document.getElementById('playModal')?.classList.add('active');
    }

    showAboutModal() {
      this._closeSubModals();
      const body = document.getElementById('aboutModalBody');
      if (body) body.innerHTML = this._buildAboutModalHTML();
      document.getElementById('aboutModal')?.classList.add('active');
    }

    showSettingsModal() {
      this._closeSubModals();
      const body = document.getElementById('settingsModalBody');
      if (body) body.innerHTML = this._buildSettingsModalHTML();
      document.getElementById('settingsModal')?.classList.add('active');
    }

    _buildMenuLeftHTML() {
      return '';
    }

    _buildRulesHTML() {
      if (getLang() === 'en') return this._buildRulesHTML_en();
      return `
    <div class="rules" style="font-size:12px">
      <h4>⚔️ Рыцари и Замки</h4>
      <p>Средневековая пошаговая стратегия на поле 20×20</p>

      <h4>🎯 Цель игры</h4>
      <p>Уничтожить всех воинов противника или добиться его капитуляции.</p>

      <h4>🗺 Поле боя</h4>
      <p><strong>Размер:</strong> 20 × 20 клеток</p>
      <p><strong>Замки</strong> (4×4) — стартовые позиции игроков</p>
      <p><strong>🏰 Лечение в замке:</strong> воин в своём замке полностью восстанавливает ❤️ HP и 🛡 защиту — тратит на это весь ход целиком</p>
      <p><strong>🧙 Башня Мага</strong> — на старте боя башен на карте нет; рыцарь может <strong>построить</strong> башню на пустой клетке (см. «Катапульта и постройки»). Стрелки на башне получают бонус к дальности</p>
      <p><strong>🎁 Закопанная добыча</strong> — невидимые предметы разбросаны по всей карте (не в отдельной зоне), подбираются автоматически при проходе по клетке</p>

      <h4>👥 Войска</h4>
      <p>Каждый игрок управляет <strong>11 воинами</strong>. Состав выбирается перед боем среди 8 готовых пресетов:</p>
      <ul>
        <li>🛡 <strong>Рыцарь:</strong> ❤️ 3 | ⚔ 5 | 🛡 4 | 🏃 2 — ближний бой (↑↓←→)</li>
        <li>🐎 <strong>Конный:</strong> ❤️ 5 | ⚔ 6 | 🛡 3 | 🏃 3 — прыжок через врага</li>
        <li>🏹 <strong>Лучник:</strong> ❤️ 3 | ⚔ 3 | 🛡 1 | 🏃 3 — зона 5×5</li>
        <li>🪨 <strong>Катапульта:</strong> ❤️ 2 | ⚔ 7 | 🛡 1 | 🏃 2 — дальний бой 3–6 клеток, мёртвая зона вблизи</li>
        <li>🎯 <strong>Арбалетчик:</strong> ❤️ 3 | ⚔ 5 | 🛡 2 | 🏃 2 — пробивной выстрел: 2 хода, бьёт по прямой на 2 клетки насквозь (задевает и своих!)</li>
        <li>⚡ <strong>Самурай:</strong> ❤️ 2 | ⚔ 5 | 🛡 1 | 🏃 3 — ближний бой в 8 направлениях (+ диагонали)</li>
        <li>🧙 <strong>Боевой маг:</strong> ❤️ 2 | ⚔ 0 (весь урон — из энергии) | 🛡 0 | 🏃 2 — 4 способности вместо обычной атаки, см. ниже</li>
      </ul>

      <h4>⚔️ Боевая механика</h4>
      <p>Урон наносится в два этапа:</p>
      <p>1. Сначала снимается <strong>🛡 Защита</strong></p>
      <p>2. Когда защита = 0 → урон идёт в <strong>❤️ Здоровье</strong></p>
      <p>3. Здоровье = 0 → воин погибает</p>
      <p><em>Пример: Воин с 🛡4 ❤️3 получает 6 урона → Результат: 🛡0 ❤️1</em></p>

      <h4>🔄 Структура хода</h4>
      <p>• За один ход вы управляете <strong>до 3 воинов</strong></p>
      <p>• Если осталось меньше 3 — ходят все оставшиеся</p>
      <p>• Каждое действие тратит <strong>очки движения</strong></p>
      <p>• Когда 3 воина завершили действия → ход переходит сопернику</p>

      <h4>🗡 Атака и движение</h4>
      <p><strong>Движение у всех воинов — только по прямой</strong> (↑↓←→, без диагоналей), 1 клетка = 1 очко. Лучник и Катапульта за один раз проходят до 2–3 клеток по прямой линии; остальные — по 1 клетке за шаг.</p>

      <p><strong>🛡 Рыцарь и ⚡ Самурай — обычный ближний бой</strong></p>
      <p><strong>Атака (1 очко):</strong> бьёт врага на соседней клетке и остаётся на месте — без прыжка. Рыцарь атакует только по прямой (↑↓←→), Самурай — ещё и по диагоналям (8 направлений)</p>

      <p><strong>🐎 Конный — единственный, кто прыгает</strong></p>
      <p><strong>Атака (2 очка):</strong></p>

      <p><strong>1) Прямая атака — прыжок через врага</strong></p>
      <pre style="font-size:11px;line-height:1.5;margin:6px 0;padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#ffe3b2;font-family:monospace">
    ┏━━━━┓
    ┃ ✓  ┃  ← Приземление
    ┣━━━━┫
    ┃ 🔴 ┃  ← Враг (урон)
    ┣━━━━┫
    ┃ 🛡 ┃  ← Ваш воин
    ┗━━━━┛</pre>
      <p>⚠️ За врагом должна быть свободная клетка</p>

      <p><strong>2) Атака буквой "Г" (L-атака)</strong></p>
      <p>① Встаёте <strong>НА врага</strong> (прыжок на его клетку)</p>
      <p>② Уходите <strong>в бок</strong> от него (на соседнюю клетку)</p>
      <p>③ Враг получает урон при прыжке</p>
      <pre style="font-size:11px;line-height:1.5;margin:6px 0;padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#ffe3b2;font-family:monospace">
    ┏━━━━┳━━━━┓
    ┃ ②✓ ┃ 🔴① ┃  🔴 Враг
    ┣━━━━╋━━━━┫  ① Прыжок НА врага
    ┃    ┃ 🐎  ┃  ② Уход в бок (влево)
    ┗━━━━┻━━━━┛  ✓ Приземление</pre>
      <p>🌊 <strong>Прыжок через реку:</strong> за 2 очка Конный перепрыгивает реку шириной ровно в 1 клетку на свободный дальний берег (мосты переходятся как обычно)</p>

      <p><strong>🏹 Лучник</strong></p>
      <p><strong>Движение:</strong> до 3 клеток по прямой (↑↓←→) за один раз, 1 клетка = 1 очко</p>
      <p><strong>Атака:</strong> стреляет в любого врага в зоне 5×5 вокруг себя (включая диагонали); стоимость = расстояние до цели в клетках (1–2 очка)</p>
      <p>Тактика: занять позицию → обстреливать квадратную зону → отойти</p>
      <pre style="font-size:10px;line-height:1.4;margin:6px 0;padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#ffe3b2;font-family:monospace">
  Зона поражения (5×5):
  ┏━━━┳━━━┳━━━┳━━━┳━━━┓
  ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃
  ┣━━━╋━━━╋━━━╋━━━╋━━━┫
  ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃
  ┣━━━╋━━━╋━━━╋━━━╋━━━┫
  ┃🎯 ┃🎯 ┃🏹 ┃🎯 ┃🎯 ┃  🏹 = лучник
  ┣━━━╋━━━╋━━━╋━━━╋━━━┫  🎯 = зона атаки
  ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃
  ┣━━━╋━━━╋━━━╋━━━╋━━━┫
  ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃
  ┗━━━┻━━━┻━━━┻━━━┻━━━┛</pre>

      <h4>🪨 Катапульта и постройки</h4>
      <p><strong>🪨 Катапульта — атака (1 очко):</strong> бьёт по клетке на дистанции 3–6 (мёртвая зона ближе 3), без учёта препятствий. Вместо удара по юниту может за то же 1 очко кинуть валун на ПУСТУЮ клетку в том же радиусе — она превращается в непроходимую скалу (перекрыть проход/дверь замка нельзя — рядом с замками и на реке/мосту/башне камни не сажают). Попадание тем же выстрелом по уже стоящей скале разбивает её обратно в свободную землю</p>

      <p><strong>🏗 Постройка (только 🛡 Рыцарь)</strong></p>
      <p>Встаньте вплотную (по прямой) к цели и потратьте весь ход (ровно 2 очка) — стройка требует 2 таких хода подряд (можно разными рыцарями):</p>
      <ul>
        <li>🗼 <strong>Башня</strong> — на любой свободной клетке</li>
        <li>🌉 <strong>Мост</strong> — только на клетке реки; после постройки имеет 2 очка прочности и разрушается вражеским магом (см. ниже) или обстрелом</li>
      </ul>

      <h4>🧙 Боевой маг</h4>
      <p>Не сражается в ближнем бою — вместо этого копит <strong>⚡ Энергию</strong> (максимум 20, +5 в начале каждого своего хода) и тратит её на 4 способности. Каждая способность стоит <strong>1 ход</strong> + энергию:</p>
      <ul>
        <li>🔥 <strong>Атака</strong> — урон на любом расстоянии, без прямой видимости. Урон выбираете сами (≥1); цена = урон + расстояние (в клетках) энергии</li>
        <li>🛡 <strong>Оберег (Ward)</strong> — бесплатно берёт союзника под защиту; когда его бьют, энергия мага тает 1:1 вместо HP союзника. Если энергия кончится — следующий удар проходит насквозь</li>
        <li>🩸 <strong>Высасывание (Drain)</strong> — только с соседней клетки: забирает 1 ❤️ у любого не защищённого чужим оберегом юнита (даже у своего) и превращает в 5 ⚡ — способ дозаправиться в бою</li>
        <li>💚 <strong>Лечение</strong> — восстанавливает HP себе или союзнику на любом расстоянии; цена = HP + расстояние энергии</li>
        <li>🌉 <strong>Поджечь мост</strong> — уничтожает построенный мост на любом расстоянии одним применением; цена = расстояние × 2 энергии</li>
      </ul>
      <p>🧙 <strong>Башня Мага</strong> на поле — обычная клетка высоты: даёт бонус к дальности стрелкам (лучник/арбалетчик/катапульта), стоящим на ней, но не связана со способностями мага</p>

      <h4>🎁 Закопанная добыча</h4>
      <p>Отдельной зоны руин на карте больше нет — вместо неё в начале боя по всей карте (кроме замков, башен и стартовых клеток) случайно и незаметно закапываются:</p>
      <ul>
        <li>🧩 <strong>Детали для крафта</strong> (Дерево/Металл/Амулет/Рубин/Стрелы) — ~1.5% клеток карты</li>
        <li>⚔️ <strong>Готовое оружие</strong> и 🛡 <strong>броня</strong> — по 1 экземпляру каждого вида за бой</li>
      </ul>
      <p>Предметы невидимы, пока воин не наступит на клетку — тогда деталь сразу уходит в рюкзак, а оружие/броня надевается на него (или на союзника, если найдено больше не подходит носителю). Никакого отдельного действия/хода тратить не нужно — подбор происходит на обычном ходу движения.</p>

      <h4>🏁 Конец игры</h4>
      <p>Победа: ☠️ Все враги уничтожены | 🏳️ Противник сдался</p>

      <h4>⌨️ Управление</h4>
      <p><strong>ЛКМ</strong> — выбрать/действие | <strong>ПКМ/Пробел</strong> — пропустить ход</p>

      <h4>💡 Тактика</h4>
      <p>✅ Сохраняйте защиту воинам</p>
      <p>✅ Постройте башню рыцарем — бонус к дальности решает перестрелки</p>
      <p>✅ Прыжок и L-атака Конного бьют сразу, не тратя ходы на подход</p>
      <p>✅ Лучники — hit-and-run</p>
      <p>✅ Ведите разведку по клеткам — под ними может быть закопанное оружие или броня</p>
      <p>✅ Катапульта может завалить проход камнем вместо выстрела по юниту</p>
      <hr class="menu-rule-sep" style="margin-top:16px">
      <button class="btn primary" data-action="start-tutorial" style="margin-top:8px;width:100%">🎓 Начать обучение — пошаговые подсказки</button>
    </div>`;
    }

    _buildRulesHTML_en() {
      return `
    <div class="rules" style="font-size:12px">
      <h4>⚔️ Knights & Castles</h4>
      <p>A medieval turn-based strategy on a 20×20 board</p>

      <h4>🎯 Goal</h4>
      <p>Destroy all of the enemy's warriors or force them to surrender.</p>

      <h4>🗺 Battlefield</h4>
      <p><strong>Size:</strong> 20 × 20 cells</p>
      <p><strong>Castles</strong> (4×4) — players' starting positions</p>
      <p><strong>🏰 Castle healing:</strong> a warrior standing in its own castle fully restores ❤️ HP and 🛡 armour — spends its entire turn doing so</p>
      <p><strong>🧙 Mage Tower</strong> — no towers stand on the map at the start; a knight can <strong>build</strong> one on any empty cell (see "Catapult & building"). Ranged units on a tower get a range bonus</p>
      <p><strong>🎁 Buried loot</strong> — invisible pickups scattered across the whole board (not a fixed zone), picked up automatically by walking over them</p>

      <h4>👥 Forces</h4>
      <p>Each player commands <strong>11 warriors</strong>. The roster is chosen before battle from 8 ready-made presets:</p>
      <ul>
        <li>🛡 <strong>Knight:</strong> ❤️ 3 | ⚔ 5 | 🛡 4 | 🏃 2 — melee (↑↓←→)</li>
        <li>🐎 <strong>Cavalry:</strong> ❤️ 5 | ⚔ 6 | 🛡 3 | 🏃 3 — jump over an enemy</li>
        <li>🏹 <strong>Archer:</strong> ❤️ 3 | ⚔ 3 | 🛡 1 | 🏃 3 — 5×5 zone</li>
        <li>🪨 <strong>Catapult:</strong> ❤️ 2 | ⚔ 7 | 🛡 1 | 🏃 2 — ranged 3–6 cells, dead zone up close</li>
        <li>🎯 <strong>Crossbowman:</strong> ❤️ 3 | ⚔ 5 | 🛡 2 | 🏃 2 — piercing bolt: costs 2 moves, fires 2 cells in a straight line through everyone on it (allies included!)</li>
        <li>⚡ <strong>Samurai:</strong> ❤️ 2 | ⚔ 5 | 🛡 1 | 🏃 3 — melee in 8 directions (+ diagonals)</li>
        <li>🧙 <strong>Battle Mage:</strong> ❤️ 2 | ⚔ 0 (all damage comes from energy) | 🛡 0 | 🏃 2 — 4 abilities instead of a regular attack, see below</li>
      </ul>

      <h4>⚔️ Combat</h4>
      <p>Damage is dealt in two stages:</p>
      <p>1. First it removes <strong>🛡 Armour</strong></p>
      <p>2. When armour = 0 → damage goes to <strong>❤️ Health</strong></p>
      <p>3. Health = 0 → the warrior dies</p>
      <p><em>Example: a warrior with 🛡4 ❤️3 takes 6 damage → Result: 🛡0 ❤️1</em></p>

      <h4>🔄 Turn structure</h4>
      <p>• On a turn you control <strong>up to 3 warriors</strong></p>
      <p>• If fewer than 3 remain — all of them act</p>
      <p>• Every action spends <strong>movement points</strong></p>
      <p>• Once 3 warriors have acted → the turn passes to the opponent</p>

      <h4>🗡 Attack & movement</h4>
      <p><strong>Every warrior only moves in a straight line</strong> (↑↓←→, no diagonals), 1 cell = 1 point. Archer and Catapult can cover 2–3 cells in one straight move; everyone else steps 1 cell at a time.</p>

      <p><strong>🛡 Knight & ⚡ Samurai — plain melee</strong></p>
      <p><strong>Attack (1 point):</strong> hits an adjacent enemy and stays put — no jump. Knight only attacks orthogonally (↑↓←→); Samurai also hits diagonally (8 directions)</p>

      <p><strong>🐎 Cavalry — the only unit that jumps</strong></p>
      <p><strong>Attack (2 points):</strong></p>

      <p><strong>1) Direct attack — jump over the enemy</strong></p>
      <pre style="font-size:11px;line-height:1.5;margin:6px 0;padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#ffe3b2;font-family:monospace">
    ┏━━━━┓
    ┃ ✓  ┃  ← Landing
    ┣━━━━┫
    ┃ 🔴 ┃  ← Enemy (damage)
    ┣━━━━┫
    ┃ 🛡 ┃  ← Your warrior
    ┗━━━━┛</pre>
      <p>⚠️ The cell behind the enemy must be free</p>

      <p><strong>2) "L" attack</strong></p>
      <p>① Step <strong>ONTO the enemy</strong> (jump to its cell)</p>
      <p>② Move <strong>to the side</strong> (to an adjacent cell)</p>
      <p>③ The enemy takes damage from the jump</p>
      <pre style="font-size:11px;line-height:1.5;margin:6px 0;padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#ffe3b2;font-family:monospace">
    ┏━━━━┳━━━━┓
    ┃ ②✓ ┃ 🔴① ┃  🔴 Enemy
    ┣━━━━╋━━━━┫  ① Jump ONTO the enemy
    ┃    ┃ 🐎  ┃  ② Step aside (left)
    ┗━━━━┻━━━━┛  ✓ Landing</pre>
      <p>🌊 <strong>River leap:</strong> for 2 points Cavalry can leap a river exactly 1 cell wide onto a free far bank (bridges are crossed normally)</p>

      <p><strong>🏹 Archer</strong></p>
      <p><strong>Move:</strong> up to 3 cells in a straight line (↑↓←→) in one go, 1 cell = 1 point</p>
      <p><strong>Attack:</strong> shoots any enemy in the 5×5 zone around it (incl. diagonals); cost = distance to the target in cells (1–2 points)</p>
      <p>Tactics: take position → shell the square zone → retreat</p>
      <pre style="font-size:10px;line-height:1.4;margin:6px 0;padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#ffe3b2;font-family:monospace">
  Strike zone (5×5):
  ┏━━━┳━━━┳━━━┳━━━┳━━━┓
  ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃
  ┣━━━╋━━━╋━━━╋━━━╋━━━┫
  ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃
  ┣━━━╋━━━╋━━━╋━━━╋━━━┫
  ┃🎯 ┃🎯 ┃🏹 ┃🎯 ┃🎯 ┃  🏹 = archer
  ┣━━━╋━━━╋━━━╋━━━╋━━━┫  🎯 = attack zone
  ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃
  ┣━━━╋━━━╋━━━╋━━━╋━━━┫
  ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃🎯 ┃
  ┗━━━┻━━━┻━━━┻━━━┻━━━┛</pre>

      <h4>🪨 Catapult & building</h4>
      <p><strong>🪨 Catapult — attack (1 point):</strong> hits a cell at distance 3–6 (dead zone under 3), ignoring obstacles. Instead of hitting a unit, it can spend that same 1 point to hurl a boulder onto an EMPTY cell in the same range — it becomes impassable rock terrain (castles and their approach are off-limits, as are river/bridge/tower cells). Hitting an existing boulder with the same shot shatters it back into open ground</p>

      <p><strong>🏗 Building (🛡 Knight only)</strong></p>
      <p>Stand orthogonally adjacent to the target and spend your whole turn (exactly 2 points) — a build takes 2 such turns in a row (any knight can contribute):</p>
      <ul>
        <li>🗼 <strong>Tower</strong> — on any empty cell</li>
        <li>🌉 <strong>Bridge</strong> — river cells only; once built it has 2 points of durability and can be destroyed by an enemy mage (see below) or by bombardment</li>
      </ul>

      <h4>🧙 Battle Mage</h4>
      <p>Doesn't fight in melee — instead it stores <strong>⚡ Energy</strong> (max 20, +5 at the start of each of its own turns) and spends it on 4 abilities. Each ability costs <strong>1 move</strong> plus energy:</p>
      <ul>
        <li>🔥 <strong>Attack</strong> — damage at any range, no line-of-sight needed. You pick the damage (≥1); cost = damage + distance (in cells) energy</li>
        <li>🛡 <strong>Ward</strong> — shields an ally for free; when they're hit, the mage's own energy drains 1:1 instead of the ally's HP. Run out of energy and the next hit goes straight through</li>
        <li>🩸 <strong>Drain</strong> — adjacent only: takes 1 ❤️ from any unit not warded by another mage (even its own side) and converts it into 5 ⚡ — a way to refuel mid-fight</li>
        <li>💚 <strong>Heal</strong> — restores HP to itself or an ally at any range; cost = HP + distance energy</li>
        <li>🌉 <strong>Burn bridge</strong> — destroys a built bridge outright at any range in one shot; cost = distance × 2 energy</li>
      </ul>
      <p>🧙 The <strong>Mage Tower</strong> on the map is just high ground: it boosts range for ranged units (archer/crossbow/catapult) standing on it, unrelated to the mage's own abilities</p>

      <h4>🎁 Buried loot</h4>
      <p>There's no separate ruins zone on the map anymore — instead, at the start of the battle, items are scattered invisibly across the whole board (excluding castles, towers and starting cells):</p>
      <ul>
        <li>🧩 <strong>Crafting parts</strong> (Wood/Metal/Amulet/Ruby/Arrows) — ~1.5% of the board's cells</li>
        <li>⚔️ <strong>Ready-made weapons</strong> and 🛡 <strong>armour</strong> — exactly 1 of each kind per match</li>
      </ul>
      <p>Items stay hidden until a warrior steps on their cell — a part goes straight into its backpack, gear gets worn by it (or offered to a compatible ally if it can't use it itself). No separate action or turn cost — picking things up happens on an ordinary move.</p>

      <h4>🏁 End of game</h4>
      <p>Win: ☠️ all enemies destroyed | 🏳️ opponent surrendered</p>

      <h4>⌨️ Controls</h4>
      <p><strong>LMB</strong> — select/act | <strong>RMB/Space</strong> — end turn</p>

      <h4>💡 Tactics</h4>
      <p>✅ Keep your warriors' armour up</p>
      <p>✅ Have a knight build a tower — its range bonus decides skirmishes</p>
      <p>✅ Cavalry's jump/L-attack strikes without spending moves closing the distance</p>
      <p>✅ Archers — hit-and-run</p>
      <p>✅ Scout every cell — buried weapons or armour could be underfoot</p>
      <p>✅ A catapult can wall off a corridor with a boulder instead of shooting a unit</p>
      <hr class="menu-rule-sep" style="margin-top:16px">
      <button class="btn primary" data-action="start-tutorial" style="margin-top:8px;width:100%">🎓 Start tutorial — step-by-step hints</button>
    </div>`;
    }

    _buildRightHTML() {
      return '';
    }

    _buildMenuButtonsHTML() {
      return `
        <button class="menu-main-btn mb-about" data-action="show-about" title="${tr('Об игре')}" aria-label="${tr('Об игре')}">
          <span class="menu-main-btn-icon">📖</span>
          <span class="menu-main-btn-label sr-only">${tr('Об игре')}</span>
        </button>
        <button class="menu-main-btn mb-play" data-action="show-play" title="${tr('Играть')}" aria-label="${tr('Играть')}">
          <span class="menu-main-btn-icon">⚔️</span>
          <span class="menu-main-btn-label sr-only">${tr('Играть')}</span>
        </button>
        <button class="menu-main-btn mb-settings" data-action="show-settings" title="${tr('Настройки')}" aria-label="${tr('Настройки')}">
          <span class="menu-main-btn-icon">⚙️</span>
          <span class="menu-main-btn-label sr-only">${tr('Настройки')}</span>
        </button>
      `;
    }

    _buildAboutModalHTML() {
      return `
        <div class="submenu-section">
          <div class="rules" style="font-size:12px;line-height:1.55;color:var(--muted)">
            <p>${tr('Средневековая пошаговая стратегия для 2 игроков на поле 20×20. Уничтожь войско противника или вынуди его капитулировать.')}</p>
          </div>
        </div>
        <div class="submenu-section">
          <button class="btn primary" data-action="show-rules" style="width:100%">📖 ${tr('Правила игры')}</button>
          <button class="btn" data-action="start-tutorial" style="width:100%">🎓 ${tr('Начать обучение')}</button>
        </div>
      `;
    }

    _buildPlayModalHTML() {
      const next = this.findNextStoryTask();
      let html = '';

      // Session score
      const sw1 = this.sessionWins[1] || 0, sw2 = this.sessionWins[2] || 0;
      if (sw1 + sw2 > 0) {
        html += `<div class="session-score-badge">${tr('Счёт сессии:')} <strong style="color:var(--p1)">${sw1}</strong> — <strong style="color:var(--p2)">${sw2}</strong></div>`;
      }

      // Campaign section
      html += `<div class="submenu-section">`;
      html += `<div class="submenu-label">${tr('Кампания')}</div>`;
      if (next) {
        const ch = STORY_CHAPTERS[next.ci];
        const g  = ch && ch.games[next.gi];
        const t  = g && g.tasks[next.ti];
        const preset = (t && t.aiPreset && t.aiPreset.label) || '';
        const name   = t ? this.escape(this.trName(t.name)) : tr('Следующий уровень');
        html += `<div class="campaign-card" data-action="continue-story" role="button" tabindex="0" aria-label="${tr('Продолжить кампанию: {name}', { name })}">
          <span class="campaign-card-icon" aria-hidden="true">⚔️</span>
          <div class="campaign-card-info">
            <div class="campaign-card-name">${name}</div>
            <div class="campaign-card-meta">${tr('Глава {n}', { n: next.ci + 1 })}${preset ? ' · ' + this.escape(this.trName(preset)) : ''}</div>
          </div>
          <span style="color:var(--muted);font-size:14px">›</span>
        </div>`;
      } else {
        html += `<div class="campaign-card" style="opacity:0.55;cursor:default">
          <span class="campaign-card-icon">✅</span>
          <div class="campaign-card-info">
            <div class="campaign-card-name">${tr('Кампания пройдена')}</div>
            <div class="campaign-card-meta">${tr('Все главы завершены')}</div>
          </div>
        </div>`;
      }
      if (this.hasContinuableSave()) {
        html += `<button class="btn restart" data-action="continue-save" style="width:100%">↩️ ${tr('Продолжить партию')}</button>`;
      }
      html += `</div>`;

      // Online section
      html += `<div class="submenu-section">`;
      html += `<div class="submenu-label">${tr('Онлайн')}</div>`;
      html += `<div class="online-btn-row">
        <button class="btn secondary" data-action="play-online-create" style="text-align:center">🌐 ${tr('Создать комнату')}</button>
        <button class="btn secondary" data-action="play-online-random" style="text-align:center">🎲 ${tr('Случайный')}</button>
      </div>`;
      html += `</div>`;

      // Solo section
      html += `<div class="submenu-section">`;
      html += `<div class="submenu-label">${tr('Играть самому')}</div>`;
      html += `<div class="ai-diff-row">
        <button class="ai-diff-btn diff-easy" data-action="start-ai-easy">
          <span class="ai-diff-icon">🟢</span>
          <span class="ai-diff-name">${tr('Слабый')}</span>
          <span class="ai-diff-sub">${tr('Новичок')}</span>
        </button>
        <button class="ai-diff-btn diff-medium" data-action="start-ai-medium">
          <span class="ai-diff-icon">🟡</span>
          <span class="ai-diff-name">${tr('Средний')}</span>
          <span class="ai-diff-sub">${tr('Боец')}</span>
        </button>
        <button class="ai-diff-btn diff-hard" data-action="start-ai-hard">
          <span class="ai-diff-icon">🔴</span>
          <span class="ai-diff-name">${tr('Сложный')}</span>
          <span class="ai-diff-sub">${tr('Мастер')}</span>
        </button>
        <button class="ai-diff-btn diff-impossible" data-action="start-ai-impossible">
          <span class="ai-diff-icon">⚫</span>
          <span class="ai-diff-name">${tr('Невозможный')}</span>
          <span class="ai-diff-sub">${tr('Легенда')}</span>
        </button>
      </div>`;
      html += `<button class="btn" data-action="start-pvp" style="width:100%;text-align:center">👥 ${tr('2 Игрока — на одном устройстве')}</button>`;
      html += `</div>`;

      return html;
    }

    _buildSettingsModalHTML() {
      const user = this.getCurrentUser();
      const avatarLabel = user ? user.charAt(0).toUpperCase() : '👤';
      const nameLabel   = user ? this.escape(user) : tr('Войти в аккаунт');
      const subLabel    = user ? tr('аккаунт · нажмите для управления') : tr('нажмите для входа');

      const isMuted = this.music && this.music.isMuted();

      let html = '';

      // Account section
      html += `<div class="submenu-section">`;
      html += `<div class="submenu-label">${tr('Аккаунт')}</div>`;
      html += `<div class="settings-account" data-action="show-account" id="settingsAccountBar" role="button" tabindex="0" aria-label="${user ? tr('Управление аккаунтом') : tr('Войти в аккаунт')}">
        <div class="settings-account-avatar" aria-hidden="true">${avatarLabel}</div>
        <div class="settings-account-info">
          <div class="settings-account-name">${nameLabel}</div>
          <div class="settings-account-sub">${subLabel}</div>
        </div>
        <span class="settings-account-arrow">›</span>
      </div>`;
      // Nickname editor — only for real (non-guest) accounts. The nickname is the
      // display_name shown to opponents online; it's profanity-filtered on save.
      if (this.authUser && !this.authUser.isGuest) {
        const curNick = this.escape(this.authUser.displayName || '');
        html += `<div class="submenu-section">`;
        html += `<div class="submenu-label">${tr('Никнейм')}</div>`;
        html += `<div style="display:flex;gap:8px;align-items:stretch">
          <input class="auth-input" id="nickInput" type="text" maxlength="20" value="${curNick}" placeholder="${tr('Никнейм')}" aria-label="${tr('Никнейм')}" style="flex:1" />
          <button class="btn primary" data-action="save-nickname" style="width:auto;padding:10px 14px">${tr('Сохранить')}</button>
        </div>`;
        html += `<div class="auth-error" id="nickStatus" style="min-height:14px"></div>`;
        html += `</div>`;
      }

      if (user) {
        html += `<button class="btn danger" data-action="signout" style="width:100%;text-align:center;font-size:13px">${tr('Выйти из аккаунта')}</button>`;
      }
      html += `</div>`;

      // Sound section
      html += `<div class="submenu-section">`;
      html += `<div class="submenu-label">${tr('Звук')}</div>`;
      html += `<div class="mute-row">
        <span class="mute-row-label">${isMuted ? '🔇 ' + tr('Звук выключен') : '🔊 ' + tr('Звук включён')}</span>
        <button class="mute-toggle-btn" data-action="toggle-mute-settings">${isMuted ? '🔇' : '🔊'}</button>
      </div>`;
      html += `</div>`;

      // Progress section
      html += `<div class="submenu-section">`;
      html += `<div class="submenu-label">${tr('Прогресс кампании')}</div>`;
      html += `<div class="settings-progress-scroll">`;
      html += this._buildProgressTreeHTML();
      html += `</div>`;
      html += `</div>`;

      html += `<div style="text-align:center;font-size:11px;color:var(--muted);opacity:0.6;padding-top:4px">${tr('Рыцари и Замки')} · Luka Markov</div>`;

      return html;
    }

    _buildProgressTreeHTML() {
      const progress = this.loadProgress();
      const admin = isAdminEmail(this.authUser?.email); // admin: whole campaign unlocked
      let foundFirst = false;
      let html = '<div class="story-chain">';
      STORY_CHAPTERS.forEach((ch, ci) => {
        const chP = (progress.chapters && progress.chapters[ci]) || { games: [] };
        const allDone = ch.games.every((g, gi) => {
          const gP = (chP.games && chP.games[gi]) || { tasks: [] };
          return g.tasks.every((_, ti) => !!(gP.tasks && gP.tasks[ti]));
        });
        const hasAny = ch.games.some((g, gi) => {
          const gP = (chP.games && chP.games[gi]) || { tasks: [] };
          return gP.tasks && gP.tasks.some(Boolean);
        });
        const chClass = allDone ? 'done' : (admin || !foundFirst || hasAny ? 'avail' : 'locked');
        html += `<div class="chain-chapter"><div class="chain-ch-hdr">`;
        html += `<div class="chain-ch-num ${chClass}">${ci + 1}</div>`;
        html += `<div class="chain-ch-title${chClass === 'locked' ? ' locked' : ''}">${this.escape(this.trName(ch.title))}</div>`;
        html += `</div><div class="chain-games">`;
        ch.games.forEach((g, gi) => {
          const gP = (chP.games && chP.games[gi]) || { tasks: [] };
          const gDone = g.tasks.every((_, ti) => !!(gP.tasks && gP.tasks[ti]));
          const gHasAny = gP.tasks && gP.tasks.some(Boolean);
          const gClass = gDone ? 'done' : (admin || !foundFirst || gHasAny ? 'avail' : 'locked');
          html += `<div class="chain-game"><div class="chain-game-hdr">`;
          html += `<div class="chain-game-dot ${gClass}"></div>`;
          html += `<div class="chain-game-title${gClass === 'locked' ? ' locked' : ''}">${this.escape(this.trName(g.title))}</div>`;
          html += `</div><div class="chain-stars">`;
          g.tasks.forEach((task, ti) => {
            const done = !!(gP.tasks && gP.tasks[ti]);
            let starClass = 'locked';
            if (done) { starClass = 'done'; }
            else if (admin) { starClass = 'avail'; } // admin: every level playable
            else if (!foundFirst) { starClass = 'avail'; foundFirst = true; }
            const presetLabel = (task.aiPreset && task.aiPreset.label) || '';
            const diffClass = 'ai-' + presetLabel.toLowerCase();
            html += `<span class="chain-task">`;
            const starLocked = starClass === 'locked';
            html += `<span class="chain-star ${starClass}" data-chapter="${ci}" data-game="${gi}" data-task="${ti}" title="${this.escape(this.trName(task.name))}" role="button" tabindex="${starLocked ? -1 : 0}" aria-disabled="${starLocked}" aria-label="${done ? tr('Пройдено') : starLocked ? tr('Заблокировано') : tr('Играть')}: ${this.escape(this.trName(task.name))}">${done ? '★' : '☆'}</span>`;
            if (presetLabel) html += `<span class="chain-diff ${diffClass}">${this.escape(this.trName(presetLabel))}</span>`;
            html += `</span>`;
          });
          html += `</div></div>`;
        });
        html += `</div></div>`;
      });
      html += `</div>`;
      return html;
    }

    /** Validate + save the nickname from the Settings input (profanity-filtered),
     *  push it to Supabase, update local state and any visible labels. */
    async saveNickname() {
      const input = document.getElementById('nickInput') as HTMLInputElement | null;
      const status = document.getElementById('nickStatus');
      if (!input || !this.api || !this.authUser) return;

      const res = sanitizeNickname(input.value);
      if (!res.ok) {
        if (status) { status.style.color = 'var(--p2)'; status.textContent = tr(res.reason); }
        return;
      }
      if (res.value === this.authUser.displayName) {
        if (status) { status.style.color = 'var(--muted)'; status.textContent = tr('Никнейм не изменился.'); }
        return;
      }

      if (status) { status.style.color = 'var(--muted)'; status.textContent = tr('Сохранение…'); }
      try {
        const user = await this.api.updateDisplayName(res.value);
        this.authUser = user;
        // Re-render settings (shows the new name) and notify peers if in a match.
        const body = document.getElementById('settingsModalBody');
        if (body) body.innerHTML = this._buildSettingsModalHTML();
        const fresh = document.getElementById('nickStatus');
        if (fresh) { fresh.style.color = 'var(--ok)'; fresh.textContent = tr('Никнейм сохранён.'); }
        if (this.online && this.net && typeof this.net.sendNick === 'function') {
          this.net.sendNick(this.myPlayer, user.displayName);
        }
      } catch (e) {
        if (status) {
          status.style.color = 'var(--p2)';
          status.textContent = (e && e.message) ? e.message : tr('Не удалось сохранить никнейм.');
        }
      }
    }

    // #1: the account bar opens this auth modal, which offers email
    // login/registration and Google sign-in together. When already signed in
    // it shows account info with a sign-out option instead.
    showAccountModal() {
      const modal = document.getElementById('authModal');
      if (!modal) return;

      const loginPanel   = document.getElementById('authLoginPanel');
      const accountPanel = document.getElementById('authAccountPanel');

      if (this.authUser) {
        const infoEl = document.getElementById('authAccountInfo');
        if (infoEl) {
          const u = this.authUser;
          const initial = (u.displayName || u.email || '?').charAt(0).toUpperCase();
          infoEl.innerHTML =
            `<div style="font-size:36px;font-weight:700;color:var(--warn);margin-bottom:8px">${this.escape(initial)}</div>` +
            `<div style="font-weight:600;color:var(--text)">${this.escape(u.displayName || u.email || tr('игрок'))}</div>` +
            (u.email ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${this.escape(u.email)}</div>` : '');
        }
        if (loginPanel)   loginPanel.style.display   = 'none';
        if (accountPanel) accountPanel.style.display = '';
      } else {
        if (loginPanel)   loginPanel.style.display   = '';
        if (accountPanel) accountPanel.style.display = 'none';
        const errEl = document.getElementById('authError');
        if (errEl) errEl.textContent = '';
        const emailInput = document.getElementById('authEmail');
        if (emailInput) emailInput.focus();
      }

      modal.classList.add('active');
    }

    hideAccountModal() {
      const modal = document.getElementById('authModal');
      if (modal) modal.classList.remove('active');
    }

    bindAuthModal() {
      if (this._authModalBound) return;
      const modal = document.getElementById('authModal');
      if (!modal) return;
      this._authModalBound = true;

      // Google sign-in only works inside the native macOS wrapper (see
      // net/auth-google.ts) — in a plain browser it always throws "Вход через
      // Google доступен только в приложении.", so hide the button there
      // instead of showing a control that's guaranteed to fail on click.
      const googleBtn = document.getElementById('authGoogleBtn');
      if (googleBtn && !isNativeAuthAvailable()) {
        googleBtn.style.display = 'none';
      }

      const tabLogin = document.getElementById('authTabLogin');
      const tabSignup = document.getElementById('authTabSignup');
      const nameInput = document.getElementById('authName');
      const passInput = document.getElementById('authPassword');
      const submitBtn = document.getElementById('authSubmit');
      const loginTitleEl = document.querySelector('#authLoginPanel .auth-modal-title');

      const setMode = (mode) => {
        this.authMode = mode;
        const isSignup = mode === 'signup';
        if (tabLogin) tabLogin.classList.toggle('active', !isSignup);
        if (tabSignup) tabSignup.classList.toggle('active', isSignup);
        if (nameInput) nameInput.style.display = isSignup ? '' : 'none';
        if (passInput) {
          passInput.setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
        }
        if (submitBtn) submitBtn.textContent = isSignup ? tr('Зарегистрироваться') : tr('Войти');
        if (loginTitleEl) loginTitleEl.textContent = isSignup ? tr('Регистрация') : tr('Войти');
        const errEl = document.getElementById('authError');
        if (errEl) errEl.textContent = '';
      };

      tabLogin?.addEventListener('click', () => setMode('login'));
      tabSignup?.addEventListener('click', () => setMode('signup'));

      document.getElementById('authForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        this.submitAuth(this.authMode);
      });
      document.getElementById('authGoogleBtn')?.addEventListener('click', () => {
        this.startGoogleSignin();
      });
      document.getElementById('authModalClose')?.addEventListener('click', () => {
        this.hideAccountModal();
      });
      document.getElementById('authSignoutBtn')?.addEventListener('click', () => {
        // Keep the modal open — signout() → refreshAccountUI() swaps it to the
        // login panel so the logout is visible immediately.
        this.signout();
      });
      modal.addEventListener('click', (event) => {
        if (event.target === modal) this.hideAccountModal();
      });

      setMode('login');
    }

    async submitAuth(mode) {
      const emailInput = document.getElementById('authEmail');
      const passInput = document.getElementById('authPassword');
      const nameInput = document.getElementById('authName');
      const errEl = document.getElementById('authError');
      const submitBtn = document.getElementById('authSubmit');
      const email = emailInput ? emailInput.value.trim() : '';
      const password = passInput ? passInput.value : '';
      const name = nameInput ? nameInput.value.trim() : '';
      if (errEl) errEl.textContent = '';
      if (!email || !password) {
        if (errEl) errEl.textContent = tr('Введите email и пароль.');
        return;
      }
      if (mode === 'signup' && password.length < 8) {
        if (errEl) errEl.textContent = tr('Пароль не короче 8 символов.');
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      try {
        if (mode === 'signup') {
          await this.api.signup(email, password, name || email.split('@')[0]);
        }
        const { accessToken, user } = await this.api.login(email, password);
        this.authAccessToken = accessToken;
        this.authUser = user;
        this.api.setAccessToken(accessToken);
        this.saveAuthUserCache(user);
        this.message = tr('Добро пожаловать, {name}!', { name: user.displayName || tr('игрок') });
        this.hideAccountModal();
        this.refreshAccountUI();
        this.syncProgressFromServer();
      } catch (err) {
        if (errEl) {
          errEl.textContent =
            err && err.message ? err.message : tr('Не удалось войти. Попробуйте позже.');
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }


    // ── Draft screen ──────────────────────────────────────────────
    showDraftScreen(mode, difficulty, storyTask) {
      this._draftMode = mode;
      this._draftDifficulty = difficulty;
      this._draftStoryTask = storyTask;
      this._draftSelectedId = (ARMY_PRESETS[0] && ARMY_PRESETS[0].id) || 'balanced';

      const container = document.getElementById('draftPresets');
      if (container) {
        container.innerHTML = ARMY_PRESETS.map((p) => {
          // Count every roster slot the drafter can actually pick (all 7 unit
          // types), not just the original 3 — a preset like 'siege' (catapults)
          // or 'mages' (3 mages) used to render with missing/wrong chips because
          // this map only knew about knight/cavalry/archer.
          const countByType = { knight: 0, cavalry: 0, archer: 0, catapult: 0, crossbow: 0, samurai: 0, mage: 0 };
          p.units.forEach((u) => { if (u.type in countByType) countByType[u.type]++; });
          const chips = Object.entries(countByType)
            .filter(([, n]) => n > 0)
            .map(([ty, n]) => `<span class="draft-unit-chip ${ty}">${n} ${this.trName(UNIT_TYPES[ty]?.name || ty)}</span>`)
            .join('');
          const sel = this._draftSelectedId === p.id ? ' selected' : '';
          return `<div class="draft-preset-card${sel}" data-preset-id="${p.id}" role="button" tabindex="0" aria-pressed="${this._draftSelectedId === p.id}" aria-label="${this.escape(this.trName(p.name))}: ${this.escape(this.trName(p.desc))}">
            <div class="draft-preset-icon" aria-hidden="true">${p.icon}</div>
            <div class="draft-preset-name">${this.trName(p.name)}</div>
            <div class="draft-preset-desc">${this.trName(p.desc)}</div>
            <div class="draft-preset-units">${chips}</div>
          </div>`;
        }).join('');
      }

      document.getElementById('draftModal')?.classList.add('active');
    }

    hideDraftScreen() {
      document.getElementById('draftModal')?.classList.remove('active');
    }

    bindDraftModal() {
      if (this._draftModalBound) return;
      this._draftModalBound = true;

      const modal = document.getElementById('draftModal');
      if (!modal) return;

      modal.addEventListener('click', (event) => {
        const card = (event.target as Element).closest('.draft-preset-card') as HTMLElement | null;
        if (card && card.dataset.presetId) {
          this._draftSelectedId = card.dataset.presetId;
          modal.querySelectorAll('.draft-preset-card').forEach((c) => c.classList.remove('selected'));
          card.classList.add('selected');
          return;
        }
        if ((event.target as Element).id === 'draftConfirmBtn') {
          const preset = ARMY_PRESETS.find((p) => p.id === this._draftSelectedId) || ARMY_PRESETS[0];
          this.hideDraftScreen();
          this.startMatch(this._draftMode, this._draftDifficulty, this._draftStoryTask, preset && preset.units);
          return;
        }
        if ((event.target as Element).id === 'draftCancelBtn') {
          this.hideDraftScreen();
          this.showNewMenu();
          return;
        }
      });
    }

    // P0 undo: snapshot the live game before each human action and restore it
    // on demand. Reuses createSaveSnapshot/restoreSavedState but stays purely
    // in-memory — it never touches localStorage or validateSnapshot.
    recordUndo() {
      if (this.online) return; // server-authoritative — no local undo online
      try {
        this.undoStack.push(this.createSaveSnapshot());
        if (this.undoStack.length > 40) this.undoStack.shift();
      } catch (e) {
        // Snapshotting must never break gameplay.
      }
    }

    performUndo() {
      if (this.online) return; // no undo in server-authoritative online play
      const snap = this.undoStack.pop();
      if (!snap) return;
      this.restoreSavedState(snap);
      this.renderSidebar();
    }

    restoreSavedState(snapshot) {
      if (!snapshot || typeof snapshot !== "object") {
        return false;
      }
      const nextScreen = snapshot.screen === "game" ? "game" : "menu";
      // FUNC-001 fix (Phase 1 plan): accept both PvP and AI matches.
      const nextMode =
        snapshot.mode === "pvp" || snapshot.mode === "ai" ? snapshot.mode : null;
      if (nextScreen === "game" && !nextMode) {
        return false;
      }

      // Восстанавливаем позиции замков
      if (Number.isFinite(snapshot.castleP1Col)) {
        setCastleP1Col(Math.max(0, Math.min(COLS - 4, Math.floor(snapshot.castleP1Col))));
      }
      if (Number.isFinite(snapshot.castleP2Col)) {
        setCastleP2Col(Math.max(0, Math.min(COLS - 4, Math.floor(snapshot.castleP2Col))));
      }
      if (Array.isArray(snapshot.towers)) {
        setTowers(snapshot.towers.map((t) => ({ row: t.row, col: t.col })));
      } else {
        setTowers([]);
      }
      if (Array.isArray(snapshot.constructions)) {
        setConstructions(snapshot.constructions.map((c) => ({ ...c })));
      } else {
        setConstructions([]);
      }
      if (snapshot.bridgeDurability && typeof snapshot.bridgeDurability === 'object') {
        setBridgeDurability({ ...snapshot.bridgeDurability });
      } else {
        setBridgeDurability({});
      }
      if (snapshot.ruins) {
        setRuins({ top: snapshot.ruins.top, left: snapshot.ruins.left, width: snapshot.ruins.width, height: snapshot.ruins.height });
      }
      setRuins2(
        snapshot.ruins2 && snapshot.ruins2.width > 0 && snapshot.ruins2.height > 0
          ? { top: snapshot.ruins2.top, left: snapshot.ruins2.left, width: snapshot.ruins2.width, height: snapshot.ruins2.height }
          : null,
      );
      if (Array.isArray(snapshot.terrain)) {
        setTerrain(snapshot.terrain.filter((t) => t && typeof t.row === 'number').map((t) => ({ row: t.row, col: t.col, type: t.type })));
      }

      this.screen = nextScreen;
      // Resuming a saved match has to tear down the menu chrome exactly like
      // startMatch() does. Setting `screen` alone only changes what the canvas
      // paints — #menuOverlay is a DOM layer ON TOP of it, so without this the
      // restored board renders underneath the title screen: the sidebar shows a
      // live game (player, selected unit, moves) while the board area is
      // covered, which reads as "the board went black / the game is stuck".
      if (nextScreen === "game") {
        this.hideNewMenu();
        document.getElementById('menuLeft')?.classList.remove('panel-open');
        document.getElementById('menuRight')?.classList.remove('panel-open');
        document.getElementById('menuBackdrop')?.classList.remove('visible');
      }
      this.mode = nextMode;
      this.player1Bottom = false;
      // FUNC-001 fix (Phase 1 plan): restore AI/story scaffolding so AI/story
      // matches resume correctly. Faction and mapTheme drive renderer choices.
      this.aiDifficulty =
        typeof snapshot.aiDifficulty === "string" ? snapshot.aiDifficulty : null;
      this.currentStoryTask =
        snapshot.currentStoryTask &&
        Number.isFinite(snapshot.currentStoryTask.ci) &&
        Number.isFinite(snapshot.currentStoryTask.gi) &&
        Number.isFinite(snapshot.currentStoryTask.ti)
          ? {
              ci: snapshot.currentStoryTask.ci,
              gi: snapshot.currentStoryTask.gi,
              ti: snapshot.currentStoryTask.ti,
              task: (((STORY_CHAPTERS[snapshot.currentStoryTask.ci] || {}).games || [])[
                snapshot.currentStoryTask.gi
              ] || {}).tasks
                ? STORY_CHAPTERS[snapshot.currentStoryTask.ci].games[
                    snapshot.currentStoryTask.gi
                  ].tasks[snapshot.currentStoryTask.ti] || null
                : null
            }
          : null;
      this.mapTheme = snapshot.mapTheme === "sea" ? "sea" : "land";
      this.p1Faction = typeof snapshot.p1Faction === "string" ? snapshot.p1Faction : "blue";
      this.p2Faction = typeof snapshot.p2Faction === "string" ? snapshot.p2Faction : "red";
      this.sessionWins = {
        1: Math.max(0, Math.floor(Number(snapshot.sessionWins && snapshot.sessionWins[1]) || 0)),
        2: Math.max(0, Math.floor(Number(snapshot.sessionWins && snapshot.sessionWins[2]) || 0))
      };
      // Re-configure AI agent to match restored difficulty / preset.
      if (this.mode === "ai" && this.ai) {
        const presetFromTask = this.currentStoryTask && this.currentStoryTask.task && this.currentStoryTask.task.aiPreset;
        if (presetFromTask) this.ai.setConfig(presetFromTask);
        else if (this.aiDifficulty) this.ai.setDifficulty(this.aiDifficulty);
      }
      this.currentPlayer = snapshot.currentPlayer === 2 ? 2 : 1;
      this.activatedCount = Math.max(0, Math.floor(Number(snapshot.activatedCount) || 0));
      this.turnNumber = Math.max(1, Math.floor(Number(snapshot.turnNumber) || 1));
      this.winner = snapshot.winner === 1 || snapshot.winner === 2 ? snapshot.winner : null;
      this.message = typeof snapshot.message === "string" ? snapshot.message : "";
      this.lastEvent = typeof snapshot.lastEvent === "string" ? snapshot.lastEvent : "";
      this.shieldTurns = {
        1: Math.max(0, Math.floor(Number(snapshot.shieldTurns && snapshot.shieldTurns[1]) || 0)),
        2: Math.max(0, Math.floor(Number(snapshot.shieldTurns && snapshot.shieldTurns[2]) || 0))
      };
      this.damageBuff = {
        1: Math.max(0, Math.floor(Number(snapshot.damageBuff && snapshot.damageBuff[1]) || 0)),
        2: Math.max(0, Math.floor(Number(snapshot.damageBuff && snapshot.damageBuff[2]) || 0))
      };

      const pending = snapshot.pendingWeaponEquip;
      if (
        pending &&
        typeof pending.name === "string" &&
        Number.isFinite(Number(pending.amount))
      ) {
        this.pendingWeaponEquip = {
          name: pending.name,
          amount: Math.max(0, Number(pending.amount)),
          icon: typeof pending.icon === "string" ? pending.icon : "",
          allowedTypes: Array.isArray(pending.allowedTypes) ? pending.allowedTypes.slice() : null,
          forbidTypes: Array.isArray(pending.forbidTypes) ? pending.forbidTypes.slice() : null,
          archerOnly: !!pending.archerOnly,
          slot: pending.slot === "armor" ? "armor" : "weapon"
        };
      } else {
        this.pendingWeaponEquip = null;
      }
      this.updateWeaponTargets();

      this.droppedBackpacks = Array.isArray(snapshot.droppedBackpacks)
        ? snapshot.droppedBackpacks.map((d) => ({
            row: d.row,
            col: d.col,
            parts: this.readBackpack(d.parts),
            weapon: d.weapon ? { ...d.weapon } : null,
            armorGear: d.armorGear ? { ...d.armorGear } : null,
          }))
        : [];
      // Older saves predate hidden pickups — resume them with an empty field
      // rather than scattering fresh loot mid-match.
      this.hiddenPickups = Array.isArray(snapshot.hiddenPickups)
        ? snapshot.hiddenPickups.map((p) => ({ ...p }))
        : [];
      // A save made before hidden pickups existed carries none. Bury a fresh
      // set instead of leaving that match permanently barren.
      if (!Array.isArray(snapshot.hiddenPickups)) this.scatterMatchPickups();

      const unitsData = Array.isArray(snapshot.units) ? snapshot.units : [];
      const restoredUnits = [];
      const occupied = new Set();
      let maxId = 0;

      unitsData.forEach((raw) => {
        const unit = this.deserializeUnit(raw);
        if (!unit) {
          return;
        }
        const key = toKey(unit.row, unit.col);
        if (occupied.has(key)) {
          return;
        }
        occupied.add(key);
        restoredUnits.push(unit);
        maxId = Math.max(maxId, unit.id);
      });

      if (nextScreen === "game" && restoredUnits.length === 0) {
        return false;
      }

      if (typeof snapshot.player1Bottom === "boolean") {
        this.player1Bottom = snapshot.player1Bottom;
      }

      if (restoredUnits.length) {
        this.board = new Board(this.player1Bottom);
        this.board.units = restoredUnits;
        this.board.nextId = maxId + 1;
      } else {
        this.board = new Board(this.player1Bottom);
      }

      this.previewUnitId = Number.isFinite(Number(snapshot.previewUnitId))
        ? Number(snapshot.previewUnitId)
        : null;

      const selectedId = Number(snapshot.selectedUnitId);
      if (Number.isFinite(selectedId)) {
        this.selectedUnit = this.board.units.find((u) => u.id === selectedId && u.alive()) || null;
      } else {
        this.selectedUnit = null;
      }

      if (
        this.selectedUnit &&
        (this.selectedUnit.player !== this.currentPlayer || this.selectedUnit.done)
      ) {
        this.selectedUnit = null;
      }

      this.clearHighlights();
      if (this.selectedUnit) {
        this.rebuildHighlights();
      }
      this.applyResponsiveCanvasSize();
      return true;
    }

    deserializeUnit(raw) {
      // Phase 2: validateSerializedUnit (game-rules) returns a sanitised plain
      // object with the T25 damage tampering cap (base + 10) applied. We then
      // hydrate an inline Unit instance to keep animation state intact.
      const v = validateSerializedUnit(raw);
      if (!v) return null;
      const unit = new Unit(v.id, v.player, v.type, v.row, v.col);
      unit.maxHp = v.maxHp;
      unit.hp = v.hp;
      unit.startArmor = v.startArmor;
      unit.maxArmor = v.maxArmor;
      unit.armor = v.armor;
      unit.damage = v.damage;
      unit.maxMoves = v.maxMoves;
      unit.movesLeft = v.movesLeft;
      unit.done = v.done;
      unit.activated = v.activated;
      if (v.visualRow !== null) unit.visualRow = v.visualRow;
      if (v.visualCol !== null) unit.visualCol = v.visualCol;
      if (v.dying) {
        unit.dying = true;
        unit.deathProgress = v.deathProgress;
      }
      if (v.weapon) {
        unit.weapon = { name: v.weapon.name, icon: v.weapon.icon, amount: v.weapon.amount };
      }
      if (v.armorGear) {
        unit.armorGear = {
          name: v.armorGear.name,
          icon: v.armorGear.icon,
          amount: v.armorGear.amount,
        };
      }
      unit.backpack = this.readBackpack(v.backpack);
      if (v.type === "mage") {
        unit.maxEnergy = Number.isFinite(v.maxEnergy) ? v.maxEnergy : MAGE_MAX_ENERGY;
        unit.energy = Number.isFinite(v.energy) ? v.energy : unit.maxEnergy;
        unit.warding = Array.isArray(v.warding) ? v.warding.slice() : [];
      }
      unit.wardedBy = typeof v.wardedBy === "number" && v.wardedBy > 0 ? v.wardedBy : null;
      return unit;
    }

    /** Sanitise a raw (possibly untrusted, e.g. from localStorage) backpack
     * object into a full Backpack — every part present, negative/non-finite
     * counts dropped to 0. */
    readBackpack(raw) {
      const bp = emptyBackpack();
      if (raw && typeof raw === "object") {
        PARTS.forEach((p) => {
          const v = Number(raw[p]);
          if (Number.isFinite(v) && v >= 0) bp[p] = Math.floor(v);
        });
      }
      return bp;
    }

    // ===== Online bridge (Track A) ===========================================
    // In online mode the server is authoritative: local actions are sent over
    // the WebSocket and the board is rebuilt from each state-update. The legacy
    // single-player mutation paths are short-circuited (see performMove etc.).

    startOnlineMatch(matchId, you, token) {
      if (this.net) {
        try {
          this.net.close();
        } catch (e) {
          /* ignore */
        }
        this.net = null;
      }
      this.online = true;
      this.mode = "pvp"; // reuse the PvP rendering/HUD path
      this.myPlayer = you === 2 ? 2 : 1;
      this.matchId = matchId;
      this.onlineToken = token;
      this.onlineEnded = false;
      this.onlineWaiting = false;
      this.onlineStatus = null;
      this.opponentNick = null;
      this.turnEndsAt = null;
      this.pendingActions = [];
      this.turnSubmitting = false;
      this.droppedBackpacks = [];
      // Cleared here too — the authoritative state-update refills it.
      this.hiddenPickups = [];
      this.rngSeed = 0;
      this.rngCursor = 0;
      this.player1Bottom = false; // canonical orientation (server: P1 = top rows)
      this.screen = "game";
      this.winner = null;
      this.selectedUnit = null;
      this.previewUnitId = null;
      this.undoStack = [];
      this.pendingWeaponEquip = null;
      this.weaponTargetMap.clear();
      this.board = new Board(false, false); // autoInit=false → empty until first state
      this.board.units = [];
      this.connState = "connecting";
      this.message = tr("Подключение к матчу…");
      this.stopConfetti();
      this.applyResponsiveCanvasSize();
      this.renderSidebar();

      this.net = new SupabaseMatchClient({
        matchId,
        you: this.myPlayer,
        myNick: (this.authUser && this.authUser.displayName) || undefined,
        onPeerNick: (player, nick) => {
          if (player !== this.myPlayer) {
            const r = sanitizeNickname(nick); // never trust a peer-supplied name
            this.opponentNick = r.ok ? r.value : tr('Соперник');
            this.updateOnlineHud();
          }
        },
        callbacks: {
          onStateUpdate: (m) => this.applyServerState(m),
          onConnChange: (s) => {
            this.connState = s;
            const dm = document.getElementById("onlineDisconnectModal");
            if (dm) {
              if (s === "reconnecting" && this.onlineStatus === "in_progress" && this.winner === null) {
                dm.classList.add("active");
              } else {
                dm.classList.remove("active");
              }
            }
            this.updateOnlineHud();
            this.renderSidebar();
          },
          onError: (m) => this.onServerError(m),
          onAborted: (m) => this.onServerAborted(m),
          onRematch: (m) => this.onServerRematch(m),
        },
      });
      this.net.connect();
      // Refresh the HUD (turn + countdown) a couple times a second.
      if (this._hudTimer) clearInterval(this._hudTimer);
      this._hudTimer = setInterval(() => this.updateOnlineHud(), 500);
    }

    closeOnline() {
      if (this.net) {
        try {
          this.net.close();
        } catch (e) {
          /* ignore */
        }
        this.net = null;
      }
      if (this._hudTimer) {
        clearInterval(this._hudTimer);
        this._hudTimer = null;
      }
      this.cancelPendingQueue();
      this.online = false;
      this.myPlayer = null;
      this.matchId = null;
      this.onlineToken = null;
      this.onlineStatus = null;
      this.turnEndsAt = null;
      this.onlineWaiting = false;
      this.connState = "closed";
      const dm = document.getElementById("onlineDisconnectModal");
      if (dm) dm.classList.remove("active");
      const hud = document.getElementById("hudOnline");
      if (hud) hud.style.display = "none";
    }

    isMyTurn() {
      if (!this.online) return true;
      return this.currentPlayer === this.myPlayer;
    }

    onlineInputLocked() {
      return (
        this.online &&
        (this.currentPlayer !== this.myPlayer ||
          this.turnSubmitting ||
          this.winner !== null ||
          this.onlineStatus !== "in_progress")
      );
    }

    sendOnline(action) {
      if (!this.online || !this.net) return false;
      if (this.currentPlayer !== this.myPlayer) {
        this.message = tr("Сейчас ход соперника.");
        this.renderSidebar();
        return false;
      }
      // SupabaseMatchClient.send is async (it POSTs to the match-action Edge
      // Function). Fire-and-forget: the authoritative board arrives via Realtime;
      // a failed send surfaces here and via the onError callback.
      Promise.resolve(this.net.send(action))
        .then((ok) => {
          if (ok === false) {
            this.message = tr("Нет связи с сервером. Переподключение…");
            this.renderSidebar();
          }
        })
        .catch(() => {});
      return true;
    }

    applyServerState(msg) {
      const state = msg && msg.state;
      if (!state) return;
      if (msg.you === 1 || msg.you === 2) this.myPlayer = msg.you;
      this.onlineStatus = msg.status || this.onlineStatus;
      if (typeof msg.turnEndsAt !== "undefined") this.turnEndsAt = msg.turnEndsAt;
      this.connState = "open";

      // The authoritative row is in — the optimistic turn is now confirmed (or
      // replaced). Drop any in-flight batch bookkeeping and re-seed the RNG
      // mirror + dropped-gear list from the canonical state.
      this.turnSubmitting = false;
      this.pendingActions = [];
      this.rngSeed = Number.isFinite(Number(state.rngSeed)) ? Number(state.rngSeed) >>> 0 : this.rngSeed;
      this.rngCursor = Math.max(0, Math.floor(Number(state.rngCursor) || 0));
      const readGearItem = (g) =>
        g && typeof g.name === "string"
          ? {
              name: g.name,
              amount: Math.max(0, Number(g.amount) || 0),
              icon: typeof g.icon === "string" ? g.icon : "",
              allowedTypes: Array.isArray(g.allowedTypes) ? g.allowedTypes.slice() : null,
              forbidTypes: Array.isArray(g.forbidTypes) ? g.forbidTypes.slice() : null,
              archerOnly: !!g.archerOnly,
            }
          : null;
      this.droppedBackpacks = Array.isArray(state.droppedBackpacks)
        ? state.droppedBackpacks
            .filter((d) => d && Number.isFinite(Number(d.row)) && Number.isFinite(Number(d.col)))
            .map((d) => ({
              row: Math.floor(Number(d.row)),
              col: Math.floor(Number(d.col)),
              parts: this.readBackpack(d.parts),
              weapon: readGearItem(d.weapon),
              armorGear: readGearItem(d.armorGear),
            }))
        : [];

      // Hidden pickups are server-owned too: the seeded scatter lives in the
      // match state, so the client just mirrors what's still buried. Optimistic
      // local claims are overwritten by this echo, which is what keeps the two
      // sides in lockstep.
      this.hiddenPickups = Array.isArray(state.hiddenPickups)
        ? state.hiddenPickups
            .filter(
              (p) =>
                p &&
                typeof p.name === "string" &&
                Number.isFinite(Number(p.row)) &&
                Number.isFinite(Number(p.col)),
            )
            .map((p) => ({
              row: Math.floor(Number(p.row)),
              col: Math.floor(Number(p.col)),
              kind: p.kind === "armor" ? "armor" : p.kind === "weapon" ? "weapon" : "part",
              name: p.name,
            }))
        : [];

      // World layout — the server owns the seeded map.
      if (Number.isFinite(state.castleP1Col)) {
        setCastleP1Col(Math.max(0, Math.min(COLS - 4, Math.floor(state.castleP1Col))));
      }
      if (Number.isFinite(state.castleP2Col)) {
        setCastleP2Col(Math.max(0, Math.min(COLS - 4, Math.floor(state.castleP2Col))));
      }
      if (Array.isArray(state.towers)) {
        setTowers(state.towers.map((t) => ({ row: t.row, col: t.col })));
      } else {
        setTowers([]);
      }
      if (Array.isArray(state.constructions)) {
        setConstructions(state.constructions.map((c) => ({ ...c })));
      } else {
        setConstructions([]);
      }
      if (state.bridgeDurability && typeof state.bridgeDurability === 'object') {
        setBridgeDurability({ ...state.bridgeDurability });
      } else {
        setBridgeDurability({});
      }
      if (state.ruins) {
        setRuins({
          top: state.ruins.top,
          left: state.ruins.left,
          width: state.ruins.width,
          height: state.ruins.height,
        });
      }
      setRuins2(
        state.ruins2 && state.ruins2.width > 0 && state.ruins2.height > 0
          ? {
              top: state.ruins2.top,
              left: state.ruins2.left,
              width: state.ruins2.width,
              height: state.ruins2.height,
            }
          : null,
      );
      if (Array.isArray(state.terrain)) {
        setTerrain(state.terrain.filter((t) => t && typeof t.row === 'number').map((t) => ({ row: t.row, col: t.col, type: t.type })));
      }

      // Rebuild the board from the authoritative roster, preserving unit ids.
      const prevUnits = this.board ? this.board.units.slice() : [];
      const newBoard = new Board(false, false);
      const units = [];
      let maxId = 0;
      (Array.isArray(state.units) ? state.units : []).forEach((su) => {
        const unit = this.deserializeUnit(su);
        if (unit) {
          units.push(unit);
          maxId = Math.max(maxId, unit.id);
        }
      });
      newBoard.units = units;
      newBoard.nextId = maxId + 1;
      this.board = newBoard;

      this.currentPlayer = state.currentPlayer === 2 ? 2 : 1;
      this.turnNumber = Math.max(1, Math.floor(Number(state.turnNumber) || 1));
      this.activatedCount = Math.max(0, Math.floor(Number(state.activatedCount) || 0));
      this.shieldTurns = {
        1: Math.max(0, Math.floor(Number(state.shieldTurns && state.shieldTurns[1]) || 0)),
        2: Math.max(0, Math.floor(Number(state.shieldTurns && state.shieldTurns[2]) || 0)),
      };
      this.damageBuff = {
        1: Math.max(0, Math.floor(Number(state.damageBuff && state.damageBuff[1]) || 0)),
        2: Math.max(0, Math.floor(Number(state.damageBuff && state.damageBuff[2]) || 0)),
      };
      // Per-unit backpacks already came in via deserializeUnit above — no
      // shared per-player inventory to mirror any more.

      const pending = state.pendingWeaponEquip;
      if (pending && typeof pending.name === "string") {
        this.pendingWeaponEquip = {
          name: pending.name,
          amount: Math.max(0, Number(pending.amount) || 0),
          icon: typeof pending.icon === "string" ? pending.icon : "",
          allowedTypes: Array.isArray(pending.allowedTypes) ? pending.allowedTypes.slice() : null,
          forbidTypes: Array.isArray(pending.forbidTypes) ? pending.forbidTypes.slice() : null,
          archerOnly: !!pending.archerOnly,
          slot: pending.slot === "armor" ? "armor" : "weapon",
        };
      } else {
        this.pendingWeaponEquip = null;
      }
      this.updateWeaponTargets();

      this.winner = state.winner === 1 || state.winner === 2 ? state.winner : null;

      // Cosmetic animations from server events (move tween / hit fx / death).
      this.reconcileAnimations(prevUnits, units, Array.isArray(msg.events) ? msg.events : []);

      // Selection is local-only; drop it on every authoritative refresh.
      this.selectedUnit = null;
      this.clearHighlights();

      if (this.onlineStatus === "waiting") {
        this.onlineWaiting = true;
        this.message = tr("Ожидание соперника…");
      } else {
        this.onlineWaiting = false;
        // Opponent joined / match running → close any create/join modal.
        if (this.onlineStatus === "in_progress") this.hideOnlineModal(false);
        if (this.winner !== null) {
          this.onGameOverOnline();
          this.hideOnlineModal(false);
          const dm = document.getElementById("onlineDisconnectModal");
          if (dm) dm.classList.remove("active");
        } else if (this.currentPlayer === this.myPlayer) {
          this.message = tr("Ваш ход.");
        } else {
          this.message = tr("Ход соперника…");
        }
      }
      this.updateOnlineHud();
      this.applyResponsiveCanvasSize();
      this.renderSidebar();
    }

    reconcileAnimations(prevUnits, newUnits, events) {
      const prevById = new Map();
      prevUnits.forEach((u) => prevById.set(u.id, u));
      // Tween any unit that changed cell (covers a move and a jump landing).
      newUnits.forEach((u) => {
        const old = prevById.get(u.id);
        if (old && (old.row !== u.row || old.col !== u.col)) {
          u.visualRow = old.row;
          u.visualCol = old.col;
          if (typeof u.startMoveTo === "function") u.startMoveTo(u.row, u.col);
        }
      });
      events.forEach((ev) => {
        if (!ev || typeof ev !== "object") return;
        if (ev.kind === "unit-attacked") {
          const tgt = prevById.get(ev.data && ev.data.targetId);
          if (tgt) {
            const x = tgt.col * CELL_SIZE + CELL_SIZE / 2;
            const y = tgt.row * CELL_SIZE + CELL_SIZE / 2;
            this.createExplosion(x, y, "#ff6b6b", 6);
            const dmg = ev.data && ev.data.damage;
            if (Number.isFinite(Number(dmg))) {
              this.createFloatingText("-" + dmg, x, y - 10, "#ff6b6b", 18);
            }
            this.cameraShake = 8;
          }
        } else if (ev.kind === "unit-killed") {
          const tgt = prevById.get(ev.data && ev.data.unitId);
          if (tgt) {
            const x = tgt.col * CELL_SIZE + CELL_SIZE / 2;
            const y = tgt.row * CELL_SIZE + CELL_SIZE / 2;
            this.createExplosion(x, y, "#666", 8);
            this.createExplosion(x, y, "#ffffff", 4);
            this.cameraShake = 12;
          }
        }
      });
    }

    onGameOverOnline() {
      if (this.onlineEnded) return;
      this.onlineEnded = true;
      if (this.winner === this.myPlayer) {
        this.message = tr("🏆 Вы победили!");
        if (this.sessionWins) {
          this.sessionWins[this.myPlayer] = (this.sessionWins[this.myPlayer] || 0) + 1;
        }
      } else {
        this.message = tr("Вы проиграли.");
      }
    }

    onServerError(msg) {
      const code = msg && msg.code;
      const human = {
        "wrong-turn": tr("Сейчас ход соперника."),
        "activation-limit": tr("Можно активировать не более 3 юнитов за ход."),
        "spell-needs-tower": tr("Заклинания доступны только на башне мага."),
        "spell-unaffordable": tr("Недостаточно артефактов для заклинания."),
        "spell-no-effect": tr("Заклинание не нужно — оно ничего не сделает."),
        "craft-unaffordable": tr("Недостаточно артефактов для крафта."),
        "weapon-pending": tr("Сначала экипируйте скрафченное оружие."),
        "no-moves-left": tr("У юнита не осталось ходов."),
        "unit-not-on-ruins": tr("Юнит должен стоять в руинах."),
      };
      this.message = human[code] || tr("Действие отклонено") + (code ? " (" + code + ")" : "") + ".";
      this.renderSidebar();
    }

    onServerAborted(msg) {
      this.onlineStatus = "aborted";
      const winner = msg && (msg.winner === 1 || msg.winner === 2) ? msg.winner : null;
      this.winner = winner;
      this.onlineEnded = true;
      if (winner === this.myPlayer) this.message = tr("Соперник отключился — вы победили!");
      else if (winner) this.message = tr("Матч прерван — поражение.");
      else this.message = tr("Матч прерван.");
      this.selectedUnit = null;
      this.clearHighlights();
      this.renderSidebar();
    }

    onServerRematch(msg) {
      const newId = msg && msg.matchId;
      if (!newId) return;
      this.startOnlineMatch(newId, this.myPlayer, this.onlineToken);
    }

    requestRematch() {
      if (!this.online || !this.api || !this.matchId) return;
      const oldId = this.matchId;
      this.message = tr("Запрос реванша…");
      this.renderSidebar();
      this.api
        .rematch(oldId)
        .then((res) => {
          if (res && res.ready && res.matchId) {
            this.startOnlineMatch(res.matchId, res.you || this.myPlayer, this.onlineToken);
          } else {
            this.message = tr("Ждём соперника для реванша…");
            this.renderSidebar();
          }
        })
        .catch(() => {
          this.message = tr("Не удалось запросить реванш.");
          this.renderSidebar();
        });
    }

    // ----- Online menu / modal UI (Track A) -----------------------------------

    openOnlineMenu(mode?: string) {
      if (mode === 'random') {
        this.onlineQueue();
      } else {
        this.renderOnlineModal("menu");
      }
    }

    renderOnlineModal(view) {
      const body = document.getElementById("onlineModalBody");
      const modal = document.getElementById("onlineModal");
      if (!body || !modal) return;
      let html =
        '<button class="online-modal-close" data-action="online-close" aria-label="' + tr('Закрыть') + '">✕</button>';
      if (view === "menu") {
        html += '<div class="online-modal-title">' + tr('Игра по сети') + '</div>';
        html +=
          '<div class="online-modal-sub">' + tr('Создайте комнату и поделитесь кодом, войдите по коду друга или найдите случайного соперника. Регистрация не нужна.') + '</div>';
        html += '<button class="btn primary" data-action="online-show-create">' + tr('Создать комнату') + '</button>';
        html += '<button class="btn" data-action="online-show-join">' + tr('Войти по коду') + '</button>';
        html += '<button class="btn" data-action="online-show-random">' + tr('Случайный соперник') + '</button>';
      } else if (view === "create") {
        html += '<div class="online-modal-title">' + tr('Комната создана') + '</div>';
        html += '<div class="online-modal-sub">' + tr('Передайте код сопернику:') + '</div>';
        html += '<div class="online-code" id="onlineCodeText">' + (this._roomCode || "······") + "</div>";
        html += '<div class="online-error" id="onlineCopyHint"></div>';
        html += '<button class="btn" data-action="online-copy">' + tr('Скопировать код') + '</button>';
        html += '<div class="online-spinner"></div>';
        html += '<div class="online-modal-sub">' + tr('Ожидание соперника…') + '</div>';
        html += '<button class="btn secondary" data-action="online-cancel">' + tr('Отмена') + '</button>';
      } else if (view === "join") {
        html += '<div class="online-modal-title">' + tr('Войти по коду') + '</div>';
        html += '<div class="online-modal-sub">' + tr('Введите код комнаты:') + '</div>';
        html +=
          '<input class="online-input" id="onlineCodeInput" maxlength="8" placeholder="' + tr('КОД') + '" autocomplete="off" autocapitalize="characters" />';
        html += '<div class="online-error" id="onlineJoinError"></div>';
        html += '<button class="btn primary" data-action="online-join-go">' + tr('Войти в комнату') + '</button>';
        html += '<button class="btn secondary" data-action="online-menu">' + tr('Назад') + '</button>';
      } else if (view === "searching") {
        html += '<div class="online-modal-title">' + tr('Поиск соперника') + '</div>';
        html += '<div class="online-spinner"></div>';
        html += '<div class="online-modal-sub">' + tr('Ищем случайного соперника…') + '</div>';
        html += '<button class="btn secondary" data-action="online-cancel">' + tr('Отмена') + '</button>';
      } else if (view === "connecting") {
        html += '<div class="online-modal-title">' + tr('Подключение…') + '</div>';
        html += '<div class="online-spinner"></div>';
      }
      body.innerHTML = html;
      modal.classList.add("active");
      if (view === "join") {
        const input = document.getElementById("onlineCodeInput");
        if (input) setTimeout(() => input.focus(), 50);
      }
    }

    hideOnlineModal(userClosed) {
      const modal = document.getElementById("onlineModal");
      if (modal) modal.classList.remove("active");
      if (userClosed) this.cancelPendingQueue();
    }

    cancelPendingQueue() {
      if (this._queuePollTimer) {
        clearInterval(this._queuePollTimer);
        this._queuePollTimer = null;
      }
      if (this._inQueue) {
        this._inQueue = false;
        if (this.api) this.api.leaveQueue().catch(() => {});
      }
    }

    cancelOnlineFlow() {
      this.cancelPendingQueue();
      // Created/joined a match that hasn't started yet → abandon it.
      if (this.online && this.onlineStatus !== "in_progress") {
        this.closeOnline();
      }
      this.hideOnlineModal(false);
      this.showNewMenu();
    }

    async ensureOnlineToken() {
      if (!this.api) return null;
      if (!this.api.getAccessToken() && this.authAccessToken) {
        this.api.setAccessToken(this.authAccessToken);
      }
      const existing = this.api.getAccessToken();
      if (existing) return existing;
      try {
        const g = await this.api.guest();
        return g.accessToken;
      } catch (e) {
        return null;
      }
    }

    async onlineCreateRoom() {
      this.renderOnlineModal("connecting");
      const token = await this.ensureOnlineToken();
      if (!token) {
        this._onlineError(tr("Не удалось подключиться к серверу."));
        return;
      }
      try {
        const res = await this.api.createRoom();
        this._roomCode = res.code;
        this.hideNewMenu();
        this.startOnlineMatch(res.matchId, res.you || 1, token);
        this.renderOnlineModal("create"); // stays open until opponent joins
      } catch (e) {
        this._onlineError(tr("Не удалось создать комнату."));
      }
    }

    async onlineJoinRoom(rawCode) {
      const code = String(rawCode || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (code.length < 4) {
        this._onlineError(tr("Введите код комнаты."), "onlineJoinError");
        return;
      }
      const token = await this.ensureOnlineToken();
      if (!token) {
        this._onlineError(tr("Не удалось подключиться к серверу."), "onlineJoinError");
        return;
      }
      try {
        const res = await this.api.joinRoom(code);
        this.hideNewMenu();
        this.hideOnlineModal(false);
        this.startOnlineMatch(res.matchId, res.you || 2, token);
      } catch (e) {
        const ec = e && e.code;
        const msg =
          ec === "room-not-found"
            ? tr("Комната не найдена.")
            : ec === "room-full"
              ? tr("Комната уже занята.")
              : tr("Не удалось войти в комнату.");
        this._onlineError(msg, "onlineJoinError");
      }
    }

    async onlineQueue() {
      // BUGFIX: re-entering the queue (double-click "Random") overwrote
      // _queuePollTimer without clearing the previous interval — leaking a
      // setInterval that polled forever. Cancel any in-flight queue first.
      this.cancelPendingQueue();
      this.renderOnlineModal("searching");
      const token = await this.ensureOnlineToken();
      if (!token) {
        this._onlineError(tr("Не удалось подключиться к серверу."));
        return;
      }
      try {
        const res = await this.api.queue();
        if (res && res.paired && res.matchId) {
          this._inQueue = false;
          this.hideNewMenu();
          this.hideOnlineModal(false);
          this.startOnlineMatch(res.matchId, res.you || 1, token);
          return;
        }
        this._inQueue = true;
        this._queuePollTimer = setInterval(() => this._pollQueue(token), 1600);
      } catch (e) {
        this._onlineError(tr("Не удалось встать в очередь."));
      }
    }

    async _pollQueue(token) {
      if (!this._inQueue || !this.api) return;
      try {
        const me = await this.api.lobbyMe();
        if (me && me.state === "in_match" && me.matchId) {
          this.cancelPendingQueue();
          this.hideNewMenu();
          this.hideOnlineModal(false);
          this.startOnlineMatch(me.matchId, me.you || 1, token);
        }
      } catch (e) {
        /* keep polling */
      }
    }

    _onlineError(msg, elId) {
      const el = elId ? document.getElementById(elId) : null;
      if (el) {
        el.textContent = msg;
        return;
      }
      this.renderOnlineModal("menu");
      const sub = document.querySelector("#onlineModalBody .online-modal-sub");
      if (sub) {
        sub.textContent = msg;
        sub.style.color = "var(--warn)";
      }
    }

    updateOnlineHud() {
      const el = document.getElementById("hudOnline");
      if (!el) return;
      if (!this.online) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      let txt = "";
      if (this.connState === "reconnecting") txt += "⟳ ";
      else if (this.connState !== "open") txt += "… ";
      if (this.onlineStatus === "waiting") {
        txt += tr("Ожидание соперника");
      } else if (this.winner !== null) {
        txt += this.winner === this.myPlayer ? tr("🏆 Победа") : tr("Поражение");
      } else {
        const mine = this.currentPlayer === this.myPlayer;
        const myNick = this.authUser && this.authUser.displayName ? this.authUser.displayName : tr("Вы");
        const oppNick = this.opponentNick || tr("Соперник");
        // Whose turn, labelled by nickname so each player sees who is who.
        txt += (mine ? "▶ " + myNick : oppNick) + " · " + (mine ? tr("Ваш ход") : tr("ходит"));
        if (this.turnEndsAt) {
          const s = Math.max(0, Math.ceil((this.turnEndsAt - Date.now()) / 1000));
          txt += " · " + s + (getLang() === "en" ? "s" : "с");
        }
      }
      el.textContent = txt;
      el.className =
        "hud-chip" +
        (this.currentPlayer === this.myPlayer && this.onlineStatus === "in_progress" ? " p1" : "");
    }

    onAssetsReady() {
      // Restore cached user instantly so the account bar shows immediately.
      const cached = this.loadAuthUserCache();
      if (cached) this.authUser = cached;

      if (this.pendingSavedState && this.restoreSavedState(this.pendingSavedState)) {
        this.pendingSavedState = null;
        this.message = this.message || tr("Партия восстановлена.");
        this.renderSidebar();
      } else {
        if (this.screen !== "game") {
          this.screen = "menu";
          this.message = tr("Выберите режим игры");
        }
        this.renderSidebar();
      }

      // Verify session in background: exchange refresh cookie → new access token.
      this.tryAutoLogin().then((loggedIn) => {
        if (loggedIn !== !!cached) {
          // Auth state changed (was logged out, now in; or cache was stale).
          this.renderSidebar();
        }
      });
    }

    backToMenu() {
      if (this.online) this.closeOnline();
      this.undoStack = [];
      this.tutorialMode = false;
      this.tutorialStep = 0;
      this.screen = "menu";
      this.mode = null;
      this.player1Bottom = false;
      this.selectedUnit = null;
      this.previewUnitId = null;
      this.winner = null;
      this.lastEvent = "";
      this.pendingWeaponEquip = null;
      this.weaponTargetMap.clear();
      this.clearHighlights();
      this.message = tr("Выберите режим игры");
      document.getElementById('menuLeft')?.classList.remove('panel-open');
      document.getElementById('menuRight')?.classList.remove('panel-open');
      document.getElementById('menuArrowLeft')?.classList.remove('panel-open');
      document.getElementById('menuArrowRight')?.classList.remove('panel-open');
      document.getElementById('menuBackdrop')?.classList.remove('visible');
      this.renderSidebar();
    }

    isGameActive() {
      return this.screen === "game";
    }

    // FUNC-002 fix (Phase 1 plan): replace hardcoded "2 игрока" label with
    // a mode-aware label. Story is encoded as mode="ai" + currentStoryTask
    // set, so check the story task first.
    getGameModeLabel() {
      if (this.currentStoryTask) {
        const t = this.currentStoryTask.task;
        if (t && t.name) return tr("Сюжет: {name}", { name: this.trName(t.name) });
        return tr("Сюжет");
      }
      if (this.mode === "ai") {
        const labelMap = { easy: "Слабый", medium: "Средний", hard: "Сложный", impossible: "Невозможный" };
        const diff = this.aiDifficulty && labelMap[this.aiDifficulty]
          ? tr(labelMap[this.aiDifficulty])
          : (this.aiDifficulty || "");
        return diff ? ("vs AI: " + diff) : "vs AI";
      }
      return tr("2 игрока");
    }

    // ── Faction & theme ───────────────────────────────────────
    getChapterFaction(ci) {
      // Ch 0=training(red), 1=pirates(black/sea), 2=ninjas(purple), 3=trolls(yellow), 4=final(black)
      return ['red', 'black', 'purple', 'yellow', 'black'][ci] || 'red';
    }
    getChapterTheme(ci) {
      return ci === 1 ? 'sea' : 'land';
    }

    startMatch(mode, difficulty, storyTask, customPositions?) {
      this.undoStack = [];
      this.hideNewMenu();
      document.getElementById('menuLeft')?.classList.remove('panel-open');
      document.getElementById('menuRight')?.classList.remove('panel-open');
      document.getElementById('menuBackdrop')?.classList.remove('visible');
      this.clearSave();
      this.music.playBattle();

      this.lastCustomPositions = customPositions || null;

      // Рандомизируем позиции замков, башен и руин (из пула 100 проверенных карт)
      randomizeMapPositions(MAP_POOL[Math.floor(Math.random() * MAP_POOL.length)]);

      const gameMode = mode || "pvp";
      this.screen = "game";
      this.mode = gameMode;
      this.currentStoryTask = storyTask || null;
      this.p1Faction = 'blue';
      if (storyTask) {
        this.p2Faction = this.getChapterFaction(storyTask.ci);
        this.mapTheme  = this.getChapterTheme(storyTask.ci);
      } else {
        this.p2Faction = 'red';
        this.mapTheme  = 'land';
      }
      this.aiDifficulty = gameMode === "ai" ? (difficulty || "medium") : null;
      this.player1Bottom = gameMode === "ai";
      this.board = new Board(this.player1Bottom, true, customPositions || undefined);
      // BUGFIX: gear dropped by units slain in the PREVIOUS match used to
      // survive into this one (it sat on the same cells, ready to be picked up
      // by whoever walked there). Every match starts with a clean board.
      this.droppedBackpacks = [];
      // Bury this match's hidden weapon parts/weapons/armour. Done after the
      // board is built so starting units, castles and towers are excluded.
      this.scatterMatchPickups();
      this.currentPlayer = 1;
      this.activatedCount = 0;
      this.selectedUnit = null;
      this.previewUnitId = null;
      this.winner = null;
      this.turnNumber = 1;
      this.message = "";
      this.lastEvent = "";
      this.shieldTurns = { 1: 0, 2: 0 };
      this.damageBuff = { 1: 0, 2: 0 };
      this.tutorialMode = false;
      this.tutorialStep = 0;
      this.pendingWeaponEquip = null;
      this.weaponTargetMap.clear();
      this.clearHighlights();
      if (gameMode === "ai") {
        if (storyTask && storyTask.task && storyTask.task.aiPreset) {
          this.ai.setConfig(storyTask.task.aiPreset);
        } else {
          this.ai.setDifficulty(this.aiDifficulty);
        }
      }
      this.boardFadeIn = 0; // Anim #13: trigger fade-in
      this.arrowProjectiles = [];
      this.startTurn();
      this.ai.reset();
      this.maybeShowTutorial();
    }

    // B4: first-run interactive tutorial — contextual coachmarks over the live
    // board. Shows once (localStorage flag), non-blocking (board stays usable),
    // skippable. Replaces learning-by-text-wall with in-context steps.
    maybeShowTutorial() {
      try {
        if (localStorage.getItem('kac_tutorial_v1')) return;
      } catch (e) {
        return;
      }
      this._tutSteps = [
        tr('Тапни своего воина, чтобы выбрать его.'),
        tr('Зелёные клетки — куда можно пойти. Красные — кого можно атаковать; число над врагом показывает урон.'),
        tr('За ход активируй до 3 воинов. «↶ Отменить» откатит действие, «⚠ Угрозы» покажет, куда бьёт враг.'),
        tr('Цель — уничтожить войско противника или захватить его замок. Удачи!'),
      ];
      this._tutIndex = 0;
      this.showTutorialStep();
    }

    showTutorialStep() {
      const overlay = document.getElementById('tutorialOverlay');
      const stepEl = document.getElementById('tutStep');
      const textEl = document.getElementById('tutText');
      const nextEl = document.getElementById('tutNext');
      if (!overlay || !stepEl || !textEl || !nextEl || !this._tutSteps) return;
      const n = this._tutSteps.length;
      stepEl.textContent = tr('Обучение — шаг {n} / {total}', { n: this._tutIndex + 1, total: n });
      textEl.textContent = this._tutSteps[this._tutIndex];
      nextEl.textContent = this._tutIndex >= n - 1 ? tr('Понятно') : tr('Далее');
      overlay.classList.add('active');
    }

    finishTutorial() {
      const overlay = document.getElementById('tutorialOverlay');
      if (overlay) overlay.classList.remove('active');
      try {
        localStorage.setItem('kac_tutorial_v1', '1');
      } catch (e) {}
    }

    startTutorial() {
      try { localStorage.setItem('kac_tutorial_v1', '1'); } catch(e) {}
      this.startMatch('ai', 'easy');
      this.tutorialMode = true;
      this.tutorialStep = 0;
      this.renderSidebar();
    }

    _tutorialOnEvent(ev) {
      if (!this.tutorialMode) return;
      const step = this.tutorialStep;
      if (ev === 'unit_selected' && (step === 0 || step === 4)) {
        this.tutorialStep = step === 0 ? 1 : 5;
      } else if (ev === 'moved' && step === 1) {
        this.tutorialStep = 2;
      } else if (ev === 'p2_turn' && step === 2) {
        this.tutorialStep = 3;
      } else if (ev === 'p1_turn' && step === 3) {
        this.tutorialStep = 4;
      } else {
        return; // no state change
      }
      this.renderSidebar();
    }

    _tutorialGetText() {
      switch (this.tutorialStep) {
        case 0: return tr('Привет! Нажми на любого синего воина, чтобы выбрать его.');
        case 1: return tr('Отлично! Теперь нажми на зелёную клетку — перемести воина вперёд.');
        case 2: return this.attackMap.size > 0
          ? tr('Хорошо! Атакуй врага — нажми на красную клетку.')
          : tr('Нет атак в досягаемости. Заверши ход — активируй ещё 2 воинов или нажми «Пропустить».');
        case 3: return tr('Ход соперника — наблюдай как играет ИИ…');
        case 4: return tr('Ещё раз! Выбери следующего синего воина.');
        case 5: return tr('🏆 Обучение пройдено! Теперь ты знаешь основы. Продолжай играть!');
        default: return '';
      }
    }

    _tutorialGetSpotlightCells() {
      const step = this.tutorialStep;
      if (step === 0 || step === 4) {
        return this.ownUnits(1).filter(u => u.alive() && !u.done).map(u => [u.row, u.col]);
      }
      if (step === 1) {
        const cells = [];
        this.moveMap.forEach(m => cells.push([m.row, m.col]));
        return cells;
      }
      if (step === 2) {
        const cells = [];
        this.attackMap.forEach(a => {
          cells.push(a.mode === 'shot' ? [a.targetRow, a.targetCol] : [a.row, a.col]);
        });
        return cells;
      }
      return [];
    }

    drawTutorialSpotlight(ctx) {
      if (!this.tutorialMode) return;
      const cells = this._tutorialGetSpotlightCells();
      if (!cells.length) return;
      const pulse = Math.abs(Math.sin(this.frameCount * 0.09));
      ctx.save();
      ctx.lineWidth = 3;
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 8 + pulse * 16;
      ctx.strokeStyle = 'rgba(255,215,60,' + (0.55 + pulse * 0.45) + ')';
      for (const [r, c] of cells) {
        ctx.strokeRect(c * CELL_SIZE + 2, r * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
      }
      ctx.restore();
    }

    startTurn() {
      this.activatedCount = 0;
      this.selectedUnit = null;
      // The event banner describes something that happened LAST turn ("Лучник
      // завершил ход"). Left standing it contradicts the live unit panels — a
      // freshly reset archer shows 3/3 moves under a card saying it is done.
      this.lastEvent = "";
      this.clearHighlights();
      if (this.tutorialMode) {
        if (this.currentPlayer === 2 && this.tutorialStep === 2) this._tutorialOnEvent('p2_turn');
        else if (this.currentPlayer === 1 && this.tutorialStep === 3) this._tutorialOnEvent('p1_turn');
      }
      this.ownUnits(this.currentPlayer).forEach((u) => {
        u.resetTurn();
        this.clampUnitArmor(u);
      });

      const maxCanActivate = Math.min(this.maxActivatedPerTurn, this.ownUnits(this.currentPlayer).length);
      this.message = tr("Ход игрока {p}. Активируйте до {n} юнитов.", { p: this.currentPlayer, n: maxCanActivate });
      this.renderSidebar();
    }

    ownUnits(player) {
      return this.board.unitsOf(player);
    }

    canUnitAct(unit) {
      if (!unit || !unit.alive() || unit.done) {
        return false;
      }
      if (unit.activated) {
        return true;
      }
      return this.activatedCount < this.maxActivatedPerTurn;
    }

    handleCanvasClick(px, py) {
      if (this.screen !== "game") {
        return;
      }
      if (this.mode === "ai" && this.currentPlayer === 2) {
        return;
      }
      if (this.onlineInputLocked()) {
        return;
      }

      const localX = (px - this.boardOffsetX) / this.boardScale;
      const localY = (py - this.boardOffsetY) / this.boardScale;
      const epsilon = 0.0001;
      if (localX < -epsilon || localY < -epsilon || localX > WIDTH + epsilon || localY > HEIGHT + epsilon) {
        return;
      }
      const clampedX = Math.min(WIDTH - epsilon, Math.max(0, localX));
      const clampedY = Math.min(HEIGHT - epsilon, Math.max(0, localY));
      const col = Math.floor(clampedX / CELL_SIZE);
      const row = Math.floor(clampedY / CELL_SIZE);
      if (!insideBoard(row, col)) {
        return;
      }

      const clickedUnit = this.board.unitAt(row, col);
      if (this.pendingWeaponEquip) {
        if (clickedUnit && this.canEquipWeaponToUnit(this.pendingWeaponEquip, clickedUnit)) {
          this.equipPendingWeapon(clickedUnit.id);
        } else {
          this.message = tr("Выберите подходящего союзника для экипировки оружия.");
          this.renderSidebar();
        }
        return;
      }

      if (clickedUnit) {
        if (this.previewUnitId === clickedUnit.id) {
          this.previewUnitId = null;
        } else {
          this.previewUnitId = clickedUnit.id;
        }
      }

      if (this.winner !== null) {
        this.renderSidebar();
        return;
      }

      if (this.selectedUnit) {
        if (this.transferOpenUnitId !== null && this.transferOpenUnitId === this.selectedUnit.id) {
          const allies = this.adjacentAllies(this.selectedUnit);
          const allyClicked = allies.find((a) => a.row === row && a.col === col);
          if (allyClicked) {
            // Bug fix: this used to fire confirmTransfer() immediately once a
            // target was picked (if items were already checked), so clicking an
            // ally on the map to look at them — with a checkbox left ticked from
            // an earlier transfer — silently gave away items with no explicit
            // confirmation. A map click now only PICKS the target, same as the
            // list button; "Отдать" is the one and only action that commits it.
            this.transferTargetId = allyClicked.id;
            this.renderSidebar();
            return;
          }
        }

        if (this.rockMode) {
          this.recordUndo();
          if (this.throwRock(row, col)) return;
          // Clicking off-target simply cancels aiming.
          this.rockMode = false;
          this.rockTargets = [];
          this.renderSidebar();
          return;
        }
        if (this.mageMode === 'ward') {
          // Ward is a multi-select: clicking a unit toggles it in the pending
          // batch, nothing is applied until "Готово" (confirmMageWard).
          // Clicking empty ground does nothing (stays in picking mode).
          const clicked = this.board.unitAt(row, col);
          if (clicked) this.pickMageWardUnit(clicked.id);
          return;
        }
        if (this.mageMode) {
          this.recordUndo();
          if (this.performMageAbility(row, col)) return;
          // Clicking off-target simply cancels aiming, same as rock/build mode.
          this.mageMode = null;
          this.mageTargets = [];
          this.renderSidebar();
          return;
        }
        if (this.buildMode) {
          this.recordUndo();
          if (this.buildStructure(row, col)) return;
          this.buildMode = null;
          this.buildTargets = [];
          this.renderSidebar();
          return;
        }
        const atk = this.attackMap.get(toKey(row, col));
        if (atk) {
          // Cavalry can have two jump/L-attacks land on the same cell with
          // DIFFERENT victims (two enemies flanking it in an L). Clicking that
          // cell used to always resolve to whichever action rebuildHighlights
          // happened to write last — the other enemy was simply untargetable.
          const choices = this.attackChoices.get(toKey(row, col));
          if (choices && choices.length > 1) {
            this.pendingAttackChoice = { landRow: row, landCol: col, options: choices };
            this.renderSidebar();
            return;
          }
          this.recordUndo();
          this.performAttack(row, col);
          return;
        }

        if (this.pendingAttackChoice) {
          // A choice is open: clicking one of the highlighted victims resolves
          // it. Clicking anything else cancels — same "click off-target
          // cancels" convention as rock-aiming mode above.
          const picked = this.pendingAttackChoice.options.find(
            (o) => o.targetRow === row && o.targetCol === col,
          );
          if (picked) {
            this.recordUndo();
            this.performAttack(this.pendingAttackChoice.landRow, this.pendingAttackChoice.landCol, false, picked);
          }
          this.pendingAttackChoice = null;
          this.renderSidebar();
          return;
        }

        const mv = this.moveMap.get(toKey(row, col));
        if (mv) {
          this.recordUndo();
          this.performMove(row, col);
          return;
        }

        if (
          clickedUnit &&
          clickedUnit.player === this.currentPlayer &&
          !clickedUnit.done &&
          clickedUnit.id !== this.selectedUnit.id &&
          this.selectedUnit.movesLeft === this.selectedUnit.maxMoves
        ) {
          this.selectedUnit.activated = false;
          this.activatedCount = Math.max(0, this.activatedCount - 1);
          this.selectUnit(row, col);
          return;
        }

        this.renderSidebar();
        return;
      }

      if (clickedUnit && clickedUnit.player === this.currentPlayer && !clickedUnit.done) {
        this.selectUnit(row, col);
      } else {
        this.renderSidebar();
      }
    }

    selectUnit(row, col, byAi = false) {
      if (this.pendingWeaponEquip) {
        this.blockUntilWeaponEquipped();
        return false;
      }
      const unit = this.board.unitAt(row, col);
      if (!unit) {
        return false;
      }
      if (unit.player !== this.currentPlayer || unit.done) {
        return false;
      }
      if (!this.canUnitAct(unit)) {
        return false;
      }
      if (!unit.activated) {
        unit.activated = true;
        this.activatedCount += 1;
      }

      this.selectedUnit = unit;
      // Selecting also previews, so the reach zone shows immediately and stays
      // visible for the whole turn instead of only on a bare tap.
      this.previewUnitId = unit.id;
      // A new selection closes any open transfer panel from the previous unit.
      this.transferOpenUnitId = null;
      this.transferTargetId = null;
      this.transferSelection = {};
      unit.triggerSelectBounce(); // Anim #1
      this.rebuildHighlights();
      this.message = tr("Юнит выбран: {name}. Ходов: {moves}.", { name: this.trName(unit.name), moves: unit.movesLeft });
      // Crossbow's pierce shot hits every unit on its line, friend or foe —
      // flag it up front if any live line would clip one of the player's own.
      if (unit.type === "crossbow") {
        const hitsAlly = [...this.attackMap.values()].some(
          (a) =>
            a.mode === "pierce" &&
            (a.targets || [{ row: a.targetRow, col: a.targetCol }]).some((cell) => {
              const occupant = this.board.unitAt(cell.row, cell.col);
              return occupant && occupant.player === unit.player;
            }),
        );
        if (hitsAlly) {
          this.message = tr("⚠️ Пробивной выстрел заденет и своего юнита на линии!");
        }
      }
      this.renderSidebar();
      if (!byAi) this._tutorialOnEvent('unit_selected');
      return true;
    }

    moveActionsFor(unit) {
      // Phase 2: delegate to @kc/game-rules. Returns [{kind:'move', row, col, cost}].
      // Inline callsites use .row/.col/.cost only; extra 'kind' field is harmless.
      if (!unit) return [];
      return generateLegalMoves(this.board, unit);
    }

    attackActionsFor(unit) {
      // Phase 2: delegate to @kc/game-rules. Returns AttackAction[] with shot|jump|l-attack modes.
      // FUNC-003 fix lives in game-rules/moves.ts (chess-knight 8 offsets).
      if (!unit) return [];
      return generateAttackActions(this.board, unit);
    }

    rebuildHighlights() {
      this.clearHighlights();
      if (!this.selectedUnit) {
        return;
      }
      const moves = this.moveActionsFor(this.selectedUnit);
      const attacks = this.attackActionsFor(this.selectedUnit);

      moves.forEach((m) => {
        this.moveMap.set(toKey(m.row, m.col), m);
        this.highlightFrames.set(toKey(m.row, m.col), this.frameCount); // Anim #2
      });
      attacks.forEach((a) => {
        const key = a.mode === 'shot' || a.mode === 'pierce' ? toKey(a.targetRow, a.targetCol) : toKey(a.row, a.col);
        // A cavalry attack is keyed by its LANDING cell, which is very often a
        // cell the unit can also simply walk to. The click handler tests
        // attackMap first, so the shared key turned a plain move into a jump
        // attack — the horse ended up somewhere the player never aimed at.
        // The attack wins the cell (it is the more specific intent), so the
        // duplicate move must go, otherwise the two maps disagree about what
        // that square does.
        this.moveMap.delete(key);
        // Cavalry can also land TWO DIFFERENT attacks (jump over one enemy,
        // L-attack around another) on the very same cell — e.g. two knights
        // flanking it in an L shape. `attackMap.set` used to silently drop
        // whichever action generateAttackActions listed first, so one of the
        // two enemies was simply impossible to target: every click on that
        // square always resolved to the same (last-written) victim. Keep every
        // candidate for the cell; performAttack decides below whether the
        // player needs to be asked which one they meant.
        const existing = this.attackChoices.get(key);
        if (existing) {
          if (!existing.some((o) => o.targetRow === a.targetRow && o.targetCol === a.targetCol)) {
            existing.push(a);
          }
        } else {
          this.attackChoices.set(key, [a]);
        }
        this.attackMap.set(key, a);
        this.highlightFrames.set(key, this.frameCount); // Anim #2
      });
    }

    clearHighlights() {
      // Aiming is tied to the selected catapult; drop it with the selection.
      this.rockMode = false;
      this.rockTargets = [];
      this.buildMode = null;
      this.buildTargets = [];
      // Mage ability aiming is likewise tied to the selected mage.
      this.mageMode = null;
      this.mageTargets = [];
      this.mageWardPicks = new Set();
      this.pendingMageAttack = null;
      this.moveMap.clear();
      this.attackMap.clear();
      this.attackChoices.clear();
      this.pendingAttackChoice = null;
      this.highlightFrames.clear();
    }

    performMove(row, col) {
      if (this.pendingWeaponEquip) {
        this.blockUntilWeaponEquipped();
        return false;
      }
      if (!this.selectedUnit) {
        return false;
      }
      const action = this.moveMap.get(toKey(row, col));
      if (!action) {
        return false;
      }
      if (this.selectedUnit.movesLeft < action.cost) {
        return false;
      }

      if (this.online) {
        // Optimistic: queue the action for the turn's batch, then play it
        // locally (the offline mutation path below) so the board responds
        // instantly. The authoritative echo reconciles at end of turn.
        this.recordAction({
          kind: "move",
          unitId: this.selectedUnit.id,
          row: action.row,
          col: action.col,
          cost: action.cost,
        });
      }

      // Start smooth movement animation
      this.selectedUnit.startMoveTo(action.row, action.col);
      this.selectedUnit.row = action.row;
      this.selectedUnit.col = action.col;
      this.selectedUnit.movesLeft -= action.cost;

      // Hidden pickup buried on the destination cell, then any visible loot.
      this.claimHiddenPickup(this.selectedUnit);
      // Drop/pickup: grab any compatible gear left on the destination cell.
      this.pickUpDroppedItems(this.selectedUnit);

      // Anim #10: tower flash when unit steps onto a tower
      if (this.board.isTower(action.row, action.col)) {
        this.towerFlashTimer = 1;
        this.towerFlashRow = action.row;
        this.towerFlashCol = action.col;
        // Tell the player what the tower actually does for this unit.
        const u = this.selectedUnit;
        const ranged = u && (u.type === "archer" || u.type === "crossbow" || u.type === "catapult");
        if (ranged) {
          this.lastEvent = tr("Ты в башне: дальность стрельбы увеличена, но урон слабее.");
          this.createFloatingText(
            tr("Дальность +"),
            action.col * CELL_SIZE + CELL_SIZE / 2,
            action.row * CELL_SIZE + CELL_SIZE / 2 - 14,
            "#8fd7ff",
            15
          );
        } else {
          this.lastEvent = tr("Ты в башне: отсюда можно колдовать.");
        }
      }

      this.checkWinner();
      if (this.winner !== null) {
        this.selectedUnit = null;
        this.clearHighlights();
        // A castle-capturing move ends the game now — ship it immediately
        // instead of waiting for end-turn.
        if (this.online) this.flushTurn();
        this.renderSidebar();
        this._tutorialOnEvent('moved');
        return true;
      }

      if (this.selectedUnit.movesLeft <= 0) {
        this.lastEvent = tr("{name} завершил ход.", { name: this.trName(this.selectedUnit.name) });
        this.finishSelectedUnit();
      } else {
        this.rebuildHighlights();
        this.message = tr("Ходов осталось: {n}.", { n: this.selectedUnit.movesLeft });
        this.renderSidebar();
      }
      this._tutorialOnEvent('moved');
      return true;
    }

    computeDamage(attacker, target) {
      // Phase 2: delegate to @kc/game-rules. Same legacy quirky contract:
      // returns damage value if it pierces armor, otherwise 0 (used by AI heuristics).
      return gameRulesComputeDamage(attacker, target, {
        damageBuff: this.damageBuff,
        shieldTurns: this.shieldTurns,
        attackerOnTower: this.board.isTower(attacker.row, attacker.col),
      });
    }

    performAttack(row, col, byAi = false, chosenAction = null) {
      if (this.pendingWeaponEquip) {
        this.blockUntilWeaponEquipped();
        return false;
      }
      if (!this.selectedUnit) {
        return false;
      }
      // `chosenAction` disambiguates a landing-cell collision (two cavalry
      // attacks sharing a square) — see handleCanvasClick. Falls back to the
      // plain attackMap lookup for every other case.
      const action = chosenAction || this.attackMap.get(toKey(row, col));
      if (!action) {
        return false;
      }
      if (this.selectedUnit.movesLeft < action.cost) {
        return false;
      }

      // Crossbow's piercing bolt hits every living unit along its 2-cell line
      // — friend or foe alike — so it has no single "target" and skips the
      // single-target ally-check below entirely.
      if (action.mode === 'pierce') {
        return this.performPierceAttack(action);
      }

      const target = this.board.unitAt(action.targetRow, action.targetCol);
      const isBridgeTarget =
        !target &&
        this.selectedUnit.type === 'catapult' &&
        getTerrain().some(
          (t) => t.row === action.targetRow && t.col === action.targetCol && t.type === 'bridge'
        );

      if (!isBridgeTarget && (!target || target.player === this.selectedUnit.player)) {
        return false;
      }

      if (this.online) {
        // Optimistic: queue for the turn batch, then resolve locally below.
        this.recordAction({
          kind: "attack",
          unitId: this.selectedUnit.id,
          mode: action.mode,
          cost: action.cost,
          targetRow: action.targetRow,
          targetCol: action.targetCol,
          landingRow: action.landingRow,
          landingCol: action.landingCol,
        });
      }

      if (isBridgeTarget) {
        this.selectedUnit.movesLeft -= action.cost;

        const attackerX = this.selectedUnit.col * CELL_SIZE + CELL_SIZE / 2;
        const attackerY = this.selectedUnit.row * CELL_SIZE + CELL_SIZE / 2;
        const targetX   = action.targetCol * CELL_SIZE + CELL_SIZE / 2;
        const targetY   = action.targetRow * CELL_SIZE + CELL_SIZE / 2;

        fxCreateArrow(this.arrowProjectiles, attackerX, attackerY, targetX, targetY, '#ff8844');
        this.cameraShake = 10;
        this.createExplosion(targetX, targetY, "#ff8844", 8);

        const key = `${action.targetRow},${action.targetCol}`;
        const currentHp = getBridgeDurability()[key] ?? 2;
        const nextHp = currentHp - 1;

        if (nextHp <= 0) {
          const updated = { ...getBridgeDurability() };
          delete updated[key];
          setBridgeDurability(updated);

          const newTerrain = getTerrain()
            .filter((t) => !(t.row === action.targetRow && t.col === action.targetCol && t.type === 'bridge'))
            .concat([{ row: action.targetRow, col: action.targetCol, type: 'river' }]);
          setTerrain(newTerrain);

          this.createExplosion(targetX, targetY, "#666", 12);
          this.createExplosion(targetX, targetY, "#ffffff", 6);
          this.lastEvent = tr("{attacker} уничтожает мост выстрелом!", {
            attacker: this.trName(this.selectedUnit.name),
          });
        } else {
          setBridgeDurability({ ...getBridgeDurability(), [key]: nextHp });
          this.createFloatingText("-1", targetX, targetY - 10, "#ffaa44", 20);
          this.lastEvent = tr("{attacker} повреждает мост!", {
            attacker: this.trName(this.selectedUnit.name),
          });
        }

        this.renderSidebar();
        return true;
      }

      if (action.mode === "jump" || action.mode === "l-attack") {
        // Animate jump movement
        this.selectedUnit.startMoveTo(action.landingRow, action.landingCol);
        this.selectedUnit.row = action.landingRow;
        this.selectedUnit.col = action.landingCol;
      }

      // Damage = pure game-rules computation (buffs/archer-min-1), then the
      // two-layer armor->hp model. Same functions power the forecast overlay, so
      // the predicted number always equals the dealt number. shieldTurns is no
      // longer read here — ward is per-unit now (this.absorbWithWard below),
      // not the old flat side-wide -2/hit (see [[kc-mage-ward-mechanic]]).
      const damage = attackDamage(this.selectedUnit, target, {
        damageBuff: this.damageBuff,
        shieldTurns: this.shieldTurns,
        // Attack resolves from where the unit stands now; a jump/l-attack has
        // already moved it, which is exactly the cell the shot comes from.
        attackerOnTower: this.board.isTower(this.selectedUnit.row, this.selectedUnit.col),
      });
      const warded = this.absorbWithWard(target, damage);
      if (!warded) applyDamageToTarget(target, damage);

      this.selectedUnit.movesLeft -= action.cost;

      const attackerX = this.selectedUnit.col * CELL_SIZE + CELL_SIZE / 2;
      const attackerY = this.selectedUnit.row * CELL_SIZE + CELL_SIZE / 2;
      const targetX   = target.col * CELL_SIZE + CELL_SIZE / 2;
      const targetY   = target.row * CELL_SIZE + CELL_SIZE / 2;

      // Anim #4: projectile for ranged shots
      if (action.mode === 'shot') {
        const ut = this.selectedUnit.type;
        if (ut === 'archer' || ut === 'crossbow') {
          fxCreateArrow(this.arrowProjectiles, attackerX, attackerY, targetX, targetY, ut === 'crossbow' ? '#a0e0ff' : '#ffe066');
        } else if (ut === 'catapult') {
          fxCreateArrow(this.arrowProjectiles, attackerX, attackerY, targetX, targetY, '#ff8844');
        }
      }

      // Anim #5: hit flash on target
      target.triggerHitFlash();

      // Camera shake on hit!
      this.cameraShake = 8;

      // Hit particles + floating damage text
      if (warded) {
        this.createExplosion(targetX, targetY, "#6495ed", 8);
        this.createFloatingText("🛡️ 0", targetX, targetY - 10, "#6495ed", 20);
        this.lastEvent = tr("{attacker} атакует {target}, но щит поглощает удар!", {
          attacker: this.trName(this.selectedUnit.name),
          target: this.trName(target.name),
        });
      } else {
        this.createExplosion(targetX, targetY, "#ff6b6b", 6);
        this.createFloatingText("-" + damage, targetX, targetY - 10, "#ff6b6b", 20);
        this.lastEvent = tr("{attacker} атакует {target} на {dmg} урона.", {
          attacker: this.trName(this.selectedUnit.name),
          target: this.trName(target.name),
          dmg: damage,
        });
      }

      if (target.hp <= 0) {
        this.lastEvent += " " + tr("{name} повержен.", { name: this.trName(target.name) });
        // Drop the slain unit's gear onto its cell so it can be picked up.
        this.dropUnitGear(target);
        target.startDeath();
        this.createExplosion(targetX, targetY, "#666", 8);
        this.createExplosion(targetX, targetY, "#ffffff", 4);
        this.cameraShake = 12;
      }

      // A jump/l-attack relocated the attacker — let it grab whatever is on the
      // landing cell (buried pickup first, then visible loot).
      if (action.mode === "jump" || action.mode === "l-attack") {
        this.claimHiddenPickup(this.selectedUnit);
        this.pickUpDroppedItems(this.selectedUnit);
      }

      this.board.removeDead((u) => this.dropUnitGear(u));
      
      // Clean up truly dead units periodically
      if (this.frameCount % 10 === 0) {
        this.board.removeDead((u) => this.dropUnitGear(u));
      }
      
      // Only forget the preview when that unit actually left the board — not
      // merely because a turn or action ended (bug: the zone vanished after the
      // first move and never came back).
      if (this.previewUnitId !== null && !this.board.units.some((u) => u.id === this.previewUnitId && u.alive())) {
        this.previewUnitId = null;
      }

      this.checkWinner();
      if (this.winner !== null) {
        this.selectedUnit = null;
        this.clearHighlights();
        if (this.online) this.flushTurn();
        this.renderSidebar();
        return true;
      }

      if (this.selectedUnit.movesLeft <= 0) {
        this.finishSelectedUnit();
      } else {
        this.rebuildHighlights();
        this.message = tr("Ходов осталось: {n}.", { n: this.selectedUnit.movesLeft });
        this.renderSidebar();
      }
      return true;
    }

    /**
     * Crossbow's piercing bolt: flies 2 cells in a straight line, hitting a
     * unit on EVERY occupied cell along the way — friend or foe alike. Costs
     * a flat 2 moves. Separate from performAttack's single-target flow
     * because it has no one "target": both cells resolve independently, and
     * a friendly unit standing on the line takes the hit too.
     */
    performPierceAttack(action) {
      const line = action.targets && action.targets.length
        ? action.targets
        : [
            { row: action.targetRow, col: action.targetCol },
            { row: action.row + (action.targetRow - action.row) * 2, col: action.col + (action.targetCol - action.col) * 2 },
          ];
      const victims = line
        .map((cell) => this.board.unitAt(cell.row, cell.col))
        .filter((u) => u && u.alive());
      if (victims.length === 0) return false;

      if (this.online) {
        this.recordAction({
          kind: "attack",
          unitId: this.selectedUnit.id,
          mode: "pierce",
          cost: action.cost,
          targetRow: action.targetRow,
          targetCol: action.targetCol,
          landingRow: action.landingRow,
          landingCol: action.landingCol,
          targets: line,
        });
      }

      const attacker = this.selectedUnit;
      const attackerX = attacker.col * CELL_SIZE + CELL_SIZE / 2;
      const attackerY = attacker.row * CELL_SIZE + CELL_SIZE / 2;

      // One bolt drawn the full length of the line, regardless of how many
      // cells it actually connects with.
      const farCell = line[line.length - 1];
      fxCreateArrow(
        this.arrowProjectiles,
        attackerX, attackerY,
        farCell.col * CELL_SIZE + CELL_SIZE / 2,
        farCell.row * CELL_SIZE + CELL_SIZE / 2,
        '#a0e0ff',
      );

      attacker.movesLeft -= action.cost;

      const names = [];
      for (const target of victims) {
        if (!target.alive()) continue; // a ward overdraw earlier in this loop may have killed the warding mage — not this target though; guard anyway for safety.
        const damage = attackDamage(attacker, target, {
          damageBuff: this.damageBuff,
          shieldTurns: this.shieldTurns,
          attackerOnTower: this.board.isTower(attacker.row, attacker.col),
        });
        const warded = this.absorbWithWard(target, damage);
        if (!warded) applyDamageToTarget(target, damage);

        const targetX = target.col * CELL_SIZE + CELL_SIZE / 2;
        const targetY = target.row * CELL_SIZE + CELL_SIZE / 2;
        target.triggerHitFlash();
        if (warded) {
          this.createExplosion(targetX, targetY, "#6495ed", 8);
          this.createFloatingText("🛡️ 0", targetX, targetY - 10, "#6495ed", 20);
          names.push(this.trName(target.name) + " (🛡️)");
          continue;
        }
        this.createExplosion(targetX, targetY, "#ff6b6b", 6);
        this.createFloatingText("-" + damage, targetX, targetY - 10, "#ff6b6b", 20);
        names.push(this.trName(target.name) + " (-" + damage + ")");

        if (target.hp <= 0) {
          this.dropUnitGear(target);
          target.startDeath();
          this.createExplosion(targetX, targetY, "#666", 8);
          this.createExplosion(targetX, targetY, "#ffffff", 4);
        }
      }
      this.cameraShake = victims.length > 1 ? 12 : 8;

      this.lastEvent = tr("{attacker} пробивает насквозь: {targets}.", {
        attacker: this.trName(attacker.name),
        targets: names.join(", "),
      });

      this.board.removeDead((u) => this.dropUnitGear(u));

      if (this.previewUnitId !== null && !this.board.units.some((u) => u.id === this.previewUnitId && u.alive())) {
        this.previewUnitId = null;
      }

      this.checkWinner();
      if (this.winner !== null) {
        this.selectedUnit = null;
        this.clearHighlights();
        if (this.online) this.flushTurn();
        this.renderSidebar();
        return true;
      }

      if (this.selectedUnit.movesLeft <= 0) {
        this.finishSelectedUnit();
      } else {
        this.rebuildHighlights();
        this.message = tr("Ходов осталось: {n}.", { n: this.selectedUnit.movesLeft });
        this.renderSidebar();
      }
      return true;
    }

    finishSelectedUnit() {
      // Online play is now optimistic: the same local turn-flow runs, and
      // `endTurn` flushes the whole turn to the server as one batch. This is
      // what makes an online turn auto-end (like offline) instead of stalling.
      if (!this.selectedUnit) {
        return;
      }

      this.selectedUnit.done = true;
      this.selectedUnit.movesLeft = 0;
      this.selectedUnit = null;
      this.clearHighlights();

      if (this.winner !== null) {
        this.renderSidebar();
        return;
      }

      if (this.shouldEndTurn()) {
        this.endTurn();
      } else {
        const left = Math.max(0, this.maxActivatedPerTurn - this.activatedCount);
        this.message = tr("Выберите юнит. Осталось активаций: {n}.", { n: left });
        this.renderSidebar();
      }
    }
    
    isUnitInOwnCastle(unit) {
      if (!unit) return false;
      
      // Определяем зону замка для игрока
      const castleCol = unit.player === 1 ? getCastleP1Col() : getCastleP2Col();
      const castleRow = unit.player === 1 
        ? (this.player1Bottom ? 16 : 0) 
        : (this.player1Bottom ? 0 : 16);
      
      // Проверяем, находится ли юнит в зоне 4x4 замка
      return unit.row >= castleRow && unit.row < castleRow + 4 &&
             unit.col >= castleCol && unit.col < castleCol + 4;
    }
    
    applyCastleHealing() {
      const unit = this.selectedUnit;
      if (!unit) return;

      if (this.online) {
        // Record for the turn batch; the local mutation below mirrors the server.
        this.recordAction({ kind: "castle-heal", unitId: unit.id });
      }

      const hpGain = unit.maxHp - unit.hp;
      const armorGain = unit.maxArmor - unit.armor;
      unit.hp = unit.maxHp;
      unit.armor = unit.maxArmor;

      const parts = [];
      if (hpGain > 0) parts.push("+" + hpGain + " ❤️");
      if (armorGain > 0) parts.push("+" + armorGain + " 🛡");
      this.lastEvent = tr("{name} восстановился в замке: {parts}.", { name: this.trName(unit.name), parts: parts.join(", ") });

      if (hpGain > 0) {
        this.createFloatingText("+" + hpGain + " ❤️",
          unit.col * CELL_SIZE + CELL_SIZE / 2,
          unit.row * CELL_SIZE + CELL_SIZE / 2 - 16,
          "#67cf6f", 16);
      }
      if (armorGain > 0) {
        this.createFloatingText("+" + armorGain + " 🛡",
          unit.col * CELL_SIZE + CELL_SIZE / 2,
          unit.row * CELL_SIZE + CELL_SIZE / 2 + 4,
          "#6495ed", 16);
      }

      unit.done = true;
      unit.movesLeft = 0;
      // Count this unit's activation only once (it may have already moved this turn).
      if (!unit.activated) {
        unit.activated = true;
        this.activatedCount += 1;
      }

      this.selectedUnit = null;
      this.clearHighlights();

      if (this.winner !== null) {
        this.renderSidebar();
        return;
      }

      if (this.shouldEndTurn()) {
        this.endTurn();
      } else {
        const left = Math.max(0, this.maxActivatedPerTurn - this.activatedCount);
        this.message = tr("Выберите юнит. Осталось активаций: {n}.", { n: left });
        this.renderSidebar();
      }
    }

    shouldEndTurn() {
      if (this.pendingWeaponEquip) {
        return false;
      }
      const own = this.ownUnits(this.currentPlayer);
      if (!own.length) {
        return true;
      }
      if (own.every((u) => u.done)) {
        return true;
      }
      if (this.activatedCount >= Math.min(this.maxActivatedPerTurn, own.length) && this.selectedUnit === null) {
        return true;
      }
      return false;
    }

    endTurn() {
      if (this.winner !== null) {
        return;
      }
      if (this.online) {
        if (this.turnSubmitting) return; // already flushing this turn
        if (this.onlineStatus === "in_progress") {
          // Close out the locally-played turn and ship the whole batch at once.
          this.selectedUnit = null;
          this.clearHighlights();
          this.recordAction({ kind: "end-turn" });
          this.turnEndWave = 1; // Anim #7: radial pulse on the local board
          this.flushTurn();
        }
        return;
      }
      this.turnEndWave = 1; // Anim #7: trigger radial pulse wave
      this.undoStack = []; // in-turn undo only — cleared when the turn ends

      // Bug fix: this used to decrement shieldTurns[otherPlayer(ending)] while
      // damageBuff[ending] used the player whose turn is ending — two
      // different indices for two fields that @kc/game-rules' apply.ts
      // (endTurn) always decrements for the same player (`ending`). Harmless
      // today only because both fields are permanently 0 on the client (the
      // old "Небо огня" spell that set them is gone), but real drift the
      // moment either is ever populated again. Match the server: both use
      // `ending`, the player whose turn just finished.
      const ending = this.currentPlayer;

      if (this.shieldTurns[ending] > 0) {
        this.shieldTurns[ending] -= 1;
      }

      if (this.damageBuff[ending] > 0) {
        this.damageBuff[ending] -= 1;
      }

      this.currentPlayer = otherPlayer(ending);
      this.turnNumber += 1;
      this.startTurn();
    }

    forceEndTurn() {
      if (this.pendingWeaponEquip) {
        return;
      }
      this.selectedUnit = null;
      this.clearHighlights();
      this.endTurn();
    }

    skipSelected(fromAI) {
      if (this.pendingWeaponEquip) {
        if (!fromAI) this.blockUntilWeaponEquipped();
        return;
      }
      if (!this.selectedUnit) return;
      if (this.mode === "ai" && this.currentPlayer === 2 && !fromAI) return;
      // Online skip needs no server action — the unit simply doesn't act this
      // turn. Marking it done locally lets the turn auto-end (and flush) just
      // like offline; the server's end-turn resets every unit anyway.
      this.lastEvent = tr("{name} пропускает ход.", { name: this.trName(this.selectedUnit.name) });
      this.finishSelectedUnit();
    }

    canAfford(inv, recipe) {
      const names = Object.keys(recipe);
      for (let i = 0; i < names.length; i += 1) {
        const name = names[i];
        if ((inv[name] || 0) < recipe[name]) {
          return false;
        }
      }
      return true;
    }

    spend(inv, recipe) {
      Object.keys(recipe).forEach((name) => {
        inv[name] -= recipe[name];
      });
    }

    blockUntilWeaponEquipped() {
      if (!this.pendingWeaponEquip) {
        return false;
      }
      this.message = tr("Сначала экипируйте {name}. Выберите союзника на поле.", {
        name: this.trName(this.pendingWeaponEquip.name),
      });
      this.renderSidebar();
      return true;
    }

    clampUnitArmor(unit) {
      if (!unit) {
        return;
      }
      // Equipped armour raises the ceiling above the unit's base startArmor.
      const cap = unit.startArmor + (unit.armorGear ? unit.armorGear.amount : 0);
      unit.maxArmor = Math.min(unit.maxArmor, cap);
      unit.armor = Math.min(unit.armor, cap);
    }

    canEquipWeaponToUnit(weapon, unit) {
      if (!weapon || !unit || !unit.alive()) {
        return false;
      }
      if (unit.player !== this.currentPlayer) {
        return false;
      }
      const slot = weapon.slot === "armor" ? "armor" : "weapon";
      // One item per slot: armour goes in the armour slot, everything else in
      // the weapon slot.
      if (slot === "armor" ? unit.armorGear : unit.weapon) {
        return false;
      }
      const allowedTypes = Array.isArray(weapon.allowedTypes)
        ? weapon.allowedTypes
        : weapon.archerOnly
        ? ["archer"]
        : null;
      if (allowedTypes && !allowedTypes.includes(unit.type)) {
        return false;
      }
      if (Array.isArray(weapon.forbidTypes) && weapon.forbidTypes.includes(unit.type)) {
        return false;
      }
      return true;
    }

    weaponEquipTargets(weapon) {
      return this.ownUnits(this.currentPlayer).filter((u) =>
        this.canEquipWeaponToUnit(weapon, u)
      );
    }

    queueWeaponEquip(weapon, sourceLabel) {
      const slot = weapon.slot === "armor" ? "armor" : "weapon";
      this.pendingWeaponEquip = {
        name: weapon.name,
        amount: weapon.amount,
        icon: weapon.icon || "",
        allowedTypes: Array.isArray(weapon.allowedTypes) ? weapon.allowedTypes.slice() : null,
        forbidTypes: Array.isArray(weapon.forbidTypes) ? weapon.forbidTypes.slice() : null,
        archerOnly: !!weapon.archerOnly,
        slot
      };
      this.lastEvent = tr(sourceLabel) + ": " + this.trName(weapon.name) + ".";
      this.message = tr("Экипируйте {name}{armor} одному из своих юнитов на поле.", {
        name: this.trName(weapon.name),
        armor: slot === "armor" ? tr(" (броня)") : "",
      });
      this.updateWeaponTargets();
      this.renderSidebar();
    }

    equipPendingWeapon(unitId) {
      if (!this.pendingWeaponEquip) {
        return false;
      }
      const target = this.board.units.find((u) => u.id === unitId && u.alive());
      if (!this.canEquipWeaponToUnit(this.pendingWeaponEquip, target)) {
        this.message = tr("Нужно выбрать подходящего союзника для экипировки.");
        this.renderSidebar();
        return false;
      }

      if (this.online) {
        // Optimistic: record the action for the turn's batch and equip locally.
        this.recordAction({ kind: "equip-weapon", unitId });
      }

      const weapon = this.pendingWeaponEquip;
      const isArmor = weapon.slot === "armor";
      this.applyWeaponToUnit(weapon, target);
      this.pendingWeaponEquip = null;
      this.updateWeaponTargets();
      this.lastEvent = tr(
        isArmor
          ? "{name} экипировано юниту {unit} (+{n} брони)."
          : "{name} экипировано юниту {unit} (+{n} урона).",
        { name: this.trName(weapon.name), unit: this.trName(target.name), n: weapon.amount },
      );
      this.message = isArmor ? tr("Броня экипирована.") : tr("Оружие экипировано.");
      if (this.selectedUnit) {
        this.rebuildHighlights();
      }
      if (this.shouldEndTurn()) {
        this.endTurn();
      } else {
        this.renderSidebar();
      }
      return true;
    }

    applyWeaponToUnit(weapon, target) {
      if (!weapon || !target) {
        return;
      }
      const gear = {
        name: weapon.name,
        icon: weapon.icon || "",
        amount: weapon.amount
      };
      if (weapon.slot === "armor") {
        // Armour raises current and max armour so castle/spell restoration accounts for it.
        target.armor += weapon.amount;
        target.maxArmor += weapon.amount;
        target.armorGear = gear;
      } else {
        target.damage += weapon.amount;
        target.weapon = gear;
      }
    }

    updateWeaponTargets() {
      this.weaponTargetMap.clear();
      if (!this.pendingWeaponEquip) {
        return;
      }
      const targets = this.weaponEquipTargets(this.pendingWeaponEquip);
      targets.forEach((unit) => {
        this.weaponTargetMap.set(unit.id, true);
      });
    }

    // ===== Hidden pickups =====================================================
    // Artifacts, weapons and armour are buried across the board at match start
    // (replacing the old searchable ruins). They are invisible, never respawn,
    // and are claimed by the first unit that steps onto the cell. Nothing is
    // buried under a starting unit, inside a castle, or on a tower.

    /** Scatter this match's hidden pickups. Call after the board is built. */
    scatterMatchPickups() {
      const seed = (Math.random() * 0xffffffff) >>> 0;
      // NOTE: main.ts defines its own local `mulberry32` that returns a bare
      // `() => number`, shadowing the game-rules export which returns `{next}`.
      // scatterHiddenPickups expects the latter, so adapt here — passing the
      // raw function silently threw "rng.next is not a function" and left every
      // match with zero buried loot.
      const raw = mulberry32(seed);
      const rng = typeof raw === 'function' ? { next: raw } : raw;
      this.hiddenPickups = scatterHiddenPickups(rng, {
        castleP1Col: getCastleP1Col(),
        castleP2Col: getCastleP2Col(),
        towers: getTowers(),
        occupied: this.board.units.map((u) => ({ row: u.row, col: u.col })),
        terrain: getTerrain(),
      });
    }

    /**
     * Claim whatever is buried under `unit` after it moved. Weapon parts go
     * straight into the finder's own backpack; gear is worn by the finder, or
     * offered to a compatible ally, or left on the ground if nobody in the
     * army can use it. Mirrors game-rules `claimHiddenPickup` so online play
     * stays in lockstep.
     */
    claimHiddenPickup(unit) {
      if (!unit || !this.hiddenPickups || this.hiddenPickups.length === 0) return;
      const idx = this.hiddenPickups.findIndex((p) => p.row === unit.row && p.col === unit.col);
      if (idx < 0) return;
      const found = this.hiddenPickups[idx];
      this.hiddenPickups.splice(idx, 1);

      const cx = unit.col * CELL_SIZE + CELL_SIZE / 2;
      const cy = unit.row * CELL_SIZE + CELL_SIZE / 2 - 12;

      if (found.kind === "part") {
        unit.backpack[found.name] = (unit.backpack[found.name] || 0) + 1;
        this.lastEvent = tr("{name} находит деталь: {item}.", {
          name: this.trName(unit.name),
          item: this.trName(found.name),
        });
        this.createFloatingText("✦ " + this.trName(found.name), cx, cy, PART_COLORS[found.name] || "#dfb2ff", 15);
        // Buried loot is invisible until claimed, so make the moment of finding
        // impossible to miss: burst + camera nudge on top of the log line.
        this.createExplosion(
          unit.col * CELL_SIZE + CELL_SIZE / 2,
          unit.row * CELL_SIZE + CELL_SIZE / 2,
          PART_COLORS[found.name] || "#dfb2ff",
          10
        );
        this.cameraShake = 5;
        this.message = tr("Найдена деталь оружия: {item}!", { item: this.trName(found.name) });
        this.renderSidebar();
        return;
      }

      const catalogue = found.kind === "armor" ? ARMORS : WEAPONS;
      const gear = catalogue.find((w) => w.name === found.name);
      if (!gear) return;
      const item = this.gearToDrop(found.kind === "armor" ? "armor" : "weapon", gear, unit.row, unit.col);

      // The finder wears it when it can.
      if (this.canEquipGearForPickup(item, unit)) {
        this.applyWeaponToUnit(item, unit);
        this.lastEvent = tr(
          item.slot === "armor"
            ? "{name} находит {item} (+{n} брони)."
            : "{name} находит {item} (+{n} урона).",
          { name: this.trName(unit.name), item: this.trName(item.name), n: item.amount },
        );
        this.createFloatingText(
          item.slot === "armor" ? "+" + item.amount + " 🛡" : "+" + item.amount + " ⚔",
          cx, cy,
          item.slot === "armor" ? "#6495ed" : "#ffd700",
          16
        );
        this.renderSidebar();
        return;
      }

      // Bug fix: this used to force a blocking "Обязательная экипировка"
      // picker onto the sidebar whenever SOME other ally on the whole board
      // could wear it — even though the finder itself can't carry an
      // unworn item (no separate inventory slot for that, only weapon/
      // armorGear, which is what's actually equipped). The finder just
      // can't use it, full stop: drop it on the ground as ordinary loot,
      // same as when literally nobody can wear it. A player who wants it on
      // a specific ally can still walk that ally over to pick it up, or use
      // the "Передать предметы" panel once it's carried by someone who can.
      this.pushDroppedGear(item.slot, item, unit.row, unit.col);
      this.lastEvent = tr("{label}, но {name} не может его носить. Оставлено на земле.", {
        label: tr(found.kind === "armor" ? "Найдена броня" : "Найдено оружие"),
        name: this.trName(unit.name),
      });
    }

    // ===== Drop / pickup gear =================================================
    // A slain unit leaves its WHOLE backpack (parts + weapon + armour) as one
    // object on its cell; any unit that later moves onto that cell picks up
    // everything at once — every part, and any gear it can legally wear.
    // Deterministic, so it stays in lockstep with the server reducer (apply.ts).

    /** Add gear to the dropped-backpack record at (row,col), merging into an
     * existing one there if present. */
    pushDroppedGear(slot, gear, row, col) {
      const item = this.gearToDrop(slot, gear, row, col);
      let pack = this.droppedBackpacks.find((d) => d.row === row && d.col === col);
      if (!pack) {
        pack = { row, col, parts: emptyBackpack(), weapon: null, armorGear: null };
        this.droppedBackpacks.push(pack);
      }
      if (slot === "armor") pack.armorGear = item;
      else pack.weapon = item;
    }

    /** Record the gear + parts of a unit about to die as one dropped backpack
     * on its cell. */
    dropUnitGear(unit) {
      if (!unit || unit._gearDropped) return;
      // Guard: removeDead() also drops gear, so a unit slain by an attack (which
      // drops explicitly) must not spill a second copy of its equipment.
      unit._gearDropped = true;
      const hasParts = PARTS.some((p) => (unit.backpack[p] || 0) > 0);
      if (!hasParts && !unit.weapon && !unit.armorGear) return;
      let pack = this.droppedBackpacks.find((d) => d.row === unit.row && d.col === unit.col);
      if (!pack) {
        pack = { row: unit.row, col: unit.col, parts: emptyBackpack(), weapon: null, armorGear: null };
        this.droppedBackpacks.push(pack);
      }
      PARTS.forEach((p) => {
        pack.parts[p] = (pack.parts[p] || 0) + (unit.backpack[p] || 0);
      });
      if (unit.weapon) pack.weapon = this.gearToDrop("weapon", unit.weapon, unit.row, unit.col);
      if (unit.armorGear) pack.armorGear = this.gearToDrop("armor", unit.armorGear, unit.row, unit.col);
    }

    gearToDrop(slot, gear, row, col) {
      const catalogue = slot === "armor" ? ARMORS : WEAPONS;
      const def = catalogue.find((w) => w.name === gear.name);
      return {
        slot,
        name: gear.name,
        amount: gear.amount,
        icon: gear.icon || "",
        allowedTypes: def && Array.isArray(def.allowedTypes) ? def.allowedTypes.slice() : null,
        forbidTypes: def && Array.isArray(def.forbidTypes) ? def.forbidTypes.slice() : null,
        archerOnly: !!(def && def.archerOnly)
      };
    }

    /** Auto-collect any dropped backpack the unit stands on: every weapon
     * part goes straight into its own backpack, and any weapon/armour piece
     * it can wear is equipped. Gear it can't wear stays behind as a smaller
     * leftover backpack. */
    pickUpDroppedItems(unit) {
      if (!unit || !this.droppedBackpacks || this.droppedBackpacks.length === 0) return;
      const remaining = [];
      for (const pack of this.droppedBackpacks) {
        if (pack.row !== unit.row || pack.col !== unit.col) {
          remaining.push(pack);
          continue;
        }
        let gotParts = false;
        PARTS.forEach((p) => {
          const n = pack.parts[p] || 0;
          if (n > 0) {
            unit.backpack[p] = (unit.backpack[p] || 0) + n;
            gotParts = true;
          }
        });
        if (gotParts) {
          this.lastEvent = tr("{name} подбирает детали оружия.", { name: this.trName(unit.name) });
        }

        let leftoverWeapon = pack.weapon;
        let leftoverArmor = pack.armorGear;
        // canEquipWeaponToUnit honours slot + type rules and ownership; pickup
        // is allowed for either side (the unit standing on the cell takes it).
        if (pack.weapon && this.canEquipGearForPickup(pack.weapon, unit)) {
          this.applyWeaponToUnit(pack.weapon, unit);
          this.lastEvent = tr("{name} подбирает {item} (+{n} урона).", {
            name: this.trName(unit.name), item: this.trName(pack.weapon.name), n: pack.weapon.amount,
          });
          this.createFloatingText(
            "+" + pack.weapon.amount + " ⚔",
            unit.col * CELL_SIZE + CELL_SIZE / 2,
            unit.row * CELL_SIZE + CELL_SIZE / 2 - 12,
            "#ffd700",
            16
          );
          leftoverWeapon = null;
        }
        if (pack.armorGear && this.canEquipGearForPickup(pack.armorGear, unit)) {
          this.applyWeaponToUnit(pack.armorGear, unit);
          this.lastEvent = tr("{name} подбирает {item} (+{n} брони).", {
            name: this.trName(unit.name), item: this.trName(pack.armorGear.name), n: pack.armorGear.amount,
          });
          this.createFloatingText(
            "+" + pack.armorGear.amount + " 🛡",
            unit.col * CELL_SIZE + CELL_SIZE / 2,
            unit.row * CELL_SIZE + CELL_SIZE / 2 - 12,
            "#6495ed",
            16
          );
          leftoverArmor = null;
        }

        if (leftoverWeapon || leftoverArmor) {
          remaining.push({ row: pack.row, col: pack.col, parts: emptyBackpack(), weapon: leftoverWeapon, armorGear: leftoverArmor });
        }
      }
      this.droppedBackpacks = remaining;
    }

    /** Like canEquipWeaponToUnit but ownership-agnostic (pickup is for whoever
     *  steps on the cell, friend or foe — only slot + unit type matter). */
    canEquipGearForPickup(item, unit) {
      if (!item || !unit || !unit.alive()) return false;
      const slot = item.slot === "armor" ? "armor" : "weapon";
      if (slot === "armor" ? unit.armorGear : unit.weapon) return false;
      const allowedTypes = Array.isArray(item.allowedTypes)
        ? item.allowedTypes
        : item.archerOnly
        ? ["archer"]
        : null;
      if (allowedTypes && !allowedTypes.includes(unit.type)) return false;
      if (Array.isArray(item.forbidTypes) && item.forbidTypes.includes(unit.type)) return false;
      return true;
    }

    // ===== Online batch submission ===========================================

    /** Queue a ServerAction for the in-progress turn (online only). */
    recordAction(action) {
      if (!this.online) return;
      this.pendingActions.push(action);
    }

    /** Flush the queued turn to the server as one batch. The authoritative echo
     *  (applyServerState) rebuilds the board for both peers; on failure we
     *  refetch to roll back the optimistic turn. */
    flushTurn() {
      if (!this.online || !this.net) return;
      const batch = this.pendingActions;
      this.pendingActions = [];
      if (!batch.length) return;
      this.turnSubmitting = true;
      this.message = tr("Отправка хода…");
      this.renderSidebar();
      Promise.resolve(this.net.sendBatch(batch))
        .then((ok) => {
          if (ok === false) {
            this.turnSubmitting = false;
            this.message = tr("Не удалось отправить ход. Синхронизация…");
            this.renderSidebar();
            if (this.net && typeof this.net.resync === "function") void this.net.resync();
          }
          // On success the Realtime echo flips the turn and clears turnSubmitting.
        })
        .catch(() => {
          this.turnSubmitting = false;
          if (this.net && typeof this.net.resync === "function") void this.net.resync();
        });
    }

    /** Seeded ruins loot that exactly mirrors the server (mulberry32 at the
     *  shared cursor), so optimistic search results match the authoritative
     *  batch and never desync the turn. */
    rollSeededLoot() {
      const rng = mulberry32(this.rngSeed >>> 0, this.rngCursor >>> 0);
      const weights = RUINS_LOOT_TABLE.map((i) => i.weight);
      const loot = weightedChoiceWith(rng, RUINS_LOOT_TABLE, weights);
      this.rngCursor += 1;
      return loot;
    }

    drawArtifact() {
      if (this.pendingWeaponEquip) {
        this.blockUntilWeaponEquipped();
        return false;
      }
      if (!this.selectedUnit) {
        return false;
      }
      if (this.selectedUnit.movesLeft < 1) {
        return false;
      }
      if (!this.board.inRuins(this.selectedUnit.row, this.selectedUnit.col)) {
        this.message = tr("Юнит должен стоять в руинах.");
        this.renderSidebar();
        return false;
      }
      if (this.online) {
        // Mirror the server's applySearchRuins exactly: seeded loot + the search
        // consumes the unit's whole turn. Keeping the loot deterministic means
        // the optimistic play matches the authoritative batch (no desync).
        this.recordAction({ kind: "search-ruins", unitId: this.selectedUnit.id });
        this.applyOnlineRuinsLoot(this.selectedUnit, this.rollSeededLoot());
        return true;
      }
      const loot = weightedChoiceLegacy(RUINS_LOOT_TABLE);
      this.selectedUnit.movesLeft -= 1;

      if (loot.type === "weapon") {
        const weapon =
          WEAPONS.find((w) => w.name === loot.name) || randomChoice(WEAPONS);
        const targets = this.weaponEquipTargets(weapon);
        if (targets.length > 0) {
          this.queueWeaponEquip(weapon, "Найдено оружие");
          if (this.selectedUnit.movesLeft <= 0) {
            this.selectedUnit.done = true;
            this.selectedUnit.movesLeft = 0;
            this.selectedUnit = null;
            this.clearHighlights();
          } else {
            this.rebuildHighlights();
          }
          this.renderSidebar();
          return true;
        } else {
          this.lastEvent = tr("Найдено оружие, но некому экипировать. Оружие выброшено.");
          this.message = tr("Оружие выброшено.");
        }
      } else if (loot.type === "part") {
        this.selectedUnit.backpack[loot.name] = (this.selectedUnit.backpack[loot.name] || 0) + 1;
        this.lastEvent = tr("Найдена деталь оружия: {name}.", { name: this.trName(loot.name) });
      } else {
        this.lastEvent = tr("В руинах ничего не найдено.");
      }

      if (this.selectedUnit.movesLeft <= 0) {
        this.finishSelectedUnit();
      } else {
        this.rebuildHighlights();
        this.renderSidebar();
      }
      return true;
    }

    /** Apply a (seeded) ruins loot result for an online search, mirroring the
     *  server: artifacts go to inventory, gear queues a pending equip (or is
     *  dropped if no recipient), and the searching unit's turn is consumed. */
    applyOnlineRuinsLoot(unit, loot) {
      if (!unit.activated) {
        unit.activated = true;
        this.activatedCount += 1;
      }
      if (loot.type === "weapon" || loot.type === "armor") {
        const catalogue = loot.type === "armor" ? ARMORS : WEAPONS;
        const gear = catalogue.find((w) => w.name === loot.name);
        const targets = gear ? this.weaponEquipTargets(gear) : [];
        // Search consumes the unit regardless of the equip outcome.
        unit.movesLeft = 0;
        unit.done = true;
        if (gear && targets.length > 0) {
          this.selectedUnit = null;
          this.clearHighlights();
          this.queueWeaponEquip(gear, loot.type === "armor" ? "Найдена броня" : "Найдено оружие");
          return;
        }
        this.lastEvent = tr("{label}, но некому экипировать. Выброшено.", {
          label: tr(loot.type === "armor" ? "Найдена броня" : "Найдено оружие"),
        });
      } else if (loot.type === "part") {
        unit.backpack[loot.name] = (unit.backpack[loot.name] || 0) + 1;
        this.lastEvent = tr("Найдена деталь оружия: {name}.", { name: this.trName(loot.name) });
        unit.movesLeft = 0;
        unit.done = true;
      } else {
        this.lastEvent = tr("В руинах ничего не найдено.");
        unit.movesLeft = 0;
        unit.done = true;
      }
      this.finishSelectedUnit();
    }

    craftWeapon(index) {
      if (this.pendingWeaponEquip) {
        this.blockUntilWeaponEquipped();
        return false;
      }
      if (!this.selectedUnit || this.winner !== null) {
        return false;
      }
      if (this.selectedUnit.movesLeft < 1) {
        return false;
      }

      const recipe = WEAPONS[index];
      if (!recipe) {
        return false;
      }

      const inv = this.selectedUnit.backpack;
      if (!this.canAfford(inv, recipe.recipe)) {
        this.message = tr("Недостаточно деталей для крафта.");
        this.renderSidebar();
        return false;
      }

      if (this.online) {
        // Deterministic — queue for the batch and craft locally below.
        this.recordAction({ kind: "craft", unitId: this.selectedUnit.id, index });
      }

      // Воспроизводим анимацию слияния деталей
      const craftButton = document.getElementById('craft-btn-' + index);
      if (craftButton) {
        this.playArtifactMergeAnimation(recipe.recipe, craftButton);
      }

      this.spend(inv, recipe.recipe);
      this.selectedUnit.movesLeft -= 1;

      // The crafter gets the weapon by default when it's able to wear it;
      // otherwise it's offered to any eligible ally, same as looted gear.
      if (this.canEquipWeaponToUnit(recipe, this.selectedUnit)) {
        this.applyWeaponToUnit(recipe, this.selectedUnit);
        this.lastEvent = tr("Скрафчено: {name} (+{n} урона).", { name: this.trName(recipe.name), n: recipe.amount });
        if (this.selectedUnit.movesLeft <= 0) {
          this.finishSelectedUnit();
        } else {
          this.rebuildHighlights();
          this.renderSidebar();
        }
        return true;
      }

      // Bug fix: same as found gear — the crafter can't carry an item it
      // can't wear (no separate "unworn inventory" slot), so this used to
      // force the blocking "Обязательная экипировка" picker onto the
      // sidebar just because SOME other ally on the board could wear it.
      // Drop it on the crafter's cell as ordinary loot instead; anyone who
      // wants it can walk over and pick it up.
      this.pushDroppedGear("weapon", recipe, this.selectedUnit.row, this.selectedUnit.col);
      this.lastEvent = tr("Скрафчено: {name}, но {crafter} не может его носить. Оставлено на земле.", {
        name: this.trName(recipe.name),
        crafter: this.trName(this.selectedUnit.name),
      });
      this.message = tr("Оружие оставлено на земле.");
      if (this.selectedUnit.movesLeft <= 0) {
        this.finishSelectedUnit();
      } else {
        this.rebuildHighlights();
        this.renderSidebar();
      }
      return true;
    }

    craftArmor(index) {
      if (this.pendingWeaponEquip) {
        this.blockUntilWeaponEquipped();
        return false;
      }
      if (!this.selectedUnit || this.winner !== null) {
        return false;
      }
      if (this.selectedUnit.movesLeft < 1) {
        return false;
      }

      const recipe = ARMORS[index];
      if (!recipe) {
        return false;
      }

      const inv = this.selectedUnit.backpack;
      if (!this.canAfford(inv, recipe.recipe)) {
        this.message = tr("Недостаточно деталей для крафта брони.");
        this.renderSidebar();
        return false;
      }

      if (this.online) {
        this.recordAction({ kind: "craft-armor", unitId: this.selectedUnit.id, index });
      }

      const craftButton = document.getElementById('armor-btn-' + index);
      if (craftButton) {
        this.playArtifactMergeAnimation(recipe.recipe, craftButton);
      }

      this.spend(inv, recipe.recipe);
      this.selectedUnit.movesLeft -= 1;

      // The crafter gets the armour by default when it's able to wear it;
      // otherwise it's offered to any eligible ally, same as looted gear.
      if (this.canEquipWeaponToUnit(recipe, this.selectedUnit)) {
        this.applyWeaponToUnit(recipe, this.selectedUnit);
        this.lastEvent = tr("Скрафчено: {name} (+{n} брони).", { name: this.trName(recipe.name), n: recipe.amount });
        if (this.selectedUnit.movesLeft <= 0) {
          this.finishSelectedUnit();
        } else {
          this.rebuildHighlights();
          this.renderSidebar();
        }
        return true;
      }

      // Bug fix: same as craftWeapon — no forced picker, just drop it.
      this.pushDroppedGear("armor", recipe, this.selectedUnit.row, this.selectedUnit.col);
      this.lastEvent = tr("Скрафчено: {name}, но {crafter} не может её носить. Оставлено на земле.", {
        name: this.trName(recipe.name),
        crafter: this.trName(this.selectedUnit.name),
      });
      this.message = tr("Броня оставлена на земле.");
      if (this.selectedUnit.movesLeft <= 0) {
        this.finishSelectedUnit();
      } else {
        this.rebuildHighlights();
        this.renderSidebar();
      }
      return true;
    }

    showSurrenderModal() {
      const modal = document.getElementById('surrenderModal');
      if (!modal) return;
      modal.classList.add('active');
      document.getElementById('surrenderYesBtn').onclick = () => {
        modal.classList.remove('active');
        this.surrender();
      };
      document.getElementById('surrenderNoBtn').onclick = () => {
        modal.classList.remove('active');
      };
    }

    surrender() {
      if (this.screen !== "game" || this.winner !== null) {
        return;
      }
      if (this.online) {
        // Resign is allowed regardless of whose turn it is — bypass sendOnline's
        // turn check and let the server decide the winner.
        if (this.net) this.net.send({ kind: "resign", player: this.myPlayer });
        return;
      }
      this.winner = otherPlayer(this.currentPlayer);
      this.sessionWins[this.winner]++;
      this.message = tr("Игрок {p} сдался.", { p: this.currentPlayer });
      this.lastEvent = tr("Победа игрока {p}.", { p: this.winner });
      this.selectedUnit = null;
      this.clearHighlights();
      this.clearSave();
      this.renderSidebar();
    }

    isUnitInEnemyCastle(unit) {
      if (!unit) return false;
      const enemyPlayer = unit.player === 1 ? 2 : 1;
      const enemyCastleCol = enemyPlayer === 1 ? getCastleP1Col() : getCastleP2Col();
      const enemyCastleRow = enemyPlayer === 1
        ? (this.player1Bottom ? 16 : 0)
        : (this.player1Bottom ? 0 : 16);
      return unit.row >= enemyCastleRow && unit.row < enemyCastleRow + 4 &&
             unit.col >= enemyCastleCol && unit.col < enemyCastleCol + 4;
    }

    checkWinner() {
      // Победа: занять пустой замок противника (нет его юнитов в его зоне)
      const p1InEnemy = this.board.units.some((u) => u.player === 1 && u.alive() && this.isUnitInEnemyCastle(u));
      const p2InOwnCastle = this.board.units.some((u) => u.player === 2 && u.alive() && this.isUnitInOwnCastle(u));
      if (p1InEnemy && !p2InOwnCastle) {
        this.winner = 1;
        this.sessionWins[1]++;
        this.message = tr("Победа игрока 1! Замок захвачен!");
        this.clearSave();
        if (this.currentStoryTask) {
          this.markStoryTaskDone(this.currentStoryTask.ci, this.currentStoryTask.gi, this.currentStoryTask.ti);
          this.currentStoryTask = null;
        }
        return;
      }
      const p2InEnemy = this.board.units.some((u) => u.player === 2 && u.alive() && this.isUnitInEnemyCastle(u));
      const p1InOwnCastle = this.board.units.some((u) => u.player === 1 && u.alive() && this.isUnitInOwnCastle(u));
      if (p2InEnemy && !p1InOwnCastle) {
        this.winner = 2;
        this.sessionWins[2]++;
        this.message = tr("Победа игрока 2! Замок захвачен!");
        this.clearSave();
      }
    }

    // Google sign-in via the native macOS wrapper (ASWebAuthenticationSession).
    // The Swift side runs the OAuth round-trip, hands Supabase tokens back, and
    // api.signInWithGoogle() establishes the session — then we update auth state
    // exactly like the email login path does (see submitAuth).
    async startGoogleSignin() {
      const errEl = document.getElementById('authError');
      if (errEl) errEl.textContent = '';
      try {
        const { accessToken, user } = await this.api.signInWithGoogle();
        this.authAccessToken = accessToken;
        this.authUser = user;
        this.api.setAccessToken(accessToken);
        this.saveAuthUserCache(user);
        this.message = tr('Добро пожаловать, {name}!', { name: user.displayName || tr('игрок') });
        this.hideAccountModal();
        this.refreshAccountUI();
        this.syncProgressFromServer();
      } catch (err) {
        const msg = err && err.message ? err.message : tr('Не удалось войти через Google.');
        if (errEl) errEl.textContent = msg;
        else this.message = msg;
      }
    }

    signout() {
      this.authUser = null;
      this.authAccessToken = null;
      this.api.setAccessToken(null);
      this.clearAuthUserCache();
      // Fire-and-forget — server clears the refresh cookie.
      fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
      this.message = tr('Вы вышли из аккаунта.');
      // Reflect the change everywhere that's on screen right now.
      this.refreshAccountUI();
    }

    /**
     * Re-render every account-dependent surface that is currently visible so a
     * login/logout shows immediately without reopening anything: the menu, the
     * settings sub-modal account bar, and the auth modal panels (login ⇄ account).
     */
    refreshAccountUI() {
      if (document.getElementById('menuOverlay')?.classList.contains('active')) {
        this.renderNewMenu();
      }
      const settings = document.getElementById('settingsModal');
      if (settings && settings.classList.contains('active')) {
        const sb = document.getElementById('settingsModalBody');
        if (sb) sb.innerHTML = this._buildSettingsModalHTML();
      }
      const authModal = document.getElementById('authModal');
      if (authModal && authModal.classList.contains('active')) {
        // showAccountModal() re-evaluates authUser and swaps login/account panels.
        this.showAccountModal();
      }
    }

    bindAuthMessageHandler() {
      if (this._authHandlerBound) return;
      this._authHandlerBound = true;
      window.addEventListener('message', (event) => {
        // Same-origin check: the popup is served from the same domain in prod
        // (kc.agatha-mistery.com), so event.origin must match location.origin.
        if (event.origin !== window.location.origin) return;
        const data = event.data;
        if (!data || data.type !== 'kc-oauth') return;
        if (typeof data.accessToken !== 'string' || !data.user) return;
        this.authAccessToken = data.accessToken;
        this.authUser = data.user;
        this.api.setAccessToken(data.accessToken);
        this.saveAuthUserCache(data.user);
        this.message = tr('Добро пожаловать, {name}!', { name: data.user.displayName || tr('игрок') });
        this.hideAccountModal();
        this.refreshAccountUI();
        this.syncProgressFromServer();
      });
    }

    markStoryTaskDone(ci, gi, ti) {
      const progress = this.loadProgress();
      while (progress.chapters.length <= ci) progress.chapters.push({ games: [] });
      const chP = progress.chapters[ci];
      if (!chP.games) chP.games = [];
      while (chP.games.length <= gi) chP.games.push({ tasks: [] });
      const gP = chP.games[gi];
      if (!gP.tasks) gP.tasks = [];
      while (gP.tasks.length <= ti) gP.tasks.push(false);
      const wasNew = !gP.tasks[ti];
      gP.tasks[ti] = true;
      this.saveProgress(progress);

      // Anim #14: star pop — briefly add .pop to the newly completed star element
      if (wasNew) {
        const starEl = document.querySelector(
          `.chain-star[data-chapter="${ci}"][data-game="${gi}"][data-task="${ti}"]`
        );
        if (starEl) {
          starEl.classList.add('pop');
          setTimeout(() => starEl.classList.remove('pop'), 700);
        }
      }
    }

    findNextStoryTask() {
      const progress = this.loadProgress();
      for (let ci = 0; ci < STORY_CHAPTERS.length; ci++) {
        const ch = STORY_CHAPTERS[ci];
        const chP = (progress.chapters && progress.chapters[ci]) || { games: [] };
        for (let gi = 0; gi < ch.games.length; gi++) {
          const g = ch.games[gi];
          const gP = (chP.games && chP.games[gi]) || { tasks: [] };
          for (let ti = 0; ti < g.tasks.length; ti++) {
            if (!gP.tasks || !gP.tasks[ti]) {
              return { ci, gi, ti, task: g.tasks[ti] };
            }
          }
        }
      }
      return null; // все задания пройдены
    }

    // ✅ iOS FIX: Метод для запуска конкретного уровня из дерева прогресса
    startStoryLevel(ci, gi, ti) {
      if (ci < 0 || ci >= STORY_CHAPTERS.length) return;
      const ch = STORY_CHAPTERS[ci];
      if (!ch || gi < 0 || gi >= ch.games.length) return;
      const g = ch.games[gi];
      if (!g || ti < 0 || ti >= g.tasks.length) return;
      const task = g.tasks[ti];

      this.requestFullscreenIfNeeded();
      this.startMatch('ai', null, { ci, gi, ti, task });
    }

    // ===== Item transfer (free, 0 moves, adjacent allies only) ===============
    // Any two of your own units standing next to each other (Chebyshev
    // distance 1) can hand parts and/or a carried weapon/armour piece back
    // and forth at any time — costs neither side a move.

    /** This player's own OTHER living units standing Chebyshev-adjacent to `unit`. */
    adjacentAllies(unit) {
      if (!unit) return [];
      return this.ownUnits(unit.player).filter((o) => {
        if (o.id === unit.id || !o.alive()) return false;
        return Math.max(Math.abs(o.row - unit.row), Math.abs(o.col - unit.col)) <= 1;
      });
    }

    renderTransferPanel(unit) {
      const allies = this.adjacentAllies(unit);
      if (allies.length === 0) {
        this.transferOpenUnitId = null;
        return "";
      }

      let html = '<hr class="sep" />';
      html += '<div class="section transfer-panel">';
      html += '<h3>' + tr('Передать предметы') + '</h3>';

      if (this.transferOpenUnitId !== unit.id) {
        html += '<div class="line">' + tr('Рядом есть союзники — можно передать им детали или снаряжение.') + '</div>';
        html += '<button class="btn secondary" data-action="transfer-open" data-unit-id="' + unit.id + '">'
          + tr('Открыть передачу') + '</button>';
        html += "</div>";
        return html;
      }

      const sel = this.transferSelection || {};

      html += '<div class="line" style="font-weight:bold;margin-bottom:4px">' + tr('1. Отметьте предметы для передачи:') + '</div>';
      html += '<div class="transfer-items-row" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">';
      let hasItems = false;
      PARTS.forEach((p) => {
        const have = unit.backpack[p] || 0;
        if (have <= 0) return;
        hasItems = true;
        const checked = !!sel['part:' + p];
        const color = PART_COLORS[p];
        html += '<button class="btn transfer-chip' + (checked ? ' primary' : ' secondary') + '" style="border-color:' + color + '" '
          + 'data-action="transfer-toggle" data-kind="part" data-part="' + this.escape(p) + '">'
          + (checked ? '✓ ' : '') + this.escape(this.trName(p)) + ' (' + have + ')'
          + '</button>';
      });
      if (unit.weapon) {
        hasItems = true;
        const checked = !!sel.weapon;
        html += '<button class="btn transfer-chip' + (checked ? ' primary' : ' secondary') + '" '
          + 'data-action="transfer-toggle" data-kind="weapon">'
          + (checked ? '✓ ' : '') + '⚔ ' + this.escape(this.trName(unit.weapon.name))
          + '</button>';
      }
      if (unit.armorGear) {
        hasItems = true;
        const checked = !!sel.armor;
        html += '<button class="btn transfer-chip' + (checked ? ' primary' : ' secondary') + '" '
          + 'data-action="transfer-toggle" data-kind="armor">'
          + (checked ? '✓ ' : '') + '🛡 ' + this.escape(this.trName(unit.armorGear.name))
          + '</button>';
      }
      if (!hasItems) {
        html += '<div class="line text-muted" style="font-size:12px">' + tr('У этого юнита нет предметов в инвентаре.') + '</div>';
      }
      html += "</div>";

      // Target is picked by clicking the ally ON THE MAP (transferOpenUnitId
      // branch in the canvas click handler sets transferTargetId there) — the
      // button-list duplicate was removed. "Отдать" stays the one explicit
      // action that commits the transfer.
      const target = this.transferTargetId != null ? allies.find((a) => a.id === this.transferTargetId) : null;
      const hasSelection = PARTS.some((p) => sel['part:' + p]) || sel.weapon || sel.armor;

      if (target) {
        html += '<div class="line" style="color:#40e0a0;margin-bottom:6px">✓ ' + tr('Выбран получатель:') + ' <strong>' + this.escape(this.trName(target.name)) + '</strong></div>';
        html += '<button class="btn primary" data-action="transfer-confirm" ' + (hasSelection ? '' : 'disabled') + '>'
          + tr('Отдать') + ' (' + this.escape(this.trName(target.name)) + ')</button> ';
      } else {
        html += '<div class="line text-muted" style="font-size:12px;margin-bottom:6px">' + tr('💡 Кликните по союзнику на карте, чтобы выбрать получателя.') + '</div>';
      }
      html += '<button class="btn secondary" data-action="transfer-cancel">' + tr('Закрыть') + '</button>';
      html += "</div>";
      return html;
    }

    /** Toggle one item in/out of the pending transfer selection — this never
     * spends a move; only the final "Отдать" click does (and even that is
     * itself free, see applyTransferItems). */
    toggleTransferSelection(kind, part) {
      if (!this.transferSelection) this.transferSelection = {};
      const key = kind === "part" ? "part:" + part : kind;
      this.transferSelection[key] = !this.transferSelection[key];
    }

    /** Apply the pending transfer to the currently open unit → target pair. */
    confirmTransfer() {
      const from = this.selectedUnit;
      if (!from || this.transferTargetId == null) return false;
      const to = this.board.units.find((u) => u.id === this.transferTargetId && u.alive());
      if (!to) return false;
      const sel = this.transferSelection || {};
      const parts = {};
      let anyParts = false;
      PARTS.forEach((p) => {
        if (sel["part:" + p] && (from.backpack[p] || 0) > 0) {
          parts[p] = from.backpack[p];
          anyParts = true;
        }
      });
      // Bug fix: this used to only check the receiving slot was free
      // (!to.weapon / !to.armorGear), never whether that unit TYPE can
      // legally wear the item — a bow handed to a knight silently "worked"
      // client-side even though the server (apply.ts's canEquipGear) already
      // rejected it. Same allowedTypes/forbidTypes check the pickup path uses.
      const wantsWeapon = !!sel.weapon && !!from.weapon && this.canEquipGearForPickup(from.weapon, to);
      const wantsArmor = !!sel.armor && !!from.armorGear && this.canEquipGearForPickup({ ...from.armorGear, slot: 'armor' }, to);
      if (!anyParts && !wantsWeapon && !wantsArmor) return false;

      if (this.online) {
        this.recordAction({
          kind: "transfer-items",
          fromUnitId: from.id,
          toUnitId: to.id,
          parts: anyParts ? parts : undefined,
          weapon: wantsWeapon || undefined,
          armor: wantsArmor || undefined,
        });
      }

      if (anyParts) {
        PARTS.forEach((p) => {
          if (!parts[p]) return;
          from.backpack[p] -= parts[p];
          to.backpack[p] = (to.backpack[p] || 0) + parts[p];
        });
      }
      if (wantsWeapon) {
        to.damage += from.weapon.amount;
        to.weapon = from.weapon;
        from.damage -= from.weapon.amount;
        from.weapon = null;
      }
      if (wantsArmor) {
        to.armor += from.armorGear.amount;
        to.maxArmor += from.armorGear.amount;
        to.armorGear = from.armorGear;
        from.armor = Math.max(0, from.armor - from.armorGear.amount);
        from.maxArmor = Math.max(0, from.maxArmor - from.armorGear.amount);
        from.armorGear = null;
      }
      this.lastEvent = tr("{from} передаёт предметы юниту {to}.", {
        from: this.trName(from.name),
        to: this.trName(to.name),
      });
      this.transferSelection = {};
      this.renderSidebar();
      return true;
    }

    renderSidebar() {
      if (this.screen === "menu") {
        this.sidebar.innerHTML = '';
        this.renderNewMenu();
        document.getElementById('gameHud')?.classList.remove('visible');
        this.applyResponsiveCanvasSize();
        this.renderVictoryOverlay();
        return;
      }

      const p1Count = this.ownUnits(1).length;
      const p2Count = this.ownUnits(2).length;
      const playerClass = this.currentPlayer === 1 ? "player-p1" : "player-p2";
      // The panel shows the SELECTED unit's own backpack — there's no shared
      // per-player inventory any more (see [[per-unit-backpack]]).
      const inv = this.selectedUnit ? this.selectedUnit.backpack : emptyBackpack();
      const activationLeft = Math.max(0, this.maxActivatedPerTurn - this.activatedCount);
      const waitingWeaponEquip = !!this.pendingWeaponEquip;

      let html = "";
      if (this.tutorialMode) {
        const tutStep = this.tutorialStep;
        html += '<div class="tut-card" style="margin-bottom:10px">';
        html += '<div class="tut-step">🎓 ' + tr('Обучение — шаг {n} / 5', { n: Math.min(tutStep + 1, 5) }) + '</div>';
        html += '<div class="tut-text">' + this.escape(this._tutorialGetText()) + '</div>';
        if (tutStep >= 5) {
          html += '<button class="btn primary" data-action="finish-tutorial" style="margin-top:10px;width:100%">' + tr('Завершить обучение') + '</button>';
        }
        html += '</div>';
      }
      html += '<div class="player-label ' + playerClass + '">' + tr('Игрок {p}', { p: this.currentPlayer }) + '</div>';

      // Anim #15: AI thinking indicator — with a real progress bar when the AI
      // is mid-search (time-sliced MCTS reports ai.thinkProgress 0..1).
      if (this.mode === 'ai' && this.currentPlayer === 2) {
        const prog = this.ai ? this.ai.thinkProgress : null;
        if (prog !== null && prog !== undefined) {
          const pct = Math.round(prog * 100);
          html += '<div class="ai-thinking">' + tr('ИИ думает') + ' ' + pct + '%' +
            '<div class="ai-think-bar"><div class="ai-think-bar-fill" style="width:' + pct + '%"></div></div>' +
            '</div>';
        } else {
          html += '<div class="ai-thinking"><span class="ai-thinking-dots"><span>.</span><span>.</span><span>.</span></span> ' + tr('ИИ думает') + '</div>';
        }
      }

      // Radical-minimal HUD: a single compact icon line replaces the former
      // score / mode / activations text lines. Message shown only when set.
      if (this.message) {
        html += '<div class="message">' + this.escape(this.message) + '</div>';
      }
      html += '<div class="line">⚡ ' + activationLeft + '&nbsp;&nbsp;·&nbsp;&nbsp;' +
        '<span style="color:var(--p1)">' + p1Count + '</span> ⚔ ' +
        '<span style="color:var(--p2)">' + p2Count + '</span></div>';
      // Primary controls as a compact wrapped row (thumb-friendly, board-first
      // on mobile). data-action strings are unchanged (e2e contract).
      // Icon-only control row (board-first, minimal text). aria-label keeps each
      // action accessible; data-action strings are unchanged (e2e contract).
      html += '<div class="sidebar-actions">';
      html +=
        '<button class="btn secondary" data-action="back-menu" aria-label="' + tr('В меню') + '" title="' + tr('В меню') + '" ' +
        (waitingWeaponEquip ? "disabled" : "") +
        ">🏠</button>";

      // P0: in-turn undo button — shown on the human's turn once an action is recorded.
      const humanTurn = !(this.mode === "ai" && this.currentPlayer === 2);
      if (this.undoStack.length > 0 && humanTurn && !waitingWeaponEquip) {
        html += '<button class="btn" data-action="undo" aria-label="' + tr('Отменить') + '" title="' + tr('Отменить') + '">↶</button>';
      }
      if (humanTurn && !waitingWeaponEquip && this.winner === null) {
        html += '<button class="btn" data-action="end-turn" aria-label="' + tr('Пропустить ход') + '" title="' + tr('Пропустить ход') + '">⏭</button>';
      }
      // Threat-zone toggle removed: tapping any unit (including an enemy) now
      // shows its reach directly, which covers the same need without a button.
      html += "</div>";

      // The old flat shieldTurns badge is gone: ward is per-unit now (see
      // [[kc-mage-ward-mechanic]]) and shown as a 🛡️ badge on the warded
      // unit itself, drawn on the board — see drawWardBadges.

      if (this.lastEvent) {
        html += '<div class="card"><div class="hint">' + this.escape(this.lastEvent) + '</div></div>';
      }

      if (this.pendingAttackChoice) {
        html += '<hr class="sep" />';
        html += '<div class="section">';
        html += '<h3>' + tr('Выберите цель') + '</h3>';
        html += '<div class="line">' + tr('На этой клетке можно атаковать двух разных врагов. Нажмите на нужного.') + '</div>';
        html += '<div class="hint">' + tr('Клик мимо отменяет выбор.') + '</div>';
        html += "</div>";
      }

      if (waitingWeaponEquip && this.pendingWeaponEquip) {
        const pending = this.pendingWeaponEquip;
        const targets = this.weaponEquipTargets(pending);
        html += '<hr class="sep" />';
        html += '<div class="section">';
        html += '<h3>' + tr('Обязательная экипировка') + '</h3>';
        html +=
          '<div class="line">' +
          tr('Выберите союзника для {name} (+{n} {unit}).', {
            name: this.escape(this.trName(pending.name)),
            n: pending.amount,
            unit: pending.slot === 'armor' ? tr('брони') : tr('урона'),
          }) +
          '</div>';
        html += '<div class="hint">' + tr('Выбор только на поле.') + '</div>';
        if (!targets.length) {
          html += '<div class="line">' + tr('Подходящих юнитов нет.') + '</div>';
        } else {
          html += '<div class="line">' + tr('Подсвеченные юниты готовы принять предмет.') + '</div>';
        }
        html += "</div>";
      }

      // Backpack: the selected unit's own parts, as compact icon+count chips.
      const ownedParts = PARTS.filter((name) => (inv[name] || 0) > 0);
      if (ownedParts.length) {
        html += '<hr class="sep" />';
        html += '<div class="section" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">';
        ownedParts.forEach((name) => {
          const count = inv[name] || 0;
          const color = PART_COLORS[name];
          const imgKey = PART_IMAGES[name];
          const imgSrc = imgKey && this.assets.get(imgKey) ? this.assets.get(imgKey).src : '';
          html += '<span class="inventory-row has" style="color:' + color + '" title="' + this.escape(this.trName(name)) + '">';
          if (imgSrc) {
            html += '<img src="' + imgSrc + '" class="artifact-icon" alt="' + this.escape(name) + '">';
          }
          html += '<span>' + count + '</span>';
          html += '</span>';
        });
        html += "</div>";
      }

      // Catapult siege ammo: offer the boulder throw while a catapult is selected.
      if (
        this.selectedUnit &&
        this.selectedUnit.type === "catapult" &&
        this.selectedUnit.movesLeft >= 1 &&
        this.selectedUnit.player === this.currentPlayer
      ) {
        const aiming = !!this.rockMode;
        html += '<button class="btn' + (aiming ? ' primary' : '') + '" data-action="throw-rock" style="width:100%;margin-top:6px">'
          + (aiming ? '✖ ' + tr('Отменить бросок') : '🪨 ' + tr('Бросить камень'))
          + '</button>';
      }

      // Knight construction buttons (tower / bridge): require 2 AP
      if (
        this.selectedUnit &&
        this.selectedUnit.type === "knight" &&
        this.selectedUnit.movesLeft >= 2 &&
        this.selectedUnit.player === this.currentPlayer
      ) {
        const aimingTower = this.buildMode === 'tower';
        const aimingBridge = this.buildMode === 'bridge';
        html += '<button class="btn' + (aimingTower ? ' primary' : '') + '" data-action="build-tower-mode" style="width:100%;margin-top:6px">'
          + (aimingTower ? '✖ ' + tr('Отменить постройку башни') : '🛕 ' + tr('Построить башню (2 хода)'))
          + '</button>';
        html += '<button class="btn' + (aimingBridge ? ' primary' : '') + '" data-action="build-bridge-mode" style="width:100%;margin-top:6px">'
          + (aimingBridge ? '✖ ' + tr('Отменить постройку моста') : '🌉 ' + tr('Построить мост (2 хода)'))
          + '</button>';
      }

      const previewUnit = this.getPreviewUnit();
      if (previewUnit) {
        html += '<hr class="sep" />';
        html += '<div class="section preview">';
        html += '<h3>' + tr('Превью юнита') + '</h3>';
        html += '<canvas id="previewSprite" width="144" height="144"></canvas>';
        html +=
          '<div class="preview-title">' +
          this.escape(this.trName(previewUnit.name)) +
          ' <span class="tag" style="color:' +
          (previewUnit.player === 1 ? COLORS.p1 : COLORS.p2) +
          '">' + tr('Игрок {p}', { p: previewUnit.player }) +
          "</span></div>";
        html +=
          '<div class="kv">HP: ' +
          previewUnit.hp +
          '/' +
          previewUnit.maxHp +
          ' | Armor: ' +
          previewUnit.armor +
          ' | Damage: ' +
          previewUnit.damage +
          ' | Moves: ' +
          previewUnit.movesLeft +
          '/' +
          previewUnit.maxMoves +
          "</div>";
        if (previewUnit.weapon) {
          html +=
            '<div class="kv" style="color:#ffd86b">' +
            this._weaponEmoji(previewUnit.weapon.icon) +
            ' ' +
            this.escape(this.trName(previewUnit.weapon.name)) +
            ' (+' +
            (previewUnit.weapon.amount || 0) +
            ' ' + tr('к урону') + ')</div>';
        }
        // Armour was missing here entirely: a unit could pick up mail or plate
        // and the preview would never mention it, so the armour number looked
        // like it changed for no reason.
        if (previewUnit.armorGear) {
          html +=
            '<div class="kv" style="color:#8ab6ff">' +
            this._weaponEmoji(previewUnit.armorGear.icon) +
            ' ' +
            this.escape(this.trName(previewUnit.armorGear.name)) +
            ' (+' +
            (previewUnit.armorGear.amount || 0) +
            ' ' + tr('к броне') + ')</div>';
        }
        html += '<button class="btn" data-action="clear-preview">' + tr('Закрыть превью') + '</button>';
        html += "</div>";
      }

      if (this.selectedUnit && this.selectedUnit.player === this.currentPlayer && this.winner === null) {
        const u = this.selectedUnit;
        html += '<hr class="sep" />';
        html += '<div class="section unit-card">';
        html += '<h3>' + tr('Выбранный юнит') + '</h3>';
        html +=
          '<div class="line">' +
          this.escape(this.trName(u.name)) +
          ' | HP ' +
          u.hp +
          '/' +
          u.maxHp +
          ' | Armor ' +
          u.armor +
          ' | DMG ' +
          u.damage +
          ' | ' + tr('Ходы') + ' ' +
          u.movesLeft +
          '/' +
          u.maxMoves +
          "</div>";

        if (u.weapon) {
          html +=
            '<div class="line" style="color:#ffd86b">' +
            this._weaponEmoji(u.weapon.icon) +
            ' ' +
            this.escape(this.trName(u.weapon.name)) +
            ' (+' +
            (u.weapon.amount || 0) +
            ' ' + tr('к урону') + ')</div>';
        }
        // Same omission as the preview panel: equipped armour was never listed.
        if (u.armorGear) {
          html +=
            '<div class="line" style="color:#8ab6ff">' +
            this._weaponEmoji(u.armorGear.icon) +
            ' ' +
            this.escape(this.trName(u.armorGear.name)) +
            ' (+' +
            (u.armorGear.amount || 0) +
            ' ' + tr('к броне') + ')</div>';
        }

        html += this.renderTransferPanel(u);

        // Castle healing button — any own unit standing in its own castle with at
        // least one move left can heal to full (ends its turn). Previously this was
        // knight-only and required full moves (movesLeft>=2), so a unit that walked
        // into the castle could never heal — fixed.
        if (this.isUnitInOwnCastle(u) && u.movesLeft >= 1 &&
            (u.hp < u.maxHp || u.armor < u.maxArmor)) {
          const hpGain = u.maxHp - u.hp;
          const armorGain = u.maxArmor - u.armor;
          const healLabel = [
            hpGain > 0 ? '+' + hpGain + ' ❤️' : '',
            armorGain > 0 ? '+' + armorGain + ' 🛡' : '',
          ].filter(Boolean).join('  ');
          html += '<div class="card" style="background: rgba(100, 149, 237, 0.15); border: 2px solid #6495ed; margin-top: 8px;">';
          html += '<div class="hint">' + tr('Юнит в замке — восстановление до максимума (заканчивает ход)') + '</div>';
          html += '<button class="btn" data-action="castle-heal">' +
            '🏰 ' + tr('Лечиться в замке') + ' (' + healLabel + ')' +
            '</button>';
          html += '</div>';
        }

        if (this.board.inRuins(u.row, u.col) && u.movesLeft > 0) {
          html +=
            '<button class="btn secondary" data-action="draw-part" ' +
            (waitingWeaponEquip ? "disabled" : "") +
            '>' + tr('Искать детали') + '</button>';
        }

        // Common spells (Дождь защиты/Сталь свободы/Небо огня, cast from a mage
        // tower) were removed from the game entirely — only the mage's own 4
        // abilities exist now, rendered below.
        if (u.type === "mage" && u.movesLeft >= 1 && !waitingWeaponEquip) {
          html += this.renderMagePanel(u);
        }

        html += '<h3>' + tr('Крафт оружия') + '</h3>';
        WEAPONS.forEach((w, idx) => {
          const canRecipe = this.canAfford(u.backpack, w.recipe);
          const can = canRecipe && !waitingWeaponEquip;
          const iconKey = w.icon;
          const iconSrc = iconKey && this.assets.get(iconKey) ? this.assets.get(iconKey).src : "";
          html +=
            '<button class="btn" id="craft-btn-' + idx + '" data-action="craft" data-idx="' +
            idx +
            '" ' +
            (can ? "" : "disabled") +
            '>' +
            '<div class="weapon-header">' +
            (iconSrc ? '<img src="' + iconSrc + '" class="weapon-icon" alt="' + this.escape(this.trName(w.name)) + '">' : "") +
            '<span class="weapon-title">' +
            this.escape(this.trName(w.name)) +
            '</span>' +
            "</div>" +
            '<div class="recipe">' +
            this.escape(cloneRecipeText(w.recipe)) +
            "</div></button>";
        });

        html += '<h3>' + tr('Крафт брони') + '</h3>';
        ARMORS.forEach((a, idx) => {
          const canRecipe = this.canAfford(u.backpack, a.recipe);
          const can = canRecipe && !waitingWeaponEquip;
          const iconKey = a.icon;
          const iconSrc = iconKey && this.assets.get(iconKey) ? this.assets.get(iconKey).src : "";
          html +=
            '<button class="btn" id="armor-btn-' + idx + '" data-action="craft-armor" data-idx="' +
            idx +
            '" ' +
            (can ? "" : "disabled") +
            '>' +
            '<div class="weapon-header">' +
            (iconSrc ? '<img src="' + iconSrc + '" class="weapon-icon" alt="' + this.escape(this.trName(a.name)) + '">' : "") +
            '<span class="weapon-title">' +
            this.escape(this.trName(a.name)) +
            '</span>' +
            "</div>" +
            '<div class="recipe">' +
            this.escape(cloneRecipeText(a.recipe)) +
            "</div></button>";
        });

        html += "</div>";
      }

      html += '<hr class="sep" />';
      html +=
        '<button class="btn danger" data-action="surrender" aria-label="' + tr('Сдаться') + '" title="' + tr('Сдаться') + '" ' +
        (this.winner === null && !waitingWeaponEquip ? "" : "disabled") +
        '>🏳️ ' + tr('Сдаться') + '</button>';

      this.sidebar.innerHTML = html;
      this.paintPreviewSprite();
      this.applyResponsiveCanvasSize();
      this.queueSaveProgress();
      this.renderVictoryOverlay();

      // HUD overlay (visible when sidebar is hidden on very small screens)
      const hud = document.getElementById('gameHud');
      const hudPlayer = document.getElementById('hudPlayer');
      const hudAct = document.getElementById('hudActivations');
      const hudUnits = document.getElementById('hudUnits');
      if (hud && hudPlayer && hudAct) {
        hudPlayer.textContent = tr('Игрок {p}', { p: this.currentPlayer });
        hudPlayer.className = 'hud-chip ' + (this.currentPlayer === 1 ? 'p1' : 'p2');
        hudAct.textContent = '⚡ ' + activationLeft + '  ' + tr('Ход {n}', { n: this.turnNumber });
        if (hudUnits) {
          const u1 = this.ownUnits(1).length;
          const u2 = this.ownUnits(2).length;
          hudUnits.textContent = u1 + ' ⚔ ' + u2;
        }
        hud.classList.add('visible');
      }

      this._updateA11yStatus(activationLeft);
    }

    // a11y: mirror the live game state into the aria-live region so screen
    // readers hear whose turn it is, key messages, and the result.
    _updateA11yStatus(activationLeft) {
      const el = document.getElementById('a11yStatus');
      if (!el) return;
      let text;
      if (this.winner) {
        text = this.online
          ? (this.winner === this.myPlayer ? tr('Победа. Вы победили.') : tr('Поражение.'))
          : tr('Победа. Победил игрок {p}.', { p: this.winner });
      } else {
        text = tr('Ход игрока {p}. Осталось активаций: {n}.', { p: this.currentPlayer, n: activationLeft });
        if (this.message) text += ' ' + this.message;
      }
      if (el.textContent !== text) el.textContent = text;
    }

    renderVictoryOverlay() {
      if (!this.victoryOverlay) {
        return;
      }
      if (this.screen !== "game" || this.winner === null) {
        this.victoryOverlay.classList.remove("show");
        this.victoryOverlay.innerHTML = "";
        return;
      }

      const p1Count = this.ownUnits(1).length;
      const p2Count = this.ownUnits(2).length;
      const winnerColor = this.winner === 1 ? COLORS.p1 : COLORS.p2;
      const modeLabel = this.online ? tr("Онлайн") : this.getGameModeLabel();

      // Online: relabel from the local player's perspective + offer a rematch.
      const online = this.online;
      const iWon = online && this.winner === this.myPlayer;
      const titleText = online ? (iWon ? tr("🏆 Победа!") : tr("Поражение")) : tr("🏆 Победа");
      const winnerText = online
        ? iWon
          ? tr("Вы победили!")
          : tr("Вы проиграли")
        : tr("Победил игрок {p}", { p: this.winner });
      const actions = online
        ? '<button class="btn restart" data-action="online-rematch">' + tr('Реванш') + '</button>' +
          '<button class="btn secondary" data-action="back-menu">' + tr('В меню') + '</button>'
        : '<button class="btn restart" data-action="restart">' + tr('Рестарт') + '</button>' +
          '<button class="btn secondary" data-action="back-menu">' + tr('В меню') + '</button>';

      this.victoryOverlay.innerHTML =
        '<div class="victory-panel victory-panel--entry">' +
        '<div class="victory-title">' +
        titleText +
        "</div>" +
        '<div class="victory-winner" style="color:' +
        winnerColor +
        '">' +
        winnerText +
        "</div>" +
        '<div class="victory-sub">' + tr('Режим') + ': ' +
        modeLabel +
        "</div>" +
        '<div class="victory-stats">' +
        '<span>' + tr('Игрок {p}', { p: 1 }) + ': ' + p1Count + '</span>' +
        '<span>' + tr('Игрок {p}', { p: 2 }) + ': ' + p2Count + '</span>' +
        '</div>' +
        (this.sessionWins[1] + this.sessionWins[2] > 1
          ? '<div class="victory-session">' + tr('Счёт сессии:') + ' ' + this.sessionWins[1] + ' — ' + this.sessionWins[2] + '</div>'
          : '') +
        '<div class="victory-actions">' +
        actions +
        "</div>" +
        "</div>";

      this.victoryOverlay.classList.add("show");
      this.launchConfetti(winnerColor);
    }

    launchConfetti(winnerColor) {
      const old = document.getElementById('confettiCanvas');
      // BUGFIX: stop the previous confetti's rAF loop before discarding the
      // canvas — plain .remove() left an orphaned requestAnimationFrame chain
      // drawing to a detached canvas (leaked on repeated wins/rematches).
      if (old) { if (old._stop) old._stop(); else old.remove(); }

      const cv = document.createElement('canvas');
      cv.id = 'confettiCanvas';
      cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:35;';
      cv.width  = window.innerWidth  * (window.devicePixelRatio || 1);
      cv.height = window.innerHeight * (window.devicePixelRatio || 1);
      cv.style.width  = window.innerWidth  + 'px';
      cv.style.height = window.innerHeight + 'px';
      document.body.appendChild(cv);

      const ctx = cv.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const W = cv.width, H = cv.height;
      const accent = winnerColor || '#ffe066';
      const palette = [accent, '#ffe066', '#ffffff', '#ffb347', '#aad4ff', '#ff9fda', '#b5f5a0'];
      const N = 160;
      const particles = Array.from({length: N}, () => ({
        x: (Math.random() * window.innerWidth) * dpr,
        y: (-Math.random() * window.innerHeight * 0.6) * dpr,
        w: (5 + Math.random() * 9) * dpr,
        h: (3 + Math.random() * 5) * dpr,
        round: Math.random() < 0.25, // 25% are circles
        color: palette[Math.floor(Math.random() * palette.length)],
        vx: (Math.random() - 0.5) * 5 * dpr,
        vy: (1.5 + Math.random() * 4) * dpr,
        angle: Math.random() * Math.PI * 2,
        spin:  (Math.random() - 0.5) * 0.25,
        opacity: 1
      }));

      const TOTAL = 280, FADE_AT = 200;
      let frame = 0, rafId;
      const tick = () => {
        ctx.clearRect(0, 0, W, H);
        frame++;
        const fade = frame > FADE_AT ? Math.max(0, 1 - (frame - FADE_AT) / (TOTAL - FADE_AT)) : 1;
        particles.forEach(p => {
          p.x += p.vx + Math.sin(frame * 0.03 + p.angle) * 0.8 * dpr;
          p.y += p.vy;
          p.vy += 0.08 * dpr;
          p.angle += p.spin;
          if (p.y > H + 20 * dpr) { p.y = -20 * dpr; p.x = Math.random() * W; p.vy = (1.5 + Math.random() * 3) * dpr; }
          ctx.save();
          ctx.globalAlpha = fade;
          ctx.fillStyle = p.color;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          if (p.round) {
            ctx.beginPath();
            ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          }
          ctx.restore();
        });
        if (frame < TOTAL) { rafId = requestAnimationFrame(tick); }
        else { cv.remove(); }
      };
      rafId = requestAnimationFrame(tick);
      cv._stop = () => { cancelAnimationFrame(rafId); cv.remove(); };
    }

    stopConfetti() {
      const cv = document.getElementById('confettiCanvas');
      if (cv && cv._stop) cv._stop();
    }

    paintPreviewSprite() {
      const unit = this.getPreviewUnit();
      if (!unit) return;
      const canvas = document.getElementById("previewSprite");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#241c15";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (unit.type === "cavalry") {
        this.drawMountedComposite(ctx, unit, 0, 0, canvas.width, canvas.height);
        this._drawPreviewWeapon(ctx, unit, canvas.width);
        return;
      }
      const key = this.spriteKeyForUnit(unit);
      const img = this.assets.get(key);
      if (img) {
        const frame = UNIT_TYPES[unit.type].frame;
        const frameIndex = this.frameIndexForUnit(unit);
        ctx.drawImage(img, frame * frameIndex, 0, frame, frame, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = unit.player === 1 ? COLORS.p1 : COLORS.p2;
        ctx.fillRect(22, 22, 100, 100);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 44px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(UNIT_TYPES[unit.type].letter, 72, 72);
      }
      this._drawPreviewWeapon(ctx, unit, canvas.width);
    }

    /** Draw the equipped weapon (sword/bow) badge in the preview sprite corner. */
    _drawPreviewWeapon(ctx, unit, w) {
      if (!unit.weapon || !unit.weapon.icon) return;
      const img = this.assets.get(unit.weapon.icon);
      const sz = 48;
      const x = w - sz - 6;
      const y = 6;
      // soft backing so the icon reads over any sprite
      ctx.save();
      ctx.fillStyle = "rgba(20,14,8,0.55)";
      ctx.beginPath();
      ctx.arc(x + sz / 2, y + sz / 2, sz / 2 + 2, 0, Math.PI * 2);
      ctx.fill();
      if (img) {
        ctx.drawImage(img, x, y, sz, sz);
      } else {
        ctx.fillStyle = "#ffd86b";
        ctx.font = "30px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(this._weaponEmoji(unit.weapon.icon), x + sz / 2, y + sz / 2);
      }
      ctx.restore();
    }

    /** Map a weapon asset key to an emoji pictogram (sidebar/HTML fallback). */
    _weaponEmoji(iconKey) {
      if (iconKey === "weapon_bow") return "🏹";
      if (iconKey === "weapon_sword") return "⚔️";
      if (iconKey === "armor_mail" || iconKey === "armor_plate") return "🛡";
      return "🗡";
    }

    getPreviewUnit() {
      if (this.previewUnitId === null) {
        return null;
      }
      const unit = this.board.units.find((u) => u.id === this.previewUnitId && u.alive());
      if (!unit) {
        this.previewUnitId = null;
        return null;
      }
      return unit;
    }

    escape(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    spriteKeyForUnit(unit) {
      const faction = unit.player === 1 ? (this.p1Faction || 'blue') : (this.p2Faction || 'red');
      return "u_" + faction + "_" + unit.type;
    }

    drawMountedComposite(ctx, unit, dx, dy, dw, dh) {
      const horse = this.assets.get("horse_knight_base");
      if (horse) {
        const sw = 91;
        const sh = 57;
        const hx = dx + dw * 0.02;
        const hy = dy + dh * 0.46;
        const hw = dw * 0.96;
        const hh = dh * 0.46;
        // Use a static frame instead of animated
        ctx.drawImage(horse, 149, 165, sw, sh, hx, hy, hw, hh);
      } else {
        ctx.fillStyle = "rgba(110, 102, 96, 0.9)";
        ctx.beginPath();
        ctx.ellipse(
          dx + dw * 0.54,
          dy + dh * 0.63,
          dw * 0.34,
          dh * 0.2,
          -0.15,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }

      const rider = this.assets.get(this.spriteKeyForUnit(unit));
      if (rider) {
        const rsx = 115;
        const rsy = 48;
        const rsw = 69;
        const rsh = 150;
        const riderW = dw * 0.34;
        const riderH = dh * 0.50;
        const rx = dx + dw * 0.33;
        const ry = dy + dh * 0.11;
        ctx.drawImage(rider, rsx, rsy, rsw, rsh, rx, ry, riderW, riderH);
      } else {
        ctx.fillStyle = unit.player === 1 ? COLORS.p1 : COLORS.p2;
        ctx.fillRect(dx + dw * 0.28, dy + dh * 0.1, dw * 0.35, dh * 0.35);
      }
    }

    frameIndexForUnit(unit) {
      // Very slow animation through sprite sheet
      const animSpeed = 30; // Much slower for smooth GIF
      const totalFrames = unit.type === "cavalry" ? 4 : 6;
      return Math.floor(this.frameCount / animSpeed) % totalFrames;
    }

    drawMenuCanvas() {
      const ctx = this.ctx;
      ctx.fillStyle = "#0e0e0e";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      const cover = this.assets.get("cover");
      if (cover) {
        const scale = Math.min(WIDTH / cover.width, HEIGHT / cover.height);
        const dw = cover.width * scale;
        const dh = cover.height * scale;
        const dx = (WIDTH - dw) / 2;
        const dy = (HEIGHT - dh) / 2;
        ctx.drawImage(cover, dx, dy, dw, dh);
      } else {
        ctx.fillStyle = "#3a2a1b";
        ctx.fillRect(28, 180, WIDTH - 56, HEIGHT - 360);
        ctx.fillStyle = "#f0d7a6";
        ctx.font = "bold 42px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tr("Рыцари и Замки"), WIDTH / 2, HEIGHT / 2 - 12);
      }

      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1);
    }

    drawGameCanvas() {
      const ctx = this.ctx;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      // Apply board offset + scale and camera shake
      ctx.save();
      ctx.translate(this.boardOffsetX, this.boardOffsetY);
      ctx.scale(this.boardScale, this.boardScale);
      ctx.translate(this.cameraShakeX / this.boardScale, this.cameraShakeY / this.boardScale);

      if (this.mapTheme === 'sea') {
        this.drawSeaGround(ctx);
      } else {
        // Pixel-art grass field: tile the interior grass tile from the Tiny
        // Swords terrain atlas (grid cell 1,1 -> source 64,64,64,64). A faint
        // checker tint preserves per-cell readability. Falls back to the flat
        // two-green checkerboard if the atlas hasn't loaded.
        const grass = this.assets.get("terrain_grass");
        for (let row = 0; row < ROWS; row += 1) {
          for (let col = 0; col < COLS; col += 1) {
            const x = col * CELL_SIZE;
            const y = row * CELL_SIZE;
            if (grass) {
              ctx.drawImage(grass, 64, 64, 64, 64, x, y, CELL_SIZE, CELL_SIZE);
              ctx.fillStyle = (row + col) % 2 === 0 ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.07)";
              ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
            } else {
              ctx.fillStyle = (row + col) % 2 === 0 ? COLORS.groundA : COLORS.groundB;
              ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
            }
          }
        }
      }

      const p1Top = this.player1Bottom ? 16 : 0;
      const p2Top = this.player1Bottom ? 0 : 16;
      this.drawCastle(1, p1Top, getCastleP1Col());
      this.drawCastle(2, p2Top, getCastleP2Col());
      this.drawTowers();
      this.drawConstructions();
      // Ruins removed from the map: artifacts are buried across the whole board
      // now, so the rectangles were only visual clutter.
      this.drawTerrain(ctx);
      this.drawDroppedItems(ctx);
      this.drawBuriedMounds(ctx);

      // P0 threat overlay (toggle): enemy danger zones, under the player's own
      // selection/move/attack highlights.
      this.drawThreatOverlay(ctx);
      // Reach preview for the tapped unit (no move required): ranged units show
      // their firing square, melee units show who they can walk up to and hit.
      this.drawReachPreview(ctx);
      // Catapult aiming: mark every empty cell a boulder can be dropped on.
      // Was a near-invisible grey-on-grass wash (rgba(180,170,155)) — low
      // enough contrast on the green ground that legal cells read as blocked.
      // Bumped to a saturated gold (this mode's own colour, distinct from
      // move-green/attack-red/threat-blue) with a solid border so "targetable"
      // is unambiguous at a glance.
      if (this.rockMode && this.rockTargets && this.rockTargets.length > 0) {
        ctx.save();
        const pulse = 0.45 + 0.25 * Math.sin(this.frameCount * 0.15);
        ctx.fillStyle = "rgba(232, 195, 91, " + pulse.toFixed(2) + ")";
        ctx.strokeStyle = "rgba(255, 224, 140, 0.9)";
        ctx.lineWidth = 2;
        const terrainNow = getTerrain();
        this.rockTargets.forEach((t) => {
          const x = t.col * CELL_SIZE, y = t.row * CELL_SIZE;
          // Existing boulders are shatter-targets: mark them red, not gold.
          const isRock = terrainNow.some(
            (c) => c.row === t.row && c.col === t.col && c.type === "rock",
          );
          ctx.save();
          if (isRock) {
            ctx.fillStyle = "rgba(220, 90, 60, " + pulse.toFixed(2) + ")";
            ctx.strokeStyle = "rgba(255, 120, 80, 0.9)";
          }
          ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
          ctx.strokeRect(x + 2, y + 2, CELL_SIZE - 4, CELL_SIZE - 4);
          ctx.restore();
        });
        ctx.restore();
      }

      // Mage ability aiming: highlight every cell the current mode can
      // legally target. Heal reads green (friendly), the other 3 read purple
      // (arcane/offensive) — distinct from move-green's shade and from
      // attack-red so all 3 highlight families stay readable together.
      if (this.mageMode && this.mageTargets && this.mageTargets.length > 0) {
        ctx.save();
        const pulse = 0.45 + 0.25 * Math.sin(this.frameCount * 0.15);
        const isHeal = this.mageMode === 'heal';
        ctx.fillStyle = isHeal
          ? "rgba(103, 207, 111, " + pulse.toFixed(2) + ")"
          : "rgba(199, 125, 255, " + pulse.toFixed(2) + ")";
        ctx.strokeStyle = isHeal ? "rgba(140, 255, 150, 0.9)" : "rgba(224, 170, 255, 0.9)";
        ctx.lineWidth = 2;
        this.mageTargets.forEach((t) => {
          const x = t.col * CELL_SIZE, y = t.row * CELL_SIZE;
          ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
          ctx.strokeRect(x + 2, y + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        });
        ctx.restore();
      }

      // Ward multi-select: highlight every eligible ally, with a distinct
      // colour for "about to be added" vs "about to be removed" vs
      // "eligible but not picked yet" — mirrors the sidebar picker exactly.
      if (this.mageMode === 'ward' && this.selectedUnit) {
        const pulse = 0.45 + 0.25 * Math.sin(this.frameCount * 0.15);
        const allies = this.board.units.filter((o) => o.alive() && o.player === this.selectedUnit.player);
        ctx.save();
        allies.forEach((a) => {
          const isWarded = a.wardedBy === this.selectedUnit.id;
          const isWardedByOther = a.wardedBy && a.wardedBy !== this.selectedUnit.id;
          const picked = this.mageWardPicks.has(a.id);
          const willAdd = picked && !isWarded;
          const willRemove = picked && isWarded;
          let fill = "rgba(160, 160, 160, 0.25)";
          let stroke = "rgba(220, 220, 220, 0.6)";
          if (isWardedByOther) {
            fill = "rgba(120, 120, 120, 0.15)";
            stroke = "rgba(150, 150, 150, 0.4)";
          } else if (willAdd) {
            fill = "rgba(100, 149, 237, " + pulse.toFixed(2) + ")";
            stroke = "rgba(140, 180, 255, 0.9)";
          } else if (willRemove) {
            fill = "rgba(220, 90, 60, " + pulse.toFixed(2) + ")";
            stroke = "rgba(255, 120, 80, 0.9)";
          } else if (isWarded) {
            fill = "rgba(100, 149, 237, 0.2)";
            stroke = "rgba(140, 180, 255, 0.6)";
          }
          const x = a.col * CELL_SIZE, y = a.row * CELL_SIZE;
          ctx.fillStyle = fill;
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 2;
          ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
          ctx.strokeRect(x + 2, y + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        });
        ctx.restore();
      }

      if (this.transferOpenUnitId !== null && this.selectedUnit && this.transferOpenUnitId === this.selectedUnit.id) {
        const allies = this.adjacentAllies(this.selectedUnit);
        const pulse = 0.45 + 0.25 * Math.sin(this.frameCount * 0.15);
        allies.forEach((ally) => {
          const isTarget = this.transferTargetId === ally.id;
          ctx.save();
          ctx.fillStyle = isTarget ? "rgba(96, 210, 140, " + pulse.toFixed(2) + ")" : "rgba(70, 180, 240, 0.45)";
          ctx.strokeStyle = isTarget ? "#40e0a0" : "#40b0f0";
          ctx.lineWidth = 2.5;
          const ax = ally.col * CELL_SIZE;
          const ay = ally.row * CELL_SIZE;
          ctx.fillRect(ax + 2, ay + 2, CELL_SIZE - 4, CELL_SIZE - 4);
          ctx.strokeRect(ax + 2, ay + 2, CELL_SIZE - 4, CELL_SIZE - 4);
          ctx.restore();
        });
      }

      if (this.selectedUnit) {
        const sx = this.selectedUnit.col * CELL_SIZE;
        const sy = this.selectedUnit.row * CELL_SIZE;
        ctx.strokeStyle = COLORS.selected;
        ctx.lineWidth = 3;
        ctx.strokeRect(sx + 2, sy + 2, CELL_SIZE - 4, CELL_SIZE - 4);
      }

      this.moveMap.forEach((m) => {
        ctx.fillStyle = COLORS.move;
        ctx.fillRect(m.col * CELL_SIZE, m.row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      });

      this.attackMap.forEach((a) => {
        if (a.mode === "pierce" && this.selectedUnit) {
          // Every cell on the bolt's line gets its own highlight — amber with
          // a hazard border for a friendly unit standing on the line (this
          // shot hits them too), the normal attack colour for an enemy one.
          const line = a.targets && a.targets.length
            ? a.targets
            : [{ row: a.targetRow, col: a.targetCol }];
          line.forEach((cell) => {
            const occupant = this.board.unitAt(cell.row, cell.col);
            const friendly = occupant && occupant.player === this.selectedUnit.player;
            ctx.fillStyle = friendly ? "rgba(255, 176, 32, 0.55)" : COLORS.attack;
            ctx.fillRect(cell.col * CELL_SIZE, cell.row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            if (friendly) {
              ctx.save();
              ctx.strokeStyle = "rgba(255, 120, 0, 0.9)";
              ctx.lineWidth = 2;
              ctx.strokeRect(cell.col * CELL_SIZE + 2, cell.row * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
              ctx.restore();
            }
          });
          const sx = this.selectedUnit.col * CELL_SIZE + CELL_SIZE / 2;
          const sy = this.selectedUnit.row * CELL_SIZE + CELL_SIZE / 2;
          const far = line[line.length - 1];
          ctx.save();
          ctx.strokeStyle = "rgba(160, 224, 255, 0.45)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(far.col * CELL_SIZE + CELL_SIZE / 2, far.row * CELL_SIZE + CELL_SIZE / 2);
          ctx.stroke();
          ctx.restore();
          return;
        }

        // Shot-mode: highlight target cell. Landing-mode: highlight landing cell.
        const drawCol = a.mode === 'shot' ? a.targetCol : a.col;
        const drawRow = a.mode === 'shot' ? a.targetRow : a.row;
        ctx.fillStyle = a.mode === "l-attack" ? COLORS.attackL : COLORS.attack;
        ctx.fillRect(drawCol * CELL_SIZE, drawRow * CELL_SIZE, CELL_SIZE, CELL_SIZE);

        // Draw trajectory line for ranged shots, colour-coded per unit type
        if (a.mode === "shot" && this.selectedUnit) {
          const ut = this.selectedUnit.type;
          const trajColor =
            ut === 'crossbow' ? "rgba(160, 224, 255, 0.35)" :
            ut === 'catapult' ? "rgba(255, 136,  68, 0.35)" :
            ut === 'archer'   ? "rgba(255, 200,  50, 0.25)" : null;
          if (trajColor) {
            ctx.save();
            ctx.strokeStyle = trajColor;
            ctx.lineWidth = ut === 'catapult' ? 2 : 1;
            ctx.setLineDash([3, 4]);
            const sx = this.selectedUnit.col * CELL_SIZE + CELL_SIZE / 2;
            const sy = this.selectedUnit.row * CELL_SIZE + CELL_SIZE / 2;
            const tx = a.targetCol * CELL_SIZE + CELL_SIZE / 2;
            const ty = a.targetRow * CELL_SIZE + CELL_SIZE / 2;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.restore();
          }
        }

        // L-атака: рисуем L-образный путь
        if (a.mode === "l-attack" && this.selectedUnit) {
          ctx.save();
          ctx.strokeStyle = "rgba(230, 120, 50, 0.6)";
          ctx.lineWidth = 3;
          ctx.setLineDash([5, 5]);
          const startX = this.selectedUnit.col * CELL_SIZE + CELL_SIZE / 2;
          const startY = this.selectedUnit.row * CELL_SIZE + CELL_SIZE / 2;
          const targetX = a.targetCol * CELL_SIZE + CELL_SIZE / 2;
          const targetY = a.targetRow * CELL_SIZE + CELL_SIZE / 2;
          const endX = a.col * CELL_SIZE + CELL_SIZE / 2;
          const endY = a.row * CELL_SIZE + CELL_SIZE / 2;
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(targetX, targetY);
          ctx.lineTo(endX, endY);
          ctx.stroke();
          ctx.fillStyle = "rgba(230, 120, 50, 0.5)";
          ctx.beginPath();
          ctx.arc(targetX, targetY, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });

      // Draw all units including dying ones
      this.board.units.forEach((u) => {
        this.drawUnit(u);
      });

      // Ward badges — drawn on top of the sprites, same pass as the attack
      // marks below, so a warded unit is visibly protected at a glance.
      this.drawWardBadges(ctx);

      // Attack targets, marked ON TOP of the sprites. The flat fill painted
      // above is hidden by the enemy's own sprite (drawImage covers the whole
      // cell), so without this pass a ranged attacker appears to highlight
      // every cell around its victim but never the victim itself.
      this.drawAttackTargetMarks(ctx);
      // Landing-cell collision: two different cavalry victims share one
      // square, and the click on that square is now held pending until the
      // player picks which one. Number each candidate directly on its victim
      // so "click here for THIS one" is unambiguous.
      this.drawPendingAttackChoice(ctx);

      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      for (let row = 0; row <= ROWS; row += 1) {
        ctx.beginPath();
        ctx.moveTo(0, row * CELL_SIZE + 0.5);
        ctx.lineTo(WIDTH, row * CELL_SIZE + 0.5);
        ctx.stroke();
      }
      for (let col = 0; col <= COLS; col += 1) {
        ctx.beginPath();
        ctx.moveTo(col * CELL_SIZE + 0.5, 0);
        ctx.lineTo(col * CELL_SIZE + 0.5, HEIGHT);
        ctx.stroke();
      }
      
      // P0 forecast: predicted damage on every attackable target (always-on
      // perfect information, drawn on top of units/grid).
      this.drawAttackForecast(ctx);

      // Draw particles, floating texts, and arrows on top
      this.drawParticles();
      this.drawFloatingTexts();
      fxDrawArrows(ctx, this.arrowProjectiles);

      // Anim #7: turn-end radial wave
      if (this.turnEndWave > 0) {
        const waveProgress = 1 - this.turnEndWave; // 0→1 as it expands
        const boardW = COLS * CELL_SIZE;
        const boardH = ROWS * CELL_SIZE;
        const maxRadius = Math.sqrt(boardW * boardW + boardH * boardH) * 0.5;
        const radius = maxRadius * waveProgress;
        const alpha = this.turnEndWave * 0.4;
        ctx.save();
        ctx.strokeStyle = `rgba(255, 220, 80, ${alpha})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(boardW / 2, boardH / 2, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      this.drawTutorialSpotlight(ctx);

      ctx.restore();

      // Anim #13: board fade-in overlay (drawn in screen space, after ctx.restore)
      if (this.boardFadeIn < 1) {
        const alpha = 1 - this.boardFadeIn;
        this.ctx.save();
        this.ctx.fillStyle = `rgba(0,0,0,${alpha})`;
        this.ctx.fillRect(0, 0, WIDTH, HEIGHT);
        this.ctx.restore();
      }
    }

    drawSeaGround(ctx) {
      // Deep water background
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          ctx.fillStyle = (row + col) % 2 === 0 ? '#0d3f6e' : '#0f4a82';
          ctx.fillRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }
      // Animated waves
      const t = this.frameCount * 0.025;
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = '#7ac0ff';
      ctx.lineWidth = 1.5;
      for (let wy = 0; wy < HEIGHT; wy += 26) {
        ctx.beginPath();
        for (let wx = 0; wx <= WIDTH; wx += 6) {
          const wh = wy + Math.sin(wx * 0.06 + t) * 3.5 + Math.sin(wx * 0.025 + t * 1.4) * 2.5;
          if (wx === 0) ctx.moveTo(wx, wh);
          else ctx.lineTo(wx, wh);
        }
        ctx.stroke();
      }
      ctx.restore();

      // Two ship decks: top ship (P2) and bottom ship (P1), borт o borт at center
      const mid = Math.floor(ROWS / 2);
      this.drawShipDeck(ctx, 0, mid);     // P2 ship (top)
      this.drawShipDeck(ctx, mid, ROWS);  // P1 ship (bottom)

      // Gangplank between ships at center
      ctx.save();
      ctx.fillStyle = '#9e7a3a';
      const gx = 2 * CELL_SIZE;
      const gy = mid * CELL_SIZE - 4;
      const gw = (COLS - 4) * CELL_SIZE;
      ctx.fillRect(gx, gy, gw, 8);
      // Plank lines
      ctx.strokeStyle = '#6b5220';
      ctx.lineWidth = 1;
      for (let px = gx; px < gx + gw; px += 16) {
        ctx.beginPath(); ctx.moveTo(px, gy); ctx.lineTo(px, gy + 8); ctx.stroke();
      }
      ctx.restore();
    }

    drawShipDeck(ctx, startRow, endRow) {
      const rows = endRow - startRow;
      // Wooden deck planks (horizontal stripes)
      for (let r = startRow; r < endRow; r++) {
        for (let c = 1; c < COLS - 1; c++) {
          ctx.fillStyle = r % 3 === 0 ? '#7a5c2a' : '#6b5225';
          ctx.fillRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }
      // Plank grain lines
      ctx.save();
      ctx.strokeStyle = '#5a4018';
      ctx.lineWidth = 0.8;
      ctx.globalAlpha = 0.5;
      for (let r = startRow; r < endRow; r++) {
        ctx.beginPath();
        ctx.moveTo(CELL_SIZE, r * CELL_SIZE + CELL_SIZE * 0.5);
        ctx.lineTo((COLS - 1) * CELL_SIZE, r * CELL_SIZE + CELL_SIZE * 0.5);
        ctx.stroke();
      }
      ctx.restore();
      // Ship rails (outer columns = gunwale)
      ctx.fillStyle = '#3a2410';
      ctx.fillRect(0, startRow * CELL_SIZE, CELL_SIZE, rows * CELL_SIZE);
      ctx.fillRect((COLS - 1) * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE, rows * CELL_SIZE);
      // Rail highlight
      ctx.save();
      ctx.strokeStyle = '#6a4520';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, startRow * CELL_SIZE + 1, CELL_SIZE - 2, rows * CELL_SIZE - 2);
      ctx.strokeRect((COLS - 1) * CELL_SIZE + 1, startRow * CELL_SIZE + 1, CELL_SIZE - 2, rows * CELL_SIZE - 2);
      ctx.restore();
      // Cannon ports on rails (decorative)
      ctx.fillStyle = '#1a0d00';
      for (let r = startRow + 2; r < endRow - 1; r += 3) {
        ctx.beginPath(); ctx.arc(CELL_SIZE / 2, r * CELL_SIZE + CELL_SIZE / 2, 6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc((COLS - 0.5) * CELL_SIZE, r * CELL_SIZE + CELL_SIZE / 2, 6, 0, Math.PI * 2); ctx.fill();
      }
    }

    drawCaptainBridge(ctx, player, x, y, size) {
      const col = player === 1 ? COLORS.p1 : COLORS.p2;
      // Hull of the bridge
      ctx.fillStyle = '#4a3010';
      ctx.fillRect(x + 2, y + 2, size - 4, size - 4);
      // Wooden walls
      ctx.fillStyle = '#6b4820';
      ctx.fillRect(x + 6, y + 6, size - 12, size - 12);
      // Windows (portholes)
      const pts = [[0.25, 0.25], [0.7, 0.25], [0.25, 0.65], [0.7, 0.65]];
      ctx.fillStyle = player === 1 ? 'rgba(89,163,255,0.65)' : 'rgba(227,87,87,0.65)';
      pts.forEach(([fx, fy]) => {
        const wx = x + size * fx; const wy = y + size * fy; const wr = size * 0.10;
        ctx.beginPath(); ctx.arc(wx, wy, wr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 2; ctx.stroke();
      });
      // Steering wheel
      ctx.strokeStyle = col; ctx.lineWidth = 2.5;
      const cx = x + size / 2; const cy = y + size * 0.5;
      const wr = size * 0.16;
      ctx.beginPath(); ctx.arc(cx, cy, wr, 0, Math.PI * 2); ctx.stroke();
      for (let a = 0; a < 8; a++) {
        const ang = a * Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * wr * 0.35, cy + Math.sin(ang) * wr * 0.35);
        ctx.lineTo(cx + Math.cos(ang) * wr, cy + Math.sin(ang) * wr);
        ctx.stroke();
      }
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
      // Border
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.strokeRect(x + 2, y + 2, size - 4, size - 4);
    }

    drawTerrain(ctx) {
      const terrain = getTerrain();
      const S = CELL_SIZE;

      // Fast lookup: which cells carry water (river / bridge)
      const waterCells = new Set();
      for (const t of terrain) {
        if (t.type === 'river' || t.type === 'bridge')
          waterCells.add(t.row + ',' + t.col);
      }

      const waterImg = this.assets.get("water_bg");
      const rockImgs = [
        this.assets.get("terrain_rock1"),
        this.assets.get("terrain_rock2"),
        this.assets.get("terrain_rock3"),
        this.assets.get("terrain_rock4"),
      ];

      // Build a per-cell water path. Convex corners (no water on either of the
      // two adjacent sides) are cut to a rounded curve, so river bends read as
      // smooth turns instead of blocky L-shapes.
      const waterPath = (x, y, hasN, hasS, hasE, hasW) => {
        const R = Math.floor(S * 0.45);
        const tl = !hasN && !hasW ? R : 0;
        const tr = !hasN && !hasE ? R : 0;
        const br = !hasS && !hasE ? R : 0;
        const bl = !hasS && !hasW ? R : 0;
        ctx.beginPath();
        ctx.moveTo(x + tl, y);
        ctx.lineTo(x + S - tr, y);
        if (tr) ctx.arcTo(x + S, y, x + S, y + tr, tr);
        ctx.lineTo(x + S, y + S - br);
        if (br) ctx.arcTo(x + S, y + S, x + S - br, y + S, br);
        ctx.lineTo(x + bl, y + S);
        if (bl) ctx.arcTo(x, y + S, x, y + S - bl, bl);
        ctx.lineTo(x, y + tl);
        if (tl) ctx.arcTo(x, y, x + tl, y, tl);
        ctx.closePath();
      };

      for (const t of terrain) {
        const x = t.col * S;
        const y = t.row * S;

        if (t.type === 'river' || t.type === 'bridge') {
          const hasN = waterCells.has(t.row - 1 + ',' + t.col);
          const hasS = waterCells.has(t.row + 1 + ',' + t.col);
          const hasE = waterCells.has(t.row + ',' + (t.col + 1));
          const hasW = waterCells.has(t.row + ',' + (t.col - 1));

          // Water fill clipped to the rounded path (rounded outer corners on bends).
          ctx.save();
          waterPath(x, y, hasN, hasS, hasE, hasW);
          ctx.clip();
          if (waterImg) {
            ctx.drawImage(waterImg, 0, 0, 64, 64, x, y, S, S);
          } else {
            ctx.fillStyle = '#44b8c4';
            ctx.fillRect(x, y, S, S);
          }
          ctx.fillStyle = 'rgba(120,220,230,0.20)';
          ctx.fillRect(x + 2, y + 2, S - 4, S - 4);
          ctx.restore();

          if (t.type === 'bridge') {
            // Wooden planks spanning the full cell (crossing is vertical).
            ctx.fillStyle = '#8b5e18';
            ctx.fillRect(x, y, S, S);
            ctx.fillStyle = '#a67020';
            ctx.fillRect(x + 1, y + 1, S - 2, S - 2);
            ctx.fillStyle = '#5a3a08';
            for (let p = 1; p < 4; p++)
              ctx.fillRect(x, y + Math.floor((S / 4) * p), S, 1);
            ctx.fillStyle = '#3a2005';
            ctx.fillRect(x, y, S, 2);
            ctx.fillRect(x, y + S - 2, S, 2);

            const hp = (getBridgeDurability()[`${t.row},${t.col}`] ?? 2);
            ctx.fillStyle = hp < 2 ? '#ff6b6b' : '#ffffff';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`🌉 ${hp}/2`, x + S / 2, y + S / 2);
          }

        } else if (t.type === 'rock') {
          // Catapult boulder — Tiny Swords Rock sprite, picked deterministically
          // from the cell so a given boulder always looks the same.
          const rockSprites = [
            this.assets.get("terrain_rock1"),
            this.assets.get("terrain_rock2"),
            this.assets.get("terrain_rock3"),
            this.assets.get("terrain_rock4"),
          ].filter(Boolean);
          const spr = rockSprites.length
            ? rockSprites[(t.row * 7 + t.col * 13) % rockSprites.length]
            : null;
          if (spr) {
            ctx.save();
            ctx.fillStyle = "rgba(0,0,0,0.20)";
            ctx.beginPath();
            ctx.ellipse(x + CELL_SIZE / 2, y + CELL_SIZE * 0.74, CELL_SIZE * 0.32, CELL_SIZE * 0.12, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.drawImage(spr, x + CELL_SIZE * 0.06, y + CELL_SIZE * 0.02, CELL_SIZE * 0.88, CELL_SIZE * 0.92);
            ctx.restore();
          } else {
            ctx.save();
            ctx.fillStyle = "#8d857a";
            ctx.beginPath();
            ctx.arc(x + CELL_SIZE / 2, y + CELL_SIZE / 2, CELL_SIZE * 0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        } else if (t.type === 'mountain') {
          // TinySwords Rock sprites — transparent PNG so grass shows through edges
          const rockIdx = (t.row * 7 + t.col * 13) & 3;
          const rock = rockImgs[rockIdx];
          if (rock) {
            ctx.drawImage(rock, 0, 0, 64, 64, x, y, S, S);
          } else {
            ctx.fillStyle = 'rgba(60,50,70,0.75)';
            ctx.fillRect(x + 3, y + 4, S - 6, S - 6);
          }
        }
      }
    }

    drawCastle(player, topRow, leftCol) {
      const ctx = this.ctx;
      const x = leftCol * CELL_SIZE;
      const y = topRow * CELL_SIZE;
      const size = CELL_SIZE * 4;

      if (this.mapTheme === 'sea') {
        this.drawCaptainBridge(ctx, player, x, y, size);
        return;
      }

      const key = player === 1 ? "castle_blue" : "castle_red";
      const img = this.assets.get(key);

      if (img) {
        ctx.drawImage(img, x, y, size, size);
      } else {
        ctx.fillStyle = player === 1 ? "rgba(70,130,220,0.30)" : "rgba(220,70,70,0.30)";
        ctx.fillRect(x, y, size, size);
        ctx.strokeStyle = player === 1 ? COLORS.p1 : COLORS.p2;
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 2, y + 2, size - 4, size - 4);
        ctx.fillStyle = player === 1 ? COLORS.p1 : COLORS.p2;
        ctx.font = "bold 20px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("CASTLE", x + size / 2, y + size / 2);
      }
    }

    drawTowers() {
      const ctx = this.ctx;
      const img = this.assets.get("tower_blue");
      getTowers().forEach((t) => {
        const x = t.col * CELL_SIZE;
        const y = t.row * CELL_SIZE;

        if (img) {
          ctx.drawImage(img, x, y, CELL_SIZE, CELL_SIZE);
        } else {
          ctx.fillStyle = "#513c6f";
          ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
          ctx.strokeStyle = "#b89dff";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
          ctx.fillStyle = "#decfff";
          ctx.font = "bold 14px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("T", x + CELL_SIZE / 2, y + CELL_SIZE / 2);
        }

        // Anim #10: tower capture flash — golden radial glow
        if (this.towerFlashTimer > 0 && t.row === this.towerFlashRow && t.col === this.towerFlashCol) {
          const alpha = this.towerFlashTimer * 0.7;
          const cx = x + CELL_SIZE / 2;
          const cy = y + CELL_SIZE / 2;
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, CELL_SIZE);
          grad.addColorStop(0, `rgba(255, 230, 80, ${alpha})`);
          grad.addColorStop(0.5, `rgba(255, 180, 20, ${alpha * 0.5})`);
          grad.addColorStop(1, 'rgba(255, 150, 0, 0)');
          ctx.save();
          ctx.fillStyle = grad;
          ctx.fillRect(x - CELL_SIZE / 2, y - CELL_SIZE / 2, CELL_SIZE * 2, CELL_SIZE * 2);
          ctx.restore();
        }
      });
    }

    /**
     * Buried pickups read as small mounds of disturbed earth with a bush tuft
     * (Tiny Swords Decorations/Bushes). Deliberately understated and identical
     * for every kind: you can see that SOMETHING is buried, never what — which
     * keeps the "you don't know until you step on it" rule while giving players
     * a reason to walk off the direct path.
     */
    drawBuriedMounds(ctx) {
      // Set `showBuriedHints = false` to make buried loot fully invisible again.
      if (!this.showBuriedHints) return;
      if (!this.hiddenPickups || this.hiddenPickups.length === 0) return;

      this.hiddenPickups.forEach((p) => {
        const cx = p.col * CELL_SIZE + CELL_SIZE / 2;
        const cy = p.row * CELL_SIZE + CELL_SIZE * 0.66;
        // Deterministic per-cell jitter so the tufts don't look machine-placed.
        const j = ((p.row * 31 + p.col * 17) % 7) - 3;
        ctx.save();
        // A faint patch of paler, disturbed earth — no heavy brown blob.
        ctx.fillStyle = "rgba(126, 108, 66, 0.30)";
        ctx.beginPath();
        ctx.ellipse(cx + j * 0.3, cy, CELL_SIZE * 0.2, CELL_SIZE * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
        // Three short grass blades leaning out of it: reads as "something was
        // dug here" at a glance without cluttering the tile.
        ctx.strokeStyle = "rgba(96, 132, 58, 0.85)";
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        for (let i = 0; i < 3; i += 1) {
          const bx = cx + (i - 1) * CELL_SIZE * 0.12 + j * 0.2;
          const lean = (i - 1) * CELL_SIZE * 0.05;
          ctx.beginPath();
          ctx.moveTo(bx, cy + CELL_SIZE * 0.04);
          ctx.quadraticCurveTo(bx + lean, cy - CELL_SIZE * 0.1, bx + lean * 1.8, cy - CELL_SIZE * 0.2);
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    /** A dead unit's backpack (parts + weapon + armour, dropped as one object)
     * renders as a single bobbing backpack icon — whoever steps on it picks
     * up everything at once. */
    drawDroppedItems(ctx) {
      if (!this.droppedBackpacks || this.droppedBackpacks.length === 0) return;
      const t = this.frameCount * 0.08;
      this.droppedBackpacks.forEach((pack) => {
        const cx = pack.col * CELL_SIZE + CELL_SIZE / 2;
        const cy = pack.row * CELL_SIZE + CELL_SIZE / 2 + Math.sin(t + pack.col) * 2;
        ctx.save();
        // Soft glow pad so loot reads as pick-up-able.
        ctx.beginPath();
        ctx.arc(cx, cy, CELL_SIZE * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(200,150,80,0.30)";
        ctx.fill();
        ctx.strokeStyle = "rgba(230,180,110,0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = Math.floor(CELL_SIZE * 0.42) + "px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🎒", cx, cy);
        ctx.restore();
      });
    }

    drawRuins() {
      // Two ruins on the map — render each area.
      for (const area of getAllRuins()) this.drawRuinsArea(area);
    }

    drawRuinsArea(area) {
      const ctx = this.ctx;
      const x = area.left * CELL_SIZE;
      const y = area.top * CELL_SIZE;
      const w = area.width * CELL_SIZE;
      const h = area.height * CELL_SIZE;

      const customRuins = this.assets.get("ruins_custom");
      if (customRuins) {
        // Harmonize custom ruins with board palette and perspective.
        const grassCenter = ctx.createRadialGradient(
          x + w * 0.5,
          y + h * 0.56,
          w * 0.08,
          x + w * 0.5,
          y + h * 0.56,
          w * 0.74
        );
        grassCenter.addColorStop(0, "#9fd56e");
        grassCenter.addColorStop(0.52, "#78aa4e");
        grassCenter.addColorStop(1, "#4d7038");
        ctx.fillStyle = grassCenter;
        ctx.fillRect(x, y, w, h);

        ctx.fillStyle = "rgba(0,0,0,0.14)";
        ctx.beginPath();
        ctx.ellipse(x + w * 0.52, y + h * 0.73, w * 0.44, h * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.save();
        ctx.filter = "saturate(0.96) brightness(1.08) contrast(0.98)";
        ctx.globalAlpha = 0.98;
        // Crop inner composition to avoid glow/vignette and keep clean fit in 2x2.
        ctx.drawImage(customRuins, 170, 170, 700, 620, x + 3, y + 2, w - 6, h - 4);
        ctx.restore();

        const centerGlow = ctx.createRadialGradient(
          x + w * 0.5,
          y + h * 0.58,
          w * 0.1,
          x + w * 0.5,
          y + h * 0.58,
          w * 0.72
        );
        centerGlow.addColorStop(0, "rgba(150,203,103,0.44)");
        centerGlow.addColorStop(0.56, "rgba(112,162,76,0.26)");
        centerGlow.addColorStop(1, "rgba(60,88,42,0)");
        ctx.fillStyle = centerGlow;
        ctx.fillRect(x, y, w, h);

        ctx.strokeStyle = "rgba(52,43,32,0.55)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 26, y + 30);
        ctx.lineTo(x + 32, y + 46);
        ctx.lineTo(x + 25, y + 62);
        ctx.lineTo(x + 34, y + 77);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 64, y + 24);
        ctx.lineTo(x + 56, y + 42);
        ctx.lineTo(x + 66, y + 58);
        ctx.lineTo(x + 58, y + 76);
        ctx.stroke();

        ctx.fillStyle = "rgba(96,128,74,0.52)";
        ctx.beginPath();
        ctx.ellipse(x + 18, y + 82, 9, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(x + 74, y + 79, 8, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(0,0,0,0.05)";
        ctx.fillRect(x, y + 10, w, h - 10);
        // Custom ruins fully drawn — skip the fallback monastery/columns layer
        // below, which would otherwise double-render on top and muddy the tile.
        return;
    }

      const fallbackGrass = ctx.createRadialGradient(
        x + w * 0.5,
        y + h * 0.56,
        w * 0.06,
        x + w * 0.5,
        y + h * 0.56,
        w * 0.74
      );
      fallbackGrass.addColorStop(0, "#94c662");
      fallbackGrass.addColorStop(0.56, "#6f9f47");
      fallbackGrass.addColorStop(1, "#496b37");
      ctx.fillStyle = fallbackGrass;
      ctx.fillRect(x, y, w, h);

      const monastery = this.assets.get("monastery_ruins");
      if (monastery) {
        ctx.save();
        ctx.globalAlpha = 0.93;
        // Lower body of monastery sprite keeps Tiny Swords style and fits 2x2 ruins zone.
        ctx.drawImage(monastery, 0, 128, 192, 192, x + 3, y - 6, w - 6, h + 12);
        ctx.restore();
      }

      this.drawBrokenColumn(x + 12, y + 20, 15, 40, "#8a8178");
      this.drawBrokenColumn(x + 60, y + 24, 14, 35, "#776d63");

      ctx.fillStyle = "rgba(39,30,23,0.72)";
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 2);
      ctx.lineTo(x + 26, y + 2);
      ctx.lineTo(x + 17, y + 18);
      ctx.lineTo(x + 4, y + 15);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x + w - 3, y + 8);
      ctx.lineTo(x + w - 24, y + 14);
      ctx.lineTo(x + w - 10, y + 28);
      ctx.lineTo(x + w - 3, y + 25);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(30,24,19,0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 30, y + 24);
      ctx.lineTo(x + 38, y + 40);
      ctx.lineTo(x + 30, y + 56);
      ctx.lineTo(x + 42, y + 74);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x + 70, y + 18);
      ctx.lineTo(x + 58, y + 36);
      ctx.lineTo(x + 66, y + 52);
      ctx.lineTo(x + 54, y + 72);
      ctx.stroke();

      ctx.fillStyle = "#68615a";
      ctx.beginPath();
      ctx.ellipse(x + 22, y + 76, 10, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#76706a";
      ctx.beginPath();
      ctx.ellipse(x + 48, y + 67, 13, 6, 0.28, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#5f8053";
      ctx.beginPath();
      ctx.ellipse(x + 34, y + 84, 8, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x + 68, y + 83, 7, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(0,0,0,0.08)";
      ctx.fillRect(x, y + 10, w, h - 10);
    }

    drawBrokenColumn(x, y, w, h, color) {
      shapesBrokenColumn(this.ctx, x, y, w, h, color);
    }

    // Draw a single "macro-pixel" (filled rectangle) — the building block for pixel art.
    _px(ctx, x, y, px, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, px, px);
    }

    // Pixel-art unit renderer. sz = cell size in screen pixels.
    drawPixelUnit(ctx, unit, ox, oy, sz) {
      const p1 = unit.player === 1;
      // Colour palettes: blue team vs red team
      const body  = p1 ? '#3399ff' : '#ff4444';
      const dark  = p1 ? '#1155aa' : '#aa1111';
      const light = p1 ? '#99ccff' : '#ffaaaa';
      const metal = '#c8c8d0';
      const darkMetal = '#606070';
      const skin  = '#f5c88a';
      const black = '#111111';

      // Map logical 8×8 grid onto sz×sz pixels
      const px = sz / 8;     // one logical pixel = px real pixels
      const f  = (lx, ly, lw, lh, col) => {
        ctx.fillStyle = col;
        ctx.fillRect(ox + lx * px, oy + ly * px, lw * px, lh * px);
      };

      if (unit.type === 'knight') {
        // Knight: broad figure, heavy armour, sword — very visible
        // Black outline fill first
        f(1, 0, 6, 8, black);
        // Helmet (full head protection — wide and bright)
        f(2, 0, 4, 1, metal);   // visor top
        f(1, 1, 6, 2, metal);   // helmet wide
        f(2, 2, 4, 1, dark);    // visor slit
        // Body armour
        f(1, 3, 6, 3, body);    // torso (bright team colour)
        f(2, 3, 4, 3, light);   // chest highlight
        f(1, 4, 1, 2, dark);    // left shoulder pad
        f(6, 4, 1, 2, dark);    // right shoulder pad
        // Shield (left side, distinct rectangle)
        f(0, 3, 2, 3, metal);
        f(0, 4, 2, 1, dark);    // shield emblem
        // Sword (right side, bright)
        f(7, 2, 1, 4, metal);
        f(6, 3, 1, 1, darkMetal); // crossguard
        // Legs
        f(2, 6, 2, 2, dark);
        f(4, 6, 2, 2, dark);

      } else if (unit.type === 'cavalry') {
        // Cavalry: wide horse base, rider on top
        // Horse body (bottom half)
        f(0, 5, 8, 3, '#8B5E3C');
        f(1, 4, 6, 2, '#A0733A');  // horse back
        f(0, 7, 2, 1, '#6B4020'); // front legs
        f(6, 7, 2, 1, '#6B4020'); // back legs
        // Rider torso
        f(2, 2, 4, 3, body);
        f(3, 2, 2, 3, light);
        // Rider head
        f(3, 0, 2, 2, metal);   // helmet
        f(2, 1, 4, 1, dark);    // visor
        // Lance
        f(7, 0, 1, 5, '#c8a050');
        f(7, 0, 1, 1, metal);   // lance tip
        // Shield
        f(0, 3, 2, 2, metal);
        f(0, 3, 1, 1, dark);

      } else {
        // Archer: slim figure, bow on side
        // Outline
        f(2, 0, 4, 8, black);
        // Hood/head
        f(2, 0, 4, 1, dark);
        f(3, 0, 2, 2, dark);
        f(3, 1, 2, 1, skin);    // face
        // Tunic body
        f(2, 2, 4, 3, body);
        f(3, 2, 2, 3, light);
        // Legs
        f(2, 5, 1, 3, dark);
        f(4, 5, 1, 3, dark);
        // Bow (left side, curved via rects)
        f(1, 1, 1, 6, '#8B6020');  // bow stave
        f(0, 1, 1, 1, '#c8a050');  // top curve
        f(0, 6, 1, 1, '#c8a050');  // bottom curve
        // Arrow nocked
        f(1, 3, 4, 1, metal);
        f(4, 3, 2, 1, body);      // arrow feathers
        // Quiver on back
        f(6, 2, 1, 3, dark);
        f(7, 2, 1, 1, metal);     // arrow tip showing
      }

      // Team colour dot top-right for quick identification
      f(6, 0, 2, 2, body);
      f(7, 0, 1, 1, light);
    }

    drawUnit(unit) {
      const ctx = this.ctx;

      // Use visual position for smooth animation; apply moveArcY vertical hop
      const arcOffsetY = (unit.moveArcY || 0) * CELL_SIZE;
      const baseX = unit.visualCol * CELL_SIZE;
      const baseY = unit.visualRow * CELL_SIZE - arcOffsetY;

      ctx.save();
      ctx.translate(baseX, baseY);

      // Death animation overlay
      if (unit.dying) {
        const progress = unit.deathProgress / unit.deathDuration;

        // Fade out the unit
        ctx.globalAlpha = Math.max(0, 1 - progress * 1.5);

        // Scale down slightly
        const scale = 1 - progress * 0.3;
        ctx.translate(CELL_SIZE / 2, CELL_SIZE / 2);
        ctx.scale(scale, scale);
        ctx.translate(-CELL_SIZE / 2, -CELL_SIZE / 2);
      } else {
        // Anim #1: selection bounce — scale pulse centred on cell
        const bs = unit.bounceScale;
        if (bs !== 1) {
          ctx.translate(CELL_SIZE / 2, CELL_SIZE / 2);
          ctx.scale(bs, bs);
          ctx.translate(-CELL_SIZE / 2, -CELL_SIZE / 2);
        }
      }

      if (unit.type === "cavalry") {
        this.drawMountedComposite(ctx, unit, 0, 0, CELL_SIZE, CELL_SIZE);
      } else {
        const sprite = this.assets.get(this.spriteKeyForUnit(unit));
        const frame = UNIT_TYPES[unit.type].frame;
        const frameIndex = this.frameIndexForUnit(unit);
        if (sprite) {
          ctx.drawImage(sprite, frame * frameIndex, 0, frame, frame, 0, 0, CELL_SIZE, CELL_SIZE);
        } else {
          ctx.fillStyle = unit.player === 1 ? COLORS.p1 : COLORS.p2;
          ctx.fillRect(3, 3, CELL_SIZE - 6, CELL_SIZE - 6);
          ctx.fillStyle = "#fff";
          ctx.font = "bold " + Math.round(CELL_SIZE * 0.56) + "px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(UNIT_TYPES[unit.type].letter, CELL_SIZE / 2, CELL_SIZE / 2);
        }
      }
      
      ctx.restore();

      // Anim #5: hit flash — white overlay for N frames on damage
      if (unit.hitFlash > 0 && !unit.dying) {
        const flashAlpha = (unit.hitFlash / 8) * 0.6;
        ctx.save();
        ctx.globalAlpha = flashAlpha;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(baseX, baseY, CELL_SIZE, CELL_SIZE);
        ctx.restore();
      }

      // Draw skull death animation on top
      if (unit.dying) {
        const progress = unit.deathProgress / unit.deathDuration;
        
        ctx.save();
        
        // Skull appears and floats up
        const skullAlpha = Math.sin(progress * Math.PI); // Fade in then out
        const skullY = baseY + CELL_SIZE / 2 - progress * CELL_SIZE * 0.8;
        const skullSize = CELL_SIZE * 0.6;
        
        ctx.globalAlpha = skullAlpha * 0.9;
        ctx.translate(baseX + CELL_SIZE / 2, skullY);
        
        // Slight rotation
        ctx.rotate(Math.sin(progress * Math.PI * 4) * 0.2);
        
        // Draw skull
        this.drawSkull(ctx, -skullSize / 2, -skullSize / 2, skullSize, skullSize);
        
        ctx.restore();
      }

      // Draw overlays in original position (only if not dying)
      if (!unit.dying) {
        if (this.pendingWeaponEquip && this.weaponTargetMap.has(unit.id)) {
          const pulse = 0.35 + this.highlightPulse * 0.45;
          ctx.strokeStyle = "rgba(242, 193, 79, " + pulse.toFixed(2) + ")";
          ctx.lineWidth = 3;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(baseX + 2, baseY + 2, CELL_SIZE - 4, CELL_SIZE - 4);
          ctx.setLineDash([]);

          const badgeX = baseX + 10;
          const badgeY = baseY + 10;
          ctx.fillStyle = "rgba(242, 193, 79, 0.95)";
          ctx.beginPath();
          ctx.arc(badgeX, badgeY, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(60, 45, 20, 0.9)";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = "#2b1f12";
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("+", badgeX, badgeY + 0.5);
        }

        if (unit.id === this.previewUnitId) {
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 3;
          ctx.strokeRect(baseX + 3, baseY + 3, CELL_SIZE - 6, CELL_SIZE - 6);
        }

        const barWidth = CELL_SIZE - 6;
        const hpY = baseY + CELL_SIZE - 8;
        const armorY = hpY - 5;

        ctx.fillStyle = "#141414";
        ctx.fillRect(baseX + 3, armorY, barWidth, 4);
        ctx.fillRect(baseX + 3, hpY, barWidth, 4);

        const hpRatio = unit.maxHp > 0 ? Math.max(0, unit.hp) / unit.maxHp : 0;

        ctx.fillStyle = "#2ed14e";
        ctx.fillRect(baseX + 3, hpY, barWidth * hpRatio, 4);

        // The mage has no armor (see UNIT_TYPES) — show its energy (spent on
        // all 4 abilities) in that top bar slot instead, so energy is visible
        // on the board at a glance without opening its ability panel.
        if (unit.type === 'mage') {
          const energyRatio = unit.maxEnergy > 0 ? Math.max(0, unit.energy) / unit.maxEnergy : 0;
          ctx.fillStyle = "#a855f7";
          ctx.fillRect(baseX + 3, armorY, barWidth * energyRatio, 4);
        } else {
          const armorRatio = unit.maxArmor > 0 ? Math.max(0, unit.armor) / unit.maxArmor : 0;
          ctx.fillStyle = "#4f91ff";
          ctx.fillRect(baseX + 3, armorY, barWidth * armorRatio, 4);
        }

        if (unit.done && unit.player === this.currentPlayer) {
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fillRect(baseX, baseY, CELL_SIZE, CELL_SIZE);
        }

        if (this.selectedUnit && this.selectedUnit.id === unit.id) {
          ctx.strokeStyle = COLORS.selected;
          ctx.lineWidth = 3;
          ctx.strokeRect(baseX + 1, baseY + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        }

        if (unit.weapon && unit.weapon.icon) {
          const iconKey = unit.weapon.icon;
          const iconImg = this.assets.get(iconKey);
          const iconSize = 16;
          const iconX = baseX + CELL_SIZE - iconSize - 3;
          const iconY = baseY + 3;
          if (iconImg) {
            ctx.drawImage(iconImg, iconX, iconY, iconSize, iconSize);
          } else {
            ctx.fillStyle = "#fff";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "right";
            ctx.textBaseline = "top";
            ctx.fillText(String(iconKey), baseX + CELL_SIZE - 4, baseY + 2);
          }
        }

        if (unit.armorGear) {
          const iconImg = unit.armorGear.icon ? this.assets.get(unit.armorGear.icon) : null;
          const iconSize = 16;
          const iconX = baseX + CELL_SIZE - iconSize - 3;
          const iconY = baseY + CELL_SIZE - iconSize - 3;
          if (iconImg) {
            ctx.drawImage(iconImg, iconX, iconY, iconSize, iconSize);
          } else {
            ctx.fillStyle = "#9ec5ff";
            ctx.font = "13px serif";
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            ctx.fillText("🛡", baseX + CELL_SIZE - 3, baseY + CELL_SIZE - 2);
          }
        }
      }
    }
    
    drawSkull(ctx, x, y, w, h) {
      // Draw white skull icon with shadow
      ctx.save();
      
      // Shadow
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.beginPath();
      const shadowOffset = w * 0.05;
      const headWidth = w * 0.7;
      const headHeight = h * 0.6;
      const headX = x + (w - headWidth) / 2;
      const headY = y + h * 0.1;
      ctx.ellipse(headX + headWidth / 2 + shadowOffset, headY + headHeight / 2 + shadowOffset, headWidth / 2, headHeight / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      
      // Skull head (rounded rectangle)
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      
      ctx.beginPath();
      ctx.ellipse(headX + headWidth / 2, headY + headHeight / 2, headWidth / 2, headHeight / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      
      // Eye sockets (black with gradient)
      const eyeSize = w * 0.15;
      const eyeY = headY + headHeight * 0.35;
      
      // Left eye socket
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.ellipse(headX + headWidth * 0.3, eyeY, eyeSize * 0.8, eyeSize, 0, 0, Math.PI * 2);
      ctx.fill();
      
      // Eye highlight
      ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
      ctx.beginPath();
      ctx.ellipse(headX + headWidth * 0.28, eyeY - eyeSize * 0.2, eyeSize * 0.3, eyeSize * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      
      // Right eye socket
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.ellipse(headX + headWidth * 0.7, eyeY, eyeSize * 0.8, eyeSize, 0, 0, Math.PI * 2);
      ctx.fill();
      
      // Eye highlight
      ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
      ctx.beginPath();
      ctx.ellipse(headX + headWidth * 0.68, eyeY - eyeSize * 0.2, eyeSize * 0.3, eyeSize * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      
      // Nose (triangle)
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.moveTo(headX + headWidth / 2, headY + headHeight * 0.55);
      ctx.lineTo(headX + headWidth / 2 - eyeSize * 0.4, headY + headHeight * 0.75);
      ctx.lineTo(headX + headWidth / 2 + eyeSize * 0.4, headY + headHeight * 0.75);
      ctx.closePath();
      ctx.fill();
      
      // Teeth (detailed lines)
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      const teethY = headY + headHeight * 0.85;
      const teethWidth = headWidth * 0.5;
      const teethX = headX + (headWidth - teethWidth) / 2;
      
      // Upper teeth
      for (let i = 0; i < 5; i++) {
        const tx = teethX + (teethWidth / 4) * i;
        ctx.beginPath();
        ctx.moveTo(tx, teethY);
        ctx.lineTo(tx, teethY + h * 0.06);
        ctx.stroke();
      }
      
      // Jaw
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      const jawWidth = headWidth * 0.6;
      const jawHeight = h * 0.2;
      const jawX = headX + (headWidth - jawWidth) / 2;
      const jawY = y + h * 0.7;
      
      ctx.beginPath();
      ctx.arc(jawX + jawWidth / 2, jawY, jawWidth / 2, 0, Math.PI);
      ctx.fill();
      ctx.stroke();
      
      // Lower teeth
      const lowerTeethY = jawY;
      const lowerTeethWidth = jawWidth * 0.7;
      const lowerTeethX = jawX + (jawWidth - lowerTeethWidth) / 2;
      
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const tx = lowerTeethX + (lowerTeethWidth / 4) * i;
        ctx.beginPath();
        ctx.moveTo(tx, lowerTeethY);
        ctx.lineTo(tx, lowerTeethY + h * 0.06);
        ctx.stroke();
      }
      
      // Cracks on skull for detail
      ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
      ctx.lineWidth = 1;
      
      ctx.beginPath();
      ctx.moveTo(headX + headWidth * 0.2, headY + headHeight * 0.15);
      ctx.lineTo(headX + headWidth * 0.3, headY + headHeight * 0.05);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(headX + headWidth * 0.8, headY + headHeight * 0.2);
      ctx.lineTo(headX + headWidth * 0.75, headY + headHeight * 0.08);
      ctx.stroke();
      
      ctx.restore();
    }

    drawLoadingCanvas() {
      const ctx = this.ctx;
      ctx.fillStyle = "#0e0e0e";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = "#f0d28d";
      ctx.font = "bold 28px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tr("Загрузка..."), WIDTH / 2, HEIGHT / 2 - 32);

      const st = this.assets.stats();
      ctx.font = "16px sans-serif";
      ctx.fillStyle = "#c9b48a";
      ctx.fillText(st.resolved + " / " + st.pending, WIDTH / 2, HEIGHT / 2 + 4);

      // progress bar
      const barW = 200, barH = 10;
      const barX = (WIDTH - barW) / 2, barY = HEIGHT / 2 + 24;
      ctx.fillStyle = "#2a2218";
      ctx.beginPath();
      ctx.roundRect(barX, barY, barW, barH, 5);
      ctx.fill();
      const pct = st.pending > 0 ? st.resolved / st.pending : 1;
      const fillW = Math.max(6, Math.floor(barW * pct));
      const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      grad.addColorStop(0, "#8b7355");
      grad.addColorStop(1, "#ffd700");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(barX, barY, fillW, barH, 5);
      ctx.fill();

      ctx.strokeStyle = COLORS.grid;
      ctx.strokeRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1);
    }

    // ANIMATION METHODS
    
    createParticle(x, y, color, vx = 0, vy = -2, life = 30) {
      fxCreateParticle(this.particles, x, y, color, vx, vy, life);
    }

    createExplosion(x, y, color, count = 8) {
      fxCreateExplosion(this.particles, x, y, color, count);
    }

    createFloatingText(text, x, y, color = "#fff", size = 16) {
      fxCreateFloatingText(this.floatingTexts, text, x, y, color, size);
    }
    
    // Анимация слияния артефактов
    playArtifactMergeAnimation(recipe, targetElement) {
      if (!recipe || !targetElement) return;
      
      // Создаем контейнер для анимации
      let container = document.getElementById('artifact-merge-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'artifact-merge-container';
        container.className = 'artifact-merge-container';
        document.body.appendChild(container);
      }
      
      // Получаем позицию целевого элемента (кнопки создания)
      const targetRect = targetElement.getBoundingClientRect();
      const targetX = targetRect.left + targetRect.width / 2;
      const targetY = targetRect.top + targetRect.height / 2;
      
      // Получаем все элементы артефактов из инвентаря
      const inventoryRows = document.querySelectorAll('.inventory-row.has');
      const artifactElements = [];
      
      inventoryRows.forEach(row => {
        const icon = row.querySelector('.artifact-icon');
        if (icon) {
          const artifactName = icon.alt;
          if (recipe[artifactName] && recipe[artifactName] > 0) {
            artifactElements.push({ icon, name: artifactName, count: recipe[artifactName] });
          }
        }
      });
      
      // Создаем частицы для каждого артефакта
      artifactElements.forEach(({ icon, name, count }) => {
        const iconRect = icon.getBoundingClientRect();
        const startX = iconRect.left + iconRect.width / 2;
        const startY = iconRect.top + iconRect.height / 2;
        
        // Создаем несколько частиц для каждого типа артефакта
        for (let i = 0; i < count; i++) {
          const particle = document.createElement('img');
          particle.src = icon.src;
          particle.className = 'artifact-particle';
          
          // Устанавливаем начальную позицию
          particle.style.left = startX + 'px';
          particle.style.top = startY + 'px';
          
          // Добавляем небольшое случайное смещение для множественных частиц
          const offsetX = (Math.random() - 0.5) * 30;
          const offsetY = (Math.random() - 0.5) * 30;
          
          // Вычисляем смещение к цели
          const dx = targetX - startX + offsetX;
          const dy = targetY - startY + offsetY;
          
          particle.style.setProperty('--tx', dx + 'px');
          particle.style.setProperty('--ty', dy + 'px');
          
          // Добавляем задержку для создания волнового эффекта
          particle.style.animationDelay = (i * 0.1) + 's';
          
          container.appendChild(particle);
          
          // Удаляем частицу после анимации
          setTimeout(() => {
            if (particle.parentNode) {
              particle.parentNode.removeChild(particle);
            }
          }, 1300 + (i * 100));
        }
      });
      
      // Создаем вспышку в конечной точке
      const flash = document.createElement('div');
      flash.className = 'artifact-flash';
      flash.style.left = targetX + 'px';
      flash.style.top = targetY + 'px';
      container.appendChild(flash);
      
      // Удаляем вспышку после анимации
      setTimeout(() => {
        if (flash.parentNode) {
          flash.parentNode.removeChild(flash);
        }
      }, 1500);
      
      // Очищаем контейнер через некоторое время
      setTimeout(() => {
        if (container && container.parentNode && container.children.length === 0) {
          container.parentNode.removeChild(container);
        }
      }, 2000);
    }
    
    updateAnimations() {
      this.frameCount++;
      this.highlightPulse = Math.sin(this.frameCount * 0.05) * 0.3 + 0.7; // Slower pulse
      
      // Update camera shake
      if (this.cameraShake > 0) {
        this.cameraShakeX = (Math.random() - 0.5) * this.cameraShake;
        this.cameraShakeY = (Math.random() - 0.5) * this.cameraShake;
        this.cameraShake *= 0.8; // Decay
        if (this.cameraShake < 0.5) {
          this.cameraShake = 0;
          this.cameraShakeX = 0;
          this.cameraShakeY = 0;
        }
      }
      
      // Update unit movements and deaths
      this.board.units.forEach(u => u.updateMovement());
      
      // Update particles + floating texts (logic in render/fx).
      this.particles = fxUpdateParticles(this.particles);
      this.floatingTexts = fxUpdateFloatingTexts(this.floatingTexts);

      // Anim #4: arrow projectiles
      this.arrowProjectiles = fxUpdateArrows(this.arrowProjectiles);

      // Anim #13: board fade-in (0 → 1 over ~40 frames)
      if (this.boardFadeIn < 1) {
        this.boardFadeIn = Math.min(1, this.boardFadeIn + 0.025);
      }

      // Anim #7: turn-end radial wave (1 → 0 over ~30 frames)
      if (this.turnEndWave > 0) {
        this.turnEndWave = Math.max(0, this.turnEndWave - 0.033);
      }

      // Anim #10: tower flash decay
      if (this.towerFlashTimer > 0) {
        this.towerFlashTimer = Math.max(0, this.towerFlashTimer - 0.04);
      }
    }

    drawParticles() {
      fxDrawParticles(this.ctx, this.particles);
    }

    drawFloatingTexts() {
      fxDrawFloatingTexts(this.ctx, this.floatingTexts);
    }

    // P0 damage forecast: for the selected unit, draw the predicted damage on
    // every attackable target ("-N", or "☠ N" if the hit is lethal). Uses the
    // same pure attackDamage() that performAttack uses, so forecast == actual.
    drawAttackForecast(ctx) {
      if (!this.selectedUnit || !this.attackMap || this.attackMap.size === 0) return;
      const combatCtx = {
        damageBuff: this.damageBuff,
        shieldTurns: this.shieldTurns,
        attackerOnTower: this.board.isTower(this.selectedUnit.row, this.selectedUnit.col),
      };
      const seen = new Set();
      const drawForecast = (row, col, target, allowAlly) => {
        const tkey = row + "," + col;
        if (seen.has(tkey)) return;
        seen.add(tkey);
        if (!target) return;
        const friendly = target.player === this.selectedUnit.player;
        if (friendly && !allowAlly) return;
        const dmg = attackDamage(this.selectedUnit, target, combatCtx);
        const hpLoss = Math.max(0, dmg - target.armor);
        const kill = target.hp - hpLoss <= 0;
        const cx = col * CELL_SIZE + CELL_SIZE / 2;
        const cy = row * CELL_SIZE + CELL_SIZE / 2;
        const label = kill ? "☠ " + dmg : "-" + dmg;
        ctx.save();
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const w = ctx.measureText(label).width + 14;
        const h = 20;
        const bx = cx - w / 2;
        const by = cy - h / 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 6);
        else ctx.rect(bx, by, w, h);
        ctx.fillStyle = kill ? "rgba(150,24,24,0.92)" : friendly ? "rgba(150,96,10,0.92)" : "rgba(18,11,7,0.86)";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = kill ? "#ff8a8a" : friendly ? "#ffb040" : "#e35757";
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.fillText(label, cx, cy);
        ctx.restore();
      };

      this.attackMap.forEach((a) => {
        if (a.mode === "pierce") {
          // Forecast every cell on the line, including a friendly one — the
          // whole point is to see this hit before committing to it.
          const line = a.targets && a.targets.length ? a.targets : [{ row: a.targetRow, col: a.targetCol }];
          line.forEach((cell) => drawForecast(cell.row, cell.col, this.board.unitAt(cell.row, cell.col), true));
          return;
        }
        drawForecast(a.targetRow, a.targetCol, this.board.unitAt(a.targetRow, a.targetCol), false);
      });
    }

    // P0 threat overlay: when toggled on, mark every cell the enemy can attack
    // from its current position. Uses generateAttackActions (pure) per enemy
    // unit. Rendered with a translucent fill PLUS a diagonal hatch so it reads
    // as "danger" without relying on colour alone (colour-blind friendly) and
    // stays distinct from the player's own green/red highlights.
    /**
     * Reach preview for the tapped (previewed) unit — shown without spending a
     * move, so a player can inspect any unit before committing.
     *
     * Ranged units (archer/crossbow/catapult) get their whole firing square,
     * which now depends on whether they stand on a tower. Melee units get every
     * enemy they could reach and strike this turn (walk-up victims), computed by
     * flood-filling the cells they can afford to move to and testing adjacency.
     */
    drawReachPreview(ctx) {
      const unit = this.getPreviewUnit();
      if (!unit) return;

      const zone = [];
      const victims = [];
      const allyHits = [];
      const ranged = unit.type === "archer" || unit.type === "crossbow" || unit.type === "catapult";

      if (unit.type === "crossbow") {
        // Piercing bolt: 8 straight lines, 2 cells deep. Hits friend or foe,
        // so an occupied cell on the line is flagged as a victim OR an ally
        // hit depending who's standing there.
        const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
        dirs.forEach(([dr, dc]) => {
          for (let step = 1; step <= CROSSBOW_PIERCE_RANGE; step++) {
            const r = unit.row + dr * step, c = unit.col + dc * step;
            if (!insideBoard(r, c)) break;
            zone.push([r, c]);
            const occupant = this.board.unitAt(r, c);
            if (occupant && occupant.player !== unit.player) victims.push([r, c]);
            else if (occupant) allyHits.push([r, c]);
          }
        });
      } else if (ranged) {
        const onTower = this.board.isTower(unit.row, unit.col);
        if (unit.type === "catapult") {
          const maxR = catapultMaxRangeFor(onTower);
          for (let dr = -maxR; dr <= maxR; dr++) {
            for (let dc = -maxR; dc <= maxR; dc++) {
              const dist = Math.abs(dr) + Math.abs(dc);
              if (dist < CATAPULT_MIN_RANGE || dist > maxR) continue;
              const r = unit.row + dr, c = unit.col + dc;
              if (!insideBoard(r, c)) continue;
              zone.push([r, c]);
              const foe = this.board.unitAt(r, c);
              const isBridge = getTerrain().some((t) => t.row === r && t.col === c && t.type === "bridge");
              if ((foe && foe.player !== unit.player) || isBridge) victims.push([r, c]);
            }
          }
        } else {
          const rad = archerRadiusFor(onTower);
          for (let dr = -rad; dr <= rad; dr++) {
            for (let dc = -rad; dc <= rad; dc++) {
              if (dr === 0 && dc === 0) continue;
              const r = unit.row + dr, c = unit.col + dc;
              if (!insideBoard(r, c)) continue;
              zone.push([r, c]);
              const foe = this.board.unitAt(r, c);
              if (foe && foe.player !== unit.player) victims.push([r, c]);
            }
          }
        }
      } else {
        // Melee: every enemy adjacent to a cell this unit can afford to reach.
        // Cavalry strikes from 1 cell away after moving; knights/samurai too.
        const reachable = [[unit.row, unit.col]];
        this.moveActionsFor(unit).forEach((m) => reachable.push([m.row, m.col]));
        const dirs = unit.type === "samurai"
          ? [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]
          : [[-1,0],[1,0],[0,-1],[0,1]];
        const seen = new Set();
        reachable.forEach(([rr, rc]) => {
          dirs.forEach(([dr, dc]) => {
            const r = rr + dr, c = rc + dc;
            if (!insideBoard(r, c)) return;
            const foe = this.board.unitAt(r, c);
            if (!foe || foe.player === unit.player) return;
            const k = r + "," + c;
            if (seen.has(k)) return;
            seen.add(k);
            victims.push([r, c]);
          });
        });
      }

      // Same red-offense/blue-danger split as attackMap and drawThreatOverlay:
      // previewing an ENEMY unit shows where it threatens (blue, "danger to
      // you"); previewing your OWN unit shows its reach in the same blue tone
      // used for reach elsewhere (the red family is reserved for actual attack
      // targets, drawn separately by drawAttackTargetMarks/drawAttackForecast).
      const foeView = unit.player !== this.currentPlayer;

      // Firing square: soft translucent wash so it reads as "reach", not "target".
      if (zone.length > 0) {
        ctx.save();
        ctx.fillStyle = foeView ? COLORS.threatFill : "rgba(120, 200, 255, 0.13)";
        ctx.strokeStyle = foeView ? COLORS.threatStroke : "rgba(150, 215, 255, 0.35)";
        ctx.lineWidth = 1;
        zone.forEach(([r, c]) => {
          const x = c * CELL_SIZE, y = r * CELL_SIZE;
          ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
          ctx.strokeRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
        });
        ctx.restore();
      }

      // Victims: pulsing ring so reachable enemies pop out of the zone wash.
      if (victims.length > 0) {
        const pulse = 0.55 + 0.25 * Math.sin(this.frameCount * 0.12);
        ctx.save();
        ctx.strokeStyle = "rgba(255, 90, 70, " + pulse.toFixed(2) + ")";
        ctx.lineWidth = 3;
        victims.forEach(([r, c]) => {
          ctx.strokeRect(c * CELL_SIZE + 2, r * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        });
        ctx.restore();
      }

      // Friendly-fire warning: a unit on the crossbow's own pierce line gets
      // hit too — amber ring, distinct from the red enemy-victim ring.
      if (allyHits.length > 0) {
        const pulse = 0.55 + 0.25 * Math.sin(this.frameCount * 0.12);
        ctx.save();
        ctx.strokeStyle = "rgba(255, 176, 32, " + pulse.toFixed(2) + ")";
        ctx.lineWidth = 3;
        allyHits.forEach(([r, c]) => {
          ctx.strokeRect(c * CELL_SIZE + 2, r * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        });
        ctx.restore();
      }
    }

    /**
     * Ring every cell the selected unit can attack, drawn after the unit
     * sprites so the mark stays visible on the victim itself.
     *
     * The `attackMap` fill in the main pass goes down before units, which is
     * correct for empty landing cells (cavalry jump/L-attack) but invisible on
     * an occupied cell — the target sprite paints over it. Ranged units always
     * shoot at occupied cells, so their real target was the one cell that never
     * looked highlighted.
     */
    drawAttackTargetMarks(ctx) {
      if (!this.selectedUnit || this.attackMap.size === 0) return;

      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(this.frameCount * 0.1));
      ctx.save();
      const drawMark = (row, col) => {
        const x = col * CELL_SIZE;
        const y = row * CELL_SIZE;

        // Bright ring + corner ticks: reads as "target" over any sprite.
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255, 60, 45, " + pulse.toFixed(2) + ")";
        ctx.strokeRect(x + 2.5, y + 2.5, CELL_SIZE - 5, CELL_SIZE - 5);

        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(255, 235, 120, " + pulse.toFixed(2) + ")";
        const t = Math.max(5, Math.round(CELL_SIZE * 0.22));
        const corners = [
          [x + 2.5, y + 2.5, 1, 1],
          [x + CELL_SIZE - 2.5, y + 2.5, -1, 1],
          [x + 2.5, y + CELL_SIZE - 2.5, 1, -1],
          [x + CELL_SIZE - 2.5, y + CELL_SIZE - 2.5, -1, -1],
        ];
        for (const [cx, cy, sx, sy] of corners) {
          ctx.beginPath();
          ctx.moveTo(cx + sx * t, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + sy * t);
          ctx.stroke();
        }
      };

      this.attackMap.forEach((a) => {
        if (a.mode === "pierce") {
          // Mark every enemy cell on the line — not just the first one, since
          // a pierce shot can have a live victim on either or both cells.
          const line = a.targets && a.targets.length ? a.targets : [{ row: a.targetRow, col: a.targetCol }];
          line.forEach((cell) => {
            const occupant = this.board.unitAt(cell.row, cell.col);
            if (occupant && occupant.player !== this.selectedUnit.player) drawMark(cell.row, cell.col);
          });
          return;
        }
        // Only mark cells that actually hold a victim; empty landing cells are
        // already legible from the fill underneath.
        const victim = this.board.unitAt(a.targetRow, a.targetCol);
        if (!victim || victim.player === this.selectedUnit.player) return;
        drawMark(a.targetRow, a.targetCol);
      });
      ctx.restore();
    }

    /**
     * When a cavalry landing cell is shared by two different attacks (jump
     * over one enemy, L-attack around another — both land on the same
     * square), the click on it is held pending in `pendingAttackChoice`
     * instead of silently resolving to whichever action was generated last.
     * This draws a numbered gold marker on each candidate victim so the
     * player can click the one they actually mean.
     */
    drawPendingAttackChoice(ctx) {
      const pending = this.pendingAttackChoice;
      if (!pending) return;
      const pulse = 0.65 + 0.35 * Math.abs(Math.sin(this.frameCount * 0.15));
      ctx.save();
      pending.options.forEach((opt, i) => {
        const x = opt.targetCol * CELL_SIZE;
        const y = opt.targetRow * CELL_SIZE;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(232, 195, 91, " + pulse.toFixed(2) + ")";
        ctx.fillStyle = "rgba(232, 195, 91, 0.22)";
        ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
        ctx.strokeRect(x + 2.5, y + 2.5, CELL_SIZE - 5, CELL_SIZE - 5);

        // Numbered badge, top-left of the cell — "1", "2", ... so the choice
        // can also be read out (e.g. for a future keyboard/tap-number input).
        const r = Math.max(9, Math.round(CELL_SIZE * 0.16));
        const bx = x + r + 4;
        const by = y + r + 4;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(40, 30, 10, 0.92)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 224, 140, 0.95)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#ffe08c";
        ctx.font = "bold " + Math.round(r * 1.15) + "px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), bx, by + 1);
      });
      ctx.restore();
    }

    /**
     * Catapult siege ammo: hurl a boulder at an EMPTY cell in range. The cell
     * becomes permanent impassable `rock` terrain, so a catapult can wall off a
     * corridor or deny a bridge instead of only killing units. Costs one move.
     */
    rockTargetsFor(unit) {
      if (!unit || unit.type !== "catapult" || unit.movesLeft < 1) return [];
      const maxR = catapultMaxRangeFor(this.board.isTower(unit.row, unit.col));
      const out = [];
      for (let dr = -maxR; dr <= maxR; dr++) {
        for (let dc = -maxR; dc <= maxR; dc++) {
          const dist = Math.abs(dr) + Math.abs(dc);
          if (dist < CATAPULT_MIN_RANGE || dist > maxR) continue;
          const r = unit.row + dr, c = unit.col + dc;
          if (!insideBoard(r, c)) continue;
          // Empty ground only. Rivers and bridges are explicitly off-limits:
          // damming water or destroying a crossing would wreck map connectivity
          // (bridges are often the single route between halves of the board).
          if (this.board.unitAt(r, c)) continue;
          if (this.board.isTower(r, c)) continue;
          if (
            getTerrain().some(
              (t) =>
                t.row === r &&
                t.col === c &&
                (t.type === "river" || t.type === "bridge" || t.type === "mountain"),
            )
          )
            continue;
          // Castle footprints stay clear too.
          if (this.isInsideCastleZone(r, c)) continue;
          out.push({ row: r, col: c });
        }
      }
      return out;
    }

    /**
     * True when (row,col) is inside a castle footprint OR in the approach strip
     * directly in front of its gate. Boulders are banned from both: sealing the
     * doorway would trap the defender's army in its own keep with no counter.
     */
    isInsideCastleZone(row, col) {
      const APPROACH = 2; // rows of clearance kept open in front of each gate
      const cols = [getCastleP1Col(), getCastleP2Col()];
      return cols.some(
        (cc) =>
          col >= cc &&
          col < cc + 4 &&
          (row < 5 + APPROACH || row >= ROWS - 5 - APPROACH),
      );
    }

    /** Enter/leave rock-throwing aim mode for the selected catapult. */
    toggleRockMode() {
      if (!this.selectedUnit || this.selectedUnit.type !== "catapult") return false;
      this.rockMode = !this.rockMode;
      this.rockTargets = this.rockMode ? this.rockTargetsFor(this.selectedUnit) : [];
      this.message = this.rockMode
        ? tr("Выберите пустую клетку для броска камня.")
        : "";
      this.renderSidebar();
      return true;
    }

    /**
     * Drop a boulder on (row,col) if it is a legal rock target.
     *
     * Hitting an EXISTING boulder shatters it instead of stacking: the shot
     * clears the cell back to open ground. That gives both sides a way to undo
     * a wall — a catapult can reopen a corridor its opponent sealed.
     */
    throwRock(row, col) {
      const unit = this.selectedUnit;
      if (!unit || !this.rockMode) return false;
      if (!this.rockTargets.some((t) => t.row === row && t.col === col)) return false;

      const existing = getTerrain().find(
        (t) => t.row === row && t.col === col && t.type === "rock",
      );
      if (existing) {
        // Shatter: remove the boulder, leaving passable ground.
        setTerrain(getTerrain().filter((t) => !(t.row === row && t.col === col && t.type === "rock")));
        unit.movesLeft -= 1;
        this.rockMode = false;
        this.rockTargets = [];
        const bx = col * CELL_SIZE + CELL_SIZE / 2;
        const by = row * CELL_SIZE + CELL_SIZE / 2;
        fxCreateArrow(
          this.arrowProjectiles,
          unit.col * CELL_SIZE + CELL_SIZE / 2,
          unit.row * CELL_SIZE + CELL_SIZE / 2,
          bx, by, "#b8b0a4",
        );
        this.createExplosion(bx, by, "#cfc6b8", 14);
        this.cameraShake = 11;
        this.lastEvent = tr("{name} разбил камень — проход открыт.", {
          name: this.trName(unit.name),
        });
        if (unit.movesLeft <= 0) this.finishSelectedUnit();
        else { this.rebuildHighlights(); this.renderSidebar(); }
        return true;
      }

      setTerrain([...getTerrain(), { row, col, type: "rock" }]);
      unit.movesLeft -= 1;
      this.rockMode = false;
      this.rockTargets = [];

      const fromX = unit.col * CELL_SIZE + CELL_SIZE / 2;
      const fromY = unit.row * CELL_SIZE + CELL_SIZE / 2;
      const toX = col * CELL_SIZE + CELL_SIZE / 2;
      const toY = row * CELL_SIZE + CELL_SIZE / 2;
      fxCreateArrow(this.arrowProjectiles, fromX, fromY, toX, toY, "#b8b0a4");
      this.createExplosion(toX, toY, "#9a9086", 10);
      this.cameraShake = 9;
      this.lastEvent = tr("{name} обрушил камень — клетка завалена.", {
        name: this.trName(unit.name),
      });

      if (unit.movesLeft <= 0) this.finishSelectedUnit();
      else { this.rebuildHighlights(); this.renderSidebar(); }
      return true;
    }

    /**
     * The mage's HTML control panel — energy bar plus one button per ability.
     * A button is disabled (but still shown, so the player can see it exists
     * and why it's out of reach) whenever nothing affordable is on the board
     * for it right now. Mirrors the castle-heal card's styling.
     */
    renderMagePanel(u) {
      const targetableCount = (kind) => this.mageTargetsFor(u, kind).length;
      const canAttack = targetableCount('attack') > 0;
      const canDrain = targetableCount('drain') > 0;
      const canHeal = targetableCount('heal') > 0;
      const canBurnBridge = targetableCount('burn-bridge') > 0;
      const wardAllies = this.board.units.filter((o) => o.player === u.player && o.alive());
      const canWard = wardAllies.length > 0; // free to apply — see confirmMageWard

      let html = '<div class="card mage-panel" style="background: rgba(160, 90, 220, 0.15); border: 2px solid #a05adc; margin-top: 8px;">';
      // Energy bar — same visual language as an HP bar, not bare text.
      const energyPct = u.maxEnergy > 0 ? Math.max(0, Math.min(100, (u.energy / u.maxEnergy) * 100)) : 0;
      html += '<div class="hint" style="margin-bottom:2px">⚡ ' + u.energy + '/' + u.maxEnergy + '</div>';
      html += '<div style="background:rgba(0,0,0,0.35); border-radius:4px; height:8px; overflow:hidden; margin-bottom:6px;">' +
        '<div style="width:' + energyPct.toFixed(1) + '%; height:100%; background:linear-gradient(90deg,#7d4fd6,#c77dff); transition:width 0.2s;"></div>' +
        '</div>';

      const btn = (mode, active, label, enabled, hint) =>
        '<button class="btn' + (active ? '' : ' secondary') + '" data-action="' + mode + '" ' +
        (enabled ? '' : 'disabled title="' + this.escape(hint) + '"') + '>' + label + '</button>';

      html += btn('mage-attack-mode', this.mageMode === 'attack', '🔥 ' + tr('Атака'), canAttack,
        tr('Нет доступных целей в пределах энергии.'));
      html += btn('mage-drain-mode', this.mageMode === 'drain', '🩸 ' + tr('Высасывание'), canDrain,
        tr('Нужна соседняя незащищённая цель (более 1 HP).'));
      html += btn('mage-heal-mode', this.mageMode === 'heal', '💚 ' + tr('Лечение'), canHeal,
        tr('Нет раненых союзников в пределах энергии.'));
      html += btn('mage-ward-mode', this.mageMode === 'ward', '🛡️ ' + tr('Щит'), canWard,
        tr('Нет живых союзников.'));
      html += btn('mage-burn-bridge-mode', this.mageMode === 'burn-bridge', '🌉🔥 ' + tr('Сжечь мост'), canBurnBridge,
        tr('Нет моста в пределах энергии.'));

      if (this.mageMode && this.mageMode !== 'ward' && !(this.mageMode === 'attack' && this.pendingMageAttack)) {
        const hints = {
          attack: tr('Выберите вражеского юнита для атаки — урон выбирается после клика (1⚡ = 1 урон, плюс 1⚡ за клетку расстояния).'),
          drain: tr('Выберите соседнего юнита, чтобы забрать 1 HP и получить {n}⚡.', { n: MAGE_DRAIN_ENERGY_PER_HP }),
          heal: tr('Выберите раненого союзника (или себя) — 1 HP = 1⚡, плюс 1⚡ за клетку расстояния.'),
          'burn-bridge': tr('Выберите мост, чтобы сжечь его (2⚡ за клетку расстояния).'),
        };
        html += '<div class="hint" style="margin-top:4px">' + hints[this.mageMode] + '</div>';
      }

      if (this.mageMode === 'ward') {
        html += this.renderMageWardPicker(u, wardAllies);
      }

      if (this.mageMode === 'attack' && this.pendingMageAttack) {
        html += this.renderMageAttackDamagePicker(u, this.pendingMageAttack);
      }

      html += '</div>';
      return html;
    }

    /**
     * mage-attack's damage picker — shown once a target is clicked (see
     * pickMageAttackTarget). +/- buttons step the amount (no range input,
     * this codebase's sidebar only wires up click delegation, see
     * stepMageAttackDamage), a live cost readout, and Confirm/Cancel.
     */
    renderMageAttackDamagePicker(mage, pending) {
      const target = this.board.unitAt(pending.row, pending.col);
      const cost = pending.damage * MAGE_ATTACK_ENERGY_PER_HP + pending.distCost;
      let html = '<div class="hint" style="margin-top:6px">' +
        tr('Урон по {target}:', { target: target ? this.trName(target.name) : '?' }) + '</div>';
      html += '<div style="display:flex; align-items:center; gap:8px; margin:6px 0;">';
      html += '<button class="btn secondary" data-action="mage-attack-damage-step" data-step="-1" ' +
        (pending.damage <= 1 ? 'disabled' : '') + '>−</button>';
      html += '<span style="font-size:1.2em; font-weight:bold; min-width:2.5em; text-align:center;">' + pending.damage + '</span>';
      html += '<button class="btn secondary" data-action="mage-attack-damage-step" data-step="1" ' +
        (pending.damage >= pending.maxDamage ? 'disabled' : '') + '>+</button>';
      html += '</div>';
      html += '<div class="hint">⚡ ' + tr('Стоимость') + ': ' + cost + ' (' + pending.damage + '+' + pending.distCost + ')</div>';
      html += '<div style="display:flex; gap:8px; margin-top:6px;">';
      html += '<button class="btn" data-action="mage-attack-confirm">✅ ' + tr('Подтвердить') + '</button>';
      html += '<button class="btn secondary" data-action="mage-attack-cancel">✖ ' + tr('Отмена') + '</button>';
      html += '</div>';
      return html;
    }

    /**
     * Ward's multi-select sub-panel: one row per living ally, click (or the
     * row itself, via data-action=mage-ward-pick) toggles it into
     * this.mageWardPicks. Shows current state (already warded / about to be
     * warded / about to be un-warded) so the pending batch is legible before
     * "Готово" commits it. Free — no energy cost shown, since applying the
     * ward itself costs nothing up front (see [[kc-mage-ward-mechanic]]).
     */
    renderMageWardPicker(mage, allies) {
      let html = '<div class="hint" style="margin-top:4px">' +
        tr('Выберите юнитов на поле или в списке, затем нажмите «Готово».') + '</div>';
      html += '<div class="ward-picker" style="max-height:160px; overflow-y:auto; margin:6px 0;">';
      allies.forEach((a) => {
        const isWarded = a.wardedBy === mage.id;
        const isWardedByOther = a.wardedBy && a.wardedBy !== mage.id;
        const picked = this.mageWardPicks.has(a.id);
        // Visual state: picked+warded = will remove; picked+unwarded = will add;
        // unpicked+warded = stays warded; unpicked+unwarded = stays unwarded.
        const willRemove = picked && isWarded;
        const willAdd = picked && !isWarded;
        let bg = 'rgba(255,255,255,0.05)';
        if (willAdd) bg = 'rgba(100,149,237,0.35)';
        else if (willRemove) bg = 'rgba(220,90,60,0.3)';
        else if (isWarded) bg = 'rgba(100,149,237,0.15)';
        html += '<button class="btn secondary" data-action="mage-ward-pick" data-unit-id="' + a.id + '" ' +
          'style="display:flex; justify-content:space-between; width:100%; margin-bottom:3px; background:' + bg + ';" ' +
          (isWardedByOther ? 'disabled title="' + this.escape(tr('Защищён другим магом.')) + '"' : '') + '>' +
          '<span>' + (isWarded ? '🛡️ ' : '') + this.escape(this.trName(a.name)) + ' #' + a.id + '</span>' +
          '<span>' + (willAdd ? '➕' : willRemove ? '➖' : isWarded ? '✓' : '') + '</span>' +
          '</button>';
      });
      html += '</div>';
      const pickCount = this.mageWardPicks.size;
      html += '<button class="btn" data-action="mage-ward-confirm" ' + (pickCount === 0 ? 'disabled' : '') + '>' +
        '✅ ' + tr('Готово') + (pickCount > 0 ? ' (' + pickCount + ')' : '') + '</button>';
      return html;
    }

    /** Enter/leave targeting mode for one of the mage's 4 aimed abilities
     * (attack/drain/heal/burn-bridge — ward has no target, see applyMageWard). */
    toggleMageMode(kind) {
      const u = this.selectedUnit;
      if (!u || u.type !== "mage" || u.movesLeft < 1) return false;
      if (this.mageMode === kind) {
        this.mageMode = null;
        this.mageTargets = [];
        this.message = "";
      } else {
        this.mageMode = kind;
        this.mageTargets = this.mageTargetsFor(u, kind);
        this.message = this.mageTargets.length
          ? tr("Выберите цель.")
          : tr("Нет доступных целей.");
      }
      this.renderSidebar();
      return true;
    }

    /**
     * Every cell `unit` (a mage) can currently afford to target with ability
     * `kind`, given its remaining energy — same cost formulas as
     * @kc/game-rules' apply.ts applyMage*() functions, kept in lockstep by
     * hand since this offline engine mutates Unit objects directly rather
     * than going through applyAction.
     */
    mageTargetsFor(unit, kind) {
      if (!unit || unit.type !== "mage" || unit.movesLeft < 1) return [];
      const energy = unit.energy || 0;
      const out = [];

      if (kind === 'attack') {
        this.board.units.forEach((o) => {
          if (!o.alive() || o.player === unit.player) return;
          const dist = Math.max(Math.abs(o.row - unit.row), Math.abs(o.col - unit.col));
          // At least 1 damage must be affordable on top of the distance cost.
          const minCost = 1 * MAGE_ATTACK_ENERGY_PER_HP + dist * MAGE_ATTACK_ENERGY_PER_CELL;
          if (energy >= minCost) out.push({ row: o.row, col: o.col, unitId: o.id });
        });
      } else if (kind === 'drain') {
        this.board.units.forEach((o) => {
          if (!o.alive() || o.id === unit.id) return;
          const dist = Math.max(Math.abs(o.row - unit.row), Math.abs(o.col - unit.col));
          if (dist > 1) return;
          if (o.hp <= 1) return;
          // Can't drain a unit warded by a DIFFERENT mage — draining one
          // THIS mage wards is allowed (it just routes through the ward).
          if (o.wardedBy && o.wardedBy !== unit.id) return;
          out.push({ row: o.row, col: o.col, unitId: o.id });
        });
      } else if (kind === 'heal') {
        this.board.units.forEach((o) => {
          if (!o.alive() || o.player !== unit.player) return;
          if (o.hp >= o.maxHp) return;
          const dist = Math.max(Math.abs(o.row - unit.row), Math.abs(o.col - unit.col));
          const cost = (o.maxHp - o.hp) * MAGE_HEAL_ENERGY_PER_HP + dist * MAGE_HEAL_ENERGY_PER_CELL;
          if (energy >= cost) out.push({ row: o.row, col: o.col, unitId: o.id });
        });
      } else if (kind === 'burn-bridge') {
        getTerrain().forEach((t) => {
          if (t.type !== 'bridge') return;
          const dist = Math.max(Math.abs(t.row - unit.row), Math.abs(t.col - unit.col));
          if (energy >= dist * MAGE_BURN_BRIDGE_ENERGY_PER_CELL) out.push({ row: t.row, col: t.col });
        });
      }
      return out;
    }

    /** Resolve a click on (row,col) while `this.mageMode` targeting is active. */
    performMageAbility(row, col) {
      const unit = this.selectedUnit;
      if (!unit || !this.mageMode) return false;
      const hit = this.mageTargets.find((t) => t.row === row && t.col === col);
      if (!hit) return false;

      switch (this.mageMode) {
        case 'attack': return this.pickMageAttackTarget(hit);
        case 'drain': return this.performMageDrain(hit);
        case 'heal': return this.performMageHeal(hit);
        case 'burn-bridge': return this.performMageBurnBridge(hit);
        default: return false;
      }
    }

    /**
     * mage-attack no longer deals a fixed amount — clicking a target opens a
     * damage picker (this.pendingMageAttack) instead of applying immediately.
     * The player then drags/enters a value in the sidebar (see
     * renderMageAttackPicker) and confirms with confirmMageAttack(). See
     * [[kc-mage-ward-mechanic]].
     */
    pickMageAttackTarget(hit) {
      const unit = this.selectedUnit;
      if (!unit) return false;
      const dist = Math.max(Math.abs(hit.row - unit.row), Math.abs(hit.col - unit.col));
      const distCost = dist * MAGE_ATTACK_ENERGY_PER_CELL;
      const maxDamage = Math.floor((unit.energy - distCost) / MAGE_ATTACK_ENERGY_PER_HP);
      if (maxDamage < 1) return false;
      this.pendingMageAttack = {
        row: hit.row, col: hit.col, unitId: hit.unitId,
        dist, distCost, maxDamage,
        damage: Math.min(MAGE_ATTACK_DAMAGE, maxDamage),
      };
      this.renderSidebar();
      return true;
    }

    /** Apply the damage amount currently set in this.pendingMageAttack. */
    confirmMageAttack() {
      const pending = this.pendingMageAttack;
      if (!pending) return false;
      const ok = this.performMageAttack(pending, pending.damage);
      this.pendingMageAttack = null;
      return ok;
    }

    /** Nudge the pending mage-attack's damage by `delta`, clamped to [1, maxDamage]. */
    stepMageAttackDamage(delta) {
      const pending = this.pendingMageAttack;
      if (!pending) return false;
      pending.damage = Math.max(1, Math.min(pending.maxDamage, pending.damage + delta));
      this.renderSidebar();
      return true;
    }

    /**
     * `chosenDamage` — the player-picked amount (>=1), from the
     * this.pendingMageAttack picker (see pickMageAttackTarget/
     * confirmMageAttack). Costs `chosenDamage * MAGE_ATTACK_ENERGY_PER_HP +
     * distance * MAGE_ATTACK_ENERGY_PER_CELL` energy — see
     * [[kc-mage-ward-mechanic]].
     */
    performMageAttack(hit, chosenDamage) {
      const unit = this.selectedUnit;
      const target = this.board.unitAt(hit.row, hit.col);
      if (!unit || !target) return false;
      const dist = Math.max(Math.abs(hit.row - unit.row), Math.abs(hit.col - unit.col));
      const dmg = Math.max(1, Math.floor(chosenDamage) || 1);
      const cost = dmg * MAGE_ATTACK_ENERGY_PER_HP + dist * MAGE_ATTACK_ENERGY_PER_CELL;
      if (unit.energy < cost) return false;

      if (this.online) {
        this.recordAction({ kind: "mage-attack", unitId: unit.id, targetRow: hit.row, targetCol: hit.col, damage: dmg });
      }

      let damage = dmg;
      if (this.damageBuff[unit.player] > 0) damage += 2;
      const warded = this.absorbWithWard(target, damage);
      if (!warded) applyDamageToTarget(target, damage);

      unit.energy -= cost;
      unit.movesLeft -= 1;
      this.mageMode = null;
      this.mageTargets = [];

      const fromX = unit.col * CELL_SIZE + CELL_SIZE / 2;
      const fromY = unit.row * CELL_SIZE + CELL_SIZE / 2;
      const toX = hit.col * CELL_SIZE + CELL_SIZE / 2;
      const toY = hit.row * CELL_SIZE + CELL_SIZE / 2;
      fxCreateArrow(this.arrowProjectiles, fromX, fromY, toX, toY, "#c77dff");
      target.triggerHitFlash();
      this.cameraShake = 8;

      if (warded) {
        this.createExplosion(toX, toY, "#6495ed", 8);
        this.createFloatingText("🛡️ 0", toX, toY - 10, "#6495ed", 20);
        this.lastEvent = tr("{attacker} поражает {target}, но щит поглощает удар!", {
          attacker: this.trName(unit.name), target: this.trName(target.name),
        });
      } else {
        this.createExplosion(toX, toY, "#c77dff", 8);
        this.createFloatingText("-" + damage, toX, toY - 10, "#c77dff", 20);
        this.lastEvent = tr("{attacker} поражает {target} магией на {dmg} урона.", {
          attacker: this.trName(unit.name), target: this.trName(target.name), dmg: damage,
        });
      }

      if (target.hp <= 0) {
        this.lastEvent += " " + tr("{name} повержен.", { name: this.trName(target.name) });
        this.dropUnitGear(target);
        target.startDeath();
        this.createExplosion(toX, toY, "#666", 8);
        this.cameraShake = 12;
      }
      this.board.removeDead((u) => this.dropUnitGear(u));

      this.checkWinner();
      if (this.winner !== null) {
        this.selectedUnit = null;
        this.clearHighlights();
        if (this.online) this.flushTurn();
        this.renderSidebar();
        return true;
      }
      if (unit.movesLeft <= 0) this.finishSelectedUnit();
      else { this.rebuildHighlights(); this.renderSidebar(); }
      return true;
    }

    /** Takes 1 hp from an adjacent unit (ally, or enemy not warded by
     * ANOTHER mage) and converts it straight to MAGE_DRAIN_ENERGY_PER_HP
     * energy. No energy cost of its own. Draining a unit THIS mage itself
     * wards is allowed but goes through the ward (absorbWithWard) instead —
     * see [[kc-mage-ward-mechanic]]. */
    performMageDrain(hit) {
      const unit = this.selectedUnit;
      const target = this.board.unitAt(hit.row, hit.col);
      if (!unit || !target || target.id === unit.id) return false;
      if (target.hp <= 1) return false;
      if (target.wardedBy && target.wardedBy !== unit.id) return false;

      if (this.online) {
        this.recordAction({ kind: "mage-drain", unitId: unit.id, targetUnitId: target.id });
      }

      const toX = hit.col * CELL_SIZE + CELL_SIZE / 2;
      const toY = hit.row * CELL_SIZE + CELL_SIZE / 2;

      const warded = this.absorbWithWard(target, 1);
      if (warded) {
        target.triggerHitFlash();
        this.createFloatingText("🛡️ 0", toX, toY - 10, "#6495ed", 18);
        this.lastEvent = tr("{attacker} пытается высосать жизнь, но щит держит.", {
          attacker: this.trName(unit.name),
        });
      } else {
        target.hp -= 1;
        unit.energy = Math.min(unit.maxEnergy, unit.energy + MAGE_DRAIN_ENERGY_PER_HP);
        target.triggerHitFlash();
        this.createFloatingText("-1 ❤️", toX, toY - 10, "#ff6b6b", 18);
        this.createFloatingText("+" + MAGE_DRAIN_ENERGY_PER_HP + " ⚡", toX, toY + 6, "#c77dff", 16);
        this.lastEvent = tr("{attacker} высасывает жизнь из {target}.", {
          attacker: this.trName(unit.name), target: this.trName(target.name),
        });
      }

      // absorbWithWard may have killed `unit` itself (draining a target it
      // wards, overdrawn) — only spend its move if it's still alive to spend it.
      if (unit.alive()) {
        unit.movesLeft -= 1;
      }
      this.mageMode = null;
      this.mageTargets = [];

      this.board.removeDead((u) => this.dropUnitGear(u));
      this.checkWinner();
      if (this.winner !== null) {
        this.selectedUnit = null;
        this.clearHighlights();
        if (this.online) this.flushTurn();
        this.renderSidebar();
        return true;
      }
      if (!unit.alive()) {
        this.selectedUnit = null;
        this.clearHighlights();
        this.renderSidebar();
        return true;
      }
      if (unit.movesLeft <= 0) this.finishSelectedUnit();
      else { this.rebuildHighlights(); this.renderSidebar(); }
      return true;
    }

    /**
     * Restores an ally (or the mage itself) to full hp. 1 HP = 1 energy —
     * distance always adds its own cost on top (1 energy per cell), so
     * healing from far away costs strictly more than healing up close.
     */
    performMageHeal(hit) {
      const unit = this.selectedUnit;
      const target = this.board.unitAt(hit.row, hit.col);
      if (!unit || !target || target.player !== unit.player) return false;
      if (target.hp >= target.maxHp) return false;

      const dist = Math.max(Math.abs(hit.row - unit.row), Math.abs(hit.col - unit.col));
      const healedHp = target.maxHp - target.hp;
      const cost = healedHp * MAGE_HEAL_ENERGY_PER_HP + dist * MAGE_HEAL_ENERGY_PER_CELL;
      if (unit.energy < cost) return false;

      if (this.online) {
        this.recordAction({ kind: "mage-heal", unitId: unit.id, targetUnitId: target.id });
      }

      target.hp = target.maxHp;
      unit.energy -= cost;
      unit.movesLeft -= 1;
      this.mageMode = null;
      this.mageTargets = [];

      const toX = hit.col * CELL_SIZE + CELL_SIZE / 2;
      const toY = hit.row * CELL_SIZE + CELL_SIZE / 2;
      this.createExplosion(toX, toY, "#67cf6f", 10);
      this.createFloatingText("+" + healedHp + " ❤️", toX, toY - 10, "#67cf6f", 20);
      this.lastEvent = tr("{caster} исцеляет {target} на {n} HP (-{cost}⚡).", {
        caster: this.trName(unit.name), target: this.trName(target.name), n: healedHp, cost,
      });

      if (unit.movesLeft <= 0) this.finishSelectedUnit();
      else { this.rebuildHighlights(); this.renderSidebar(); }
      return true;
    }

    /** Destroys a bridge outright at any distance; costs 2 energy per cell. */
    performMageBurnBridge(hit) {
      const unit = this.selectedUnit;
      if (!unit) return false;
      const dist = Math.max(Math.abs(hit.row - unit.row), Math.abs(hit.col - unit.col));
      const cost = dist * MAGE_BURN_BRIDGE_ENERGY_PER_CELL;
      if (unit.energy < cost) return false;
      const isBridge = getTerrain().some((t) => t.row === hit.row && t.col === hit.col && t.type === 'bridge');
      if (!isBridge) return false;

      if (this.online) {
        this.recordAction({ kind: "mage-burn-bridge", unitId: unit.id, row: hit.row, col: hit.col });
      }

      const key = hit.row + "," + hit.col;
      const updated = { ...getBridgeDurability() };
      delete updated[key];
      setBridgeDurability(updated);
      setTerrain(
        getTerrain()
          .filter((t) => !(t.row === hit.row && t.col === hit.col && t.type === 'bridge'))
          .concat([{ row: hit.row, col: hit.col, type: 'river' }])
      );

      unit.energy -= cost;
      unit.movesLeft -= 1;
      this.mageMode = null;
      this.mageTargets = [];

      const toX = hit.col * CELL_SIZE + CELL_SIZE / 2;
      const toY = hit.row * CELL_SIZE + CELL_SIZE / 2;
      this.createExplosion(toX, toY, "#ff8844", 12);
      this.createExplosion(toX, toY, "#ffffff", 6);
      this.cameraShake = 10;
      this.lastEvent = tr("{caster} сжигает мост дотла.", { caster: this.trName(unit.name) });

      if (unit.movesLeft <= 0) this.finishSelectedUnit();
      else { this.rebuildHighlights(); this.renderSidebar(); }
      return true;
    }

    /**
     * Ward is per-unit (see [[kc-mage-ward-mechanic]]), not a side-wide buff:
     * `unit.wardedBy` holds the id of the mage currently shielding it, or
     * null. No energy is spent up front — see absorbWithWard for the
     * reactive drain that happens when a warded unit is actually hit.
     *
     * UI flow: pressing the "Щит" button enters a multi-select mode
     * (this.mageWardPicks, a Set of unit ids toggled so far this session —
     * see toggleMageWardMode/pickMageWardUnit) that applies nothing on its
     * own; pressing "Готово" (confirmMageWard) commits every toggle in one
     * mage-ward action, costing exactly 1 movesLeft total.
     */
    toggleMageWardMode() {
      const u = this.selectedUnit;
      if (!u || u.type !== "mage" || u.movesLeft < 1) return false;
      if (this.mageMode === 'ward') {
        this.mageMode = null;
        this.mageWardPicks = new Set();
        this.message = "";
      } else {
        this.mageMode = 'ward';
        this.mageWardPicks = new Set();
        this.message = tr("Выберите юнитов для щита (клик — добавить/убрать), затем нажмите «Готово».");
      }
      this.renderSidebar();
      return true;
    }

    /** Toggle one unit in/out of the pending ward-select set. Visual only — nothing applies until confirmMageWard(). */
    pickMageWardUnit(unitId) {
      if (this.mageMode !== 'ward' || !this.selectedUnit) return false;
      // Only the mage's own living side is a legal ward target/toggle.
      const candidate = this.board.units.find((o) => o.id === unitId && o.alive());
      if (!candidate || candidate.player !== this.selectedUnit.player) return false;
      if (this.mageWardPicks.has(unitId)) this.mageWardPicks.delete(unitId);
      else this.mageWardPicks.add(unitId);
      this.renderSidebar();
      return true;
    }

    /** Apply every toggle picked in this.mageWardPicks as one mage-ward action. Costs 1 movesLeft total. */
    confirmMageWard() {
      const unit = this.selectedUnit;
      if (!unit || unit.type !== "mage" || unit.movesLeft < 1) return false;
      const toggleUnitIds = Array.from(this.mageWardPicks);
      if (toggleUnitIds.length === 0) {
        this.mageMode = null;
        this.mageWardPicks = new Set();
        this.renderSidebar();
        return false;
      }

      if (this.online) {
        this.recordAction({ kind: "mage-ward", unitId: unit.id, toggleUnitIds });
      }

      const added = [];
      const removed = [];
      toggleUnitIds.forEach((id) => {
        const target = this.board.units.find((o) => o.id === id && o.alive());
        if (!target) return;
        if (target.wardedBy === unit.id) {
          target.wardedBy = null;
          removed.push(target);
        } else {
          target.wardedBy = unit.id;
          added.push(target);
        }
      });
      unit.warding = this.board.units.filter((o) => o.alive() && o.wardedBy === unit.id).map((o) => o.id);
      unit.movesLeft -= 1;
      this.mageMode = null;
      this.mageWardPicks = new Set();

      const parts = [];
      if (added.length) parts.push(tr("защищено: {n}", { n: added.length }));
      if (removed.length) parts.push(tr("снято: {n}", { n: removed.length }));
      this.lastEvent = tr("{caster} настраивает щит ({parts}).", {
        caster: this.trName(unit.name), parts: parts.join(", "),
      });
      [...added, ...removed].forEach((u) => {
        this.createExplosion(
          u.col * CELL_SIZE + CELL_SIZE / 2,
          u.row * CELL_SIZE + CELL_SIZE / 2,
          "#6495ed", 8,
        );
      });

      if (unit.movesLeft <= 0) this.finishSelectedUnit();
      else { this.rebuildHighlights(); this.renderSidebar(); }
      return true;
    }

    /**
     * Ward check run before ANY damage is applied to `target` (mirrors
     * @kc/game-rules' apply.ts absorbWithWard exactly — see
     * [[kc-mage-ward-mechanic]]). If `target.wardedBy` names a living mage,
     * the hit is fully absorbed (caller must skip applying rawDamage) and
     * that mage pays energy 1-to-1 with the absorbed damage (5 damage
     * absorbed → 5 energy spent). If it can't afford that, the mage dies
     * instead (target still takes 0). Returns true when the hit was absorbed.
     */
    absorbWithWard(target, rawDamage) {
      if (!target.wardedBy) return false;
      const mage = this.board.units.find((u) => u.id === target.wardedBy && u.alive() && u.type === 'mage');
      if (!mage) {
        target.wardedBy = null;
        return false;
      }
      const cost = Math.floor(rawDamage / MAGE_WARD_ENERGY_PER_DAMAGE);
      if (mage.energy >= cost) {
        mage.energy -= cost;
        this.createFloatingText("🛡️-" + cost, mage.col * CELL_SIZE + CELL_SIZE / 2, mage.row * CELL_SIZE + CELL_SIZE / 2 - 10, "#6495ed", 14);
      } else {
        this.lastEvent = tr("{name} не выдержал перегрузку щита и погиб!", { name: this.trName(mage.name) });
        this.dropUnitGear(mage);
        mage.startDeath();
        this.createExplosion(mage.col * CELL_SIZE + CELL_SIZE / 2, mage.row * CELL_SIZE + CELL_SIZE / 2, "#666", 10);
        this.board.removeDead((u) => this.dropUnitGear(u));
        this.checkWinner();
      }
      return true;
    }

    /**
     * On-map indicator for every warded unit — a small pulsing shield badge
     * in the corner of its cell, so protection is visible directly on the
     * board and not just in the mage's own panel (see
     * [[kc-mage-ward-mechanic]]).
     */
    drawWardBadges(ctx) {
      const warded = this.board.units.filter((u) => u.alive() && u.wardedBy);
      if (warded.length === 0) return;
      const pulse = 0.7 + 0.3 * Math.sin(this.frameCount * 0.12);
      warded.forEach((u) => {
        const x = u.col * CELL_SIZE;
        const y = u.row * CELL_SIZE;
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.font = 'bold ' + Math.round(CELL_SIZE * 0.32) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const bx = x + CELL_SIZE - CELL_SIZE * 0.18;
        const by = y + CELL_SIZE * 0.18;
        ctx.shadowColor = 'rgba(100,149,237,0.9)';
        ctx.shadowBlur = 6;
        ctx.fillText('🛡️', bx, by);
        ctx.restore();
      });
    }

    drawConstructions() {
      const ctx = this.ctx;
      const constructions = getConstructions();

      constructions.forEach((c) => {
        const x = c.col * CELL_SIZE;
        const y = c.row * CELL_SIZE;
        ctx.save();
        ctx.fillStyle = "rgba(180, 140, 60, 0.45)";
        ctx.fillRect(x + 4, y + 4, CELL_SIZE - 8, CELL_SIZE - 8);
        ctx.strokeStyle = "#e6a100";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(x + 4, y + 4, CELL_SIZE - 8, CELL_SIZE - 8);
        ctx.setLineDash([]);

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const icon = c.kind === "tower" ? "🏗️" : "🔨";
        ctx.fillText(`${icon} ${c.hp}/4`, x + CELL_SIZE / 2, y + CELL_SIZE / 2);
        ctx.restore();
      });
    }

    /** Enter/leave building aim mode for the selected knight. */
    toggleBuildMode(kind) {
      const u = this.selectedUnit;
      if (!u || u.type !== "knight" || u.movesLeft < 2) return false;
      if (this.buildMode === kind) {
        this.buildMode = null;
        this.buildTargets = [];
        this.message = "";
      } else {
        this.buildMode = kind;
        this.buildTargets = this.buildTargetsFor(u, kind);
        this.message = kind === "tower"
          ? tr("Выберите клетку рядом для постройки башни.")
          : tr("Выберите реку рядом для постройки моста.");
      }
      this.renderSidebar();
      return true;
    }

    /** Find valid target cells for building tower or bridge by knight. */
    buildTargetsFor(unit, kind) {
      const targets = [];
      const neighbors = [
        { row: unit.row - 1, col: unit.col },
        { row: unit.row + 1, col: unit.col },
        { row: unit.row, col: unit.col - 1 },
        { row: unit.row, col: unit.col + 1 },
      ];
      const constructions = getConstructions();
      const towers = getTowers();
      const terrain = getTerrain();

      for (const n of neighbors) {
        if (!insideBoard(n.row, n.col)) continue;
        const occupiedByUnit = this.board && this.board.units.some((u) => u.hp > 0 && u.row === n.row && u.col === n.col);
        if (occupiedByUnit) continue;

        const constr = constructions.find((c) => c.row === n.row && c.col === n.col);
        if (constr) {
          if (constr.kind === kind && constr.hp < 4) {
            targets.push(n);
          }
          continue;
        }

        const ter = terrain.find((t) => t.row === n.row && t.col === n.col);
        const terType = ter ? ter.type : "plain";

        if (kind === "tower") {
          if (terType === "mountain" || terType === "rock" || terType === "river" || terType === "bridge") continue;
          if (towers.some((t) => t.row === n.row && t.col === n.col)) continue;
          targets.push(n);
        } else if (kind === "bridge") {
          if (terType === "river") {
            targets.push(n);
          }
        }
      }
      return targets;
    }

    /** Apply build-tower or build-bridge on (row, col). */
    buildStructure(row, col) {
      const unit = this.selectedUnit;
      if (!unit || !this.buildMode) return false;
      if (!this.buildTargets.some((t) => t.row === row && t.col === col)) return false;

      const kind = this.buildMode;
      if (this.online) {
        this.recordAction({
          kind: kind === "tower" ? "build-tower" : "build-bridge",
          unitId: unit.id,
          row,
          col,
        });
      }

      unit.movesLeft -= 2;

      const constructions = getConstructions();
      const existing = constructions.find((c) => c.row === row && c.col === col);
      if (existing) {
        const nextHp = existing.hp + 2;
        if (nextHp >= 4) {
          setConstructions(constructions.filter((c) => !(c.row === row && c.col === col)));
          if (kind === "tower") {
            setTowers([...getTowers(), { row, col }]);
            this.lastEvent = tr("{name} завершил постройку башни!", { name: this.trName(unit.name) });
          } else {
            const currentTerrain = getTerrain();
            const existingRiverIndex = currentTerrain.findIndex((t) => t.row === row && t.col === col);
            let nextTerrain = currentTerrain.slice();
            if (existingRiverIndex >= 0) {
              nextTerrain[existingRiverIndex] = { row, col, type: "bridge" };
            } else {
              nextTerrain.push({ row, col, type: "bridge" });
            }
            setTerrain(nextTerrain);
            setBridgeDurability({ ...getBridgeDurability(), [`${row},${col}`]: 2 });
            this.lastEvent = tr("{name} завершил постройку моста!", { name: this.trName(unit.name) });
          }
        } else {
          setConstructions(constructions.map((c) => (c.row === row && c.col === col ? { ...c, hp: nextHp } : c)));
          this.lastEvent = tr("{name} продолжил строительство ({hp}/4).", { name: this.trName(unit.name), hp: nextHp });
        }
      } else {
        setConstructions([...constructions, { row, col, kind, hp: 2 }]);
        this.lastEvent = tr("{name} начал строительство ({kind}) (2/4).", {
          name: this.trName(unit.name),
          kind: kind === "tower" ? tr("башня") : tr("мост"),
        });
      }

      this.buildMode = null;
      this.buildTargets = [];
      if (unit.movesLeft <= 0) {
        this.finishSelectedUnit();
      } else {
        this.rebuildHighlights();
        this.renderSidebar();
      }
      return true;
    }

    drawThreatOverlay(ctx) {
      if (!this.showThreat || !this.board) return;
      const foe = this.currentPlayer === 1 ? 2 : 1;
      const cells = new Set();
      this.ownUnits(foe).forEach((u) => {
        generateAttackActions(this.board, u).forEach((a) => {
          if (a.mode === "pierce" && a.targets) {
            a.targets.forEach((cell) => cells.add(cell.row + "," + cell.col));
          } else {
            cells.add(a.targetRow + "," + a.targetCol);
          }
        });
      });
      cells.forEach((key) => {
        const parts = key.split(",");
        const x = Number(parts[1]) * CELL_SIZE;
        const y = Number(parts[0]) * CELL_SIZE;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, CELL_SIZE, CELL_SIZE);
        ctx.clip();
        // Blue = danger ("you could be hit here"), kept off the red family so
        // it never reads as one of your own attack options. See COLORS comment.
        ctx.fillStyle = COLORS.threatFill;
        ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
        ctx.strokeStyle = COLORS.threatStroke;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let d = 0; d <= CELL_SIZE * 2; d += 9) {
          ctx.moveTo(x + d, y);
          ctx.lineTo(x + d - CELL_SIZE, y + CELL_SIZE);
        }
        ctx.stroke();
        ctx.restore();
      });
    }

    draw() {
      if (this.screen === "menu") {
        this.drawMenuCanvas();
        return;
      }
      this.drawGameCanvas();
    }

    loop() {
      // The rAF chain is re-armed in `finally`. Without it a single throw in
      // any of these three steps kills the loop for good: nothing reschedules,
      // the canvas keeps showing the last painted frame (stale highlights and
      // all), and the game looks frozen rather than broken. Errors are logged
      // instead of swallowed so the underlying bug is still visible.
      try {
        this.updateAnimations();
        this.draw();
        this.ai.update();
      } catch (err) {
        console.error('Game loop step failed; continuing next frame.', err);
      } finally {
        requestAnimationFrame(() => this.loop());
      }
    }
  }

  const assets = new AssetStore();
  const root = "tiny-swords/Tiny Swords (Free Pack)/";

  assets.add("cover", "assets/custom/cover_arthur.png");

  assets.add("u_blue_knight",    root + "Units/Blue Units/Warrior/Warrior_Idle.png");
  assets.add("u_blue_cavalry",   root + "Units/Blue Units/Lancer/Lancer_Idle.png");
  assets.add("u_blue_archer",    root + "Units/Blue Units/Archer/Archer_Idle.png");
  assets.add("u_blue_catapult",  root + "Units/Blue Units/Catapult/Catapult_Idle.png");
  assets.add("u_blue_crossbow",  root + "Units/Blue Units/Crossbow/Crossbow_Idle.png");
  assets.add("u_blue_samurai",   root + "Units/Blue Units/Samurai/Samurai_Idle.png");
  assets.add("u_blue_mage",      root + "Units/Blue Units/Monk/Idle.png");

  assets.add("u_red_knight",     root + "Units/Red Units/Warrior/Warrior_Idle.png");
  assets.add("u_red_cavalry",    root + "Units/Red Units/Lancer/Lancer_Idle.png");
  assets.add("u_red_archer",     root + "Units/Red Units/Archer/Archer_Idle.png");
  assets.add("u_red_catapult",   root + "Units/Red Units/Catapult/Catapult_Idle.png");
  assets.add("u_red_crossbow",   root + "Units/Red Units/Crossbow/Crossbow_Idle.png");
  assets.add("u_red_samurai",    root + "Units/Red Units/Samurai/Samurai_Idle.png");
  assets.add("u_red_mage",       root + "Units/Red Units/Monk/Idle.png");

  // Саксы — Чёрные юниты
  assets.add("u_black_knight",   root + "Units/Black Units/Warrior/Warrior_Idle.png");
  assets.add("u_black_cavalry",  root + "Units/Black Units/Lancer/Lancer_Idle.png");
  assets.add("u_black_archer",   root + "Units/Black Units/Archer/Archer_Idle.png");
  assets.add("u_black_catapult", root + "Units/Black Units/Catapult/Catapult_Idle.png");
  assets.add("u_black_crossbow", root + "Units/Black Units/Crossbow/Crossbow_Idle.png");
  assets.add("u_black_samurai",  root + "Units/Black Units/Samurai/Samurai_Idle.png");
  assets.add("u_black_mage",     root + "Units/Black Units/Monk/Idle.png");

  // Тёмные рыцари — Фиолетовые юниты
  assets.add("u_purple_knight",    root + "Units/Purple Units/Warrior/Warrior_Idle.png");
  assets.add("u_purple_cavalry",   root + "Units/Purple Units/Lancer/Lancer_Idle.png");
  assets.add("u_purple_archer",    root + "Units/Purple Units/Archer/Archer_Idle.png");
  assets.add("u_purple_catapult",  root + "Units/Purple Units/Catapult/Catapult_Idle.png");
  assets.add("u_purple_crossbow",  root + "Units/Purple Units/Crossbow/Crossbow_Idle.png");
  assets.add("u_purple_samurai",   root + "Units/Purple Units/Samurai/Samurai_Idle.png");
  assets.add("u_purple_mage",      root + "Units/Purple Units/Monk/Idle.png");

  // Мятежные бароны — Жёлтые юниты
  assets.add("u_yellow_knight",    root + "Units/Yellow Units/Warrior/Warrior_Idle.png");
  assets.add("u_yellow_cavalry",   root + "Units/Yellow Units/Lancer/Lancer_Idle.png");
  assets.add("u_yellow_archer",    root + "Units/Yellow Units/Archer/Archer_Idle.png");
  assets.add("u_yellow_catapult",  root + "Units/Yellow Units/Catapult/Catapult_Idle.png");
  assets.add("u_yellow_crossbow",  root + "Units/Yellow Units/Crossbow/Crossbow_Idle.png");
  assets.add("u_yellow_samurai",   root + "Units/Yellow Units/Samurai/Samurai_Idle.png");
  assets.add("u_yellow_mage",      root + "Units/Yellow Units/Monk/Idle.png");

  // Море
  assets.add("water_bg", root + "Terrain/Tileset/Water Background color.png");
  assets.add("water_foam", root + "Terrain/Tileset/Water Foam.png");

  assets.add("terrain_grass",  root + "Terrain/Tileset/Tilemap_color1.png");
  assets.add("terrain_bush1",  root + "Terrain/Decorations/Bushes/Bushe1.png");
  assets.add("terrain_bush2",  root + "Terrain/Decorations/Bushes/Bushe2.png");
  assets.add("terrain_bush3",  root + "Terrain/Decorations/Bushes/Bushe3.png");
  assets.add("terrain_bush4",  root + "Terrain/Decorations/Bushes/Bushe4.png");
  assets.add("terrain_rock1",  root + "Terrain/Decorations/Rocks/Rock1.png");
  assets.add("terrain_rock2",  root + "Terrain/Decorations/Rocks/Rock2.png");
  assets.add("terrain_rock3",  root + "Terrain/Decorations/Rocks/Rock3.png");
  assets.add("terrain_rock4",  root + "Terrain/Decorations/Rocks/Rock4.png");
  assets.add("castle_blue", root + "Buildings/Blue Buildings/Castle.png");
  assets.add("castle_red", root + "Buildings/Red Buildings/Castle.png");
  assets.add("tower_blue", root + "Buildings/Blue Buildings/Tower.png");
  assets.add("monastery_ruins", root + "Buildings/Blue Buildings/Monastery.png");
  assets.add("ruins_custom", "assets/custom/ruins_custom.png");
  assets.add("horse_knight_base", "assets/external/horse_sheet.png");
  
  // Загрузка артефактов из assets/custom
  assets.add("artifact_grass", "assets/custom/grass.png");
  assets.add("artifact_fire_staff", "assets/custom/fire_staff.png");
  assets.add("artifact_wand", "assets/custom/wand.png");
  assets.add("artifact_sundial", "assets/custom/sundial.png");
  assets.add("artifact_silver_water", "assets/custom/silver_water.png");
  
  // Загрузка иконок заклинаний из assets/custom
  assets.add("spell_rain", "assets/custom/1.png");
  assets.add("spell_steel", "assets/custom/2.png");
  assets.add("spell_fire_sky", "assets/custom/3.png");
  
  // Загрузка иконок оружия из assets/custom
  assets.add("weapon_sword", "assets/custom/Меч.png");
  assets.add("weapon_bow", "assets/custom/Лук.png");

  // Armour icons — self-contained inline SVG shields (no extra image files).
  const shieldPath = "M16 3 L28 7 V16 C28 24 22 28 16 30 C10 28 4 24 4 16 V7 Z";
  const svgIcon = (inner) =>
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' + inner + "</svg>"
    );
  assets.add(
    "armor_mail",
    svgIcon(
      '<path d="' + shieldPath + '" fill="rgb(176,196,222)" stroke="rgb(70,90,120)" stroke-width="1.6"/>' +
        '<g fill="rgb(116,140,172)">' +
        '<circle cx="11" cy="12" r="1.3"/><circle cx="16" cy="12" r="1.3"/><circle cx="21" cy="12" r="1.3"/>' +
        '<circle cx="13.5" cy="17" r="1.3"/><circle cx="18.5" cy="17" r="1.3"/><circle cx="16" cy="22" r="1.3"/>' +
        "</g>"
    )
  );
  assets.add(
    "armor_plate",
    svgIcon(
      '<path d="' + shieldPath + '" fill="rgb(132,142,154)" stroke="rgb(48,54,64)" stroke-width="1.6"/>' +
        '<path d="M16 5 V28" stroke="rgb(86,94,106)" stroke-width="1.6"/>' +
        '<path d="M6.5 13 H25.5" stroke="rgb(86,94,106)" stroke-width="1.6"/>' +
        '<g fill="rgb(228,233,238)">' +
        '<circle cx="16" cy="9" r="1.4"/><circle cx="10.5" cy="18.5" r="1.4"/><circle cx="21.5" cy="18.5" r="1.4"/>' +
        "</g>"
    )
  );

  // story.txt inlined — parsed synchronously so STORY_CHAPTERS is correct
  // on the first renderNewMenu() call in the KnightsAndCastlesGame constructor.
  // Previously deferred to a microtask, causing the story to visually change
  // on first auth action or asset-load completion.
  const _STORY_TXT = `# ============================================================
# === AI ПРЕСЕТЫ — ПОШАГОВАЯ СТРАТЕГИЯ ===
# ============================================================
# Градация: 7 уровней вместо 5
# Новые параметры для пошаговой стратегии:
#   positioningWeight  — приоритет позиционирования юнитов
#   flanking           — использование фланговых атак
#   resourceControl    — контроль ресурсных точек
#   defensiveFormation — умение уходить в оборону
#   unitSynergy        — координация между юнитами
#   trapSetting        — расстановка ловушек/засад
#   adaptiveDifficulty — подстройка под стиль игрока

[AI: Новичок]
frameWait = 30
combinationLimit = 10
randomMoveChance = 0.45
mistakeChance = 0.30
skipChance = 0.15
threatBlindness = 0.60
spellReluctance = 0.85
scoreNoise = 4000
useMinimax = false
minimaxDepth = 0
focusFireWeight = 0.0
comboDetection = false
territoryWeight = 0.2
sacrificeEval = false

[AI: Ученик]
frameWait = 24
combinationLimit = 10
randomMoveChance = 0.25
mistakeChance = 0.18
skipChance = 0.08
threatBlindness = 0.35
spellReluctance = 0.65
scoreNoise = 2500
useMinimax = false
minimaxDepth = 0
focusFireWeight = 0.2
comboDetection = false
territoryWeight = 0.4
sacrificeEval = false

[AI: Боец]
frameWait = 21
combinationLimit = 30
randomMoveChance = 0.15
mistakeChance = 0.12
skipChance = 0.04
threatBlindness = 0.20
spellReluctance = 0.45
scoreNoise = 1500
useMinimax = false
minimaxDepth = 0
focusFireWeight = 0.35
comboDetection = false
territoryWeight = 0.55
sacrificeEval = false

[AI: Воин]
frameWait = 18
combinationLimit = 80
randomMoveChance = 0.10
mistakeChance = 0.08
skipChance = 0.02
threatBlindness = 0.10
spellReluctance = 0.25
scoreNoise = 700
useMinimax = false
minimaxDepth = 0
focusFireWeight = 0.5
comboDetection = true
territoryWeight = 0.65
sacrificeEval = false

[AI: Тактик]
frameWait = 14
combinationLimit = 80
randomMoveChance = 0.03
mistakeChance = 0.03
skipChance = 0.00
threatBlindness = 0.05
spellReluctance = 0.12
scoreNoise = 300
useMinimax = true
minimaxDepth = 1
focusFireWeight = 0.75
comboDetection = true
territoryWeight = 0.85
sacrificeEval = false

[AI: Мастер]
frameWait = 10
combinationLimit = 200
randomMoveChance = 0.00
mistakeChance = 0.00
skipChance = 0.00
threatBlindness = 0.00
spellReluctance = 0.00
scoreNoise = 0
useMinimax = true
minimaxDepth = 2
focusFireWeight = 1.0
comboDetection = true
territoryWeight = 1.0
sacrificeEval = true

[AI: Легенда]
frameWait = 8
combinationLimit = 400
randomMoveChance = 0.00
mistakeChance = 0.00
skipChance = 0.00
threatBlindness = 0.00
spellReluctance = 0.00
scoreNoise = 0
useMinimax = true
minimaxDepth = 3
focusFireWeight = 1.0
comboDetection = true
territoryWeight = 1.0
sacrificeEval = true

# ——————————————————————————————
# Глава 1 — Меч в камне
# Тема: знакомство с механиками. Враги слабые, ошибки прощаются.
# ——————————————————————————————

## Юность Артура
Новичок | Безвестный оруженосец
Новичок | Турнир в Лондоне
Ученик  | Меч в камне

## Корона Логрии
Ученик  | Непокорные бароны
Ученик  | Клятва верности
Боец    | Битва при Бедегрейне

## Эскалибур
Боец    | Владычица Озера
Воин    | Дар Эскалибура


# ——————————————————————————————
# Глава 2 — Рыцари Круглого стола
# Тема: контроль территории, бои на открытой карте.
# Пик главы — первый бой с Тактиком.
# ——————————————————————————————

## Камелот
Боец    | Основание Камелота
Воин    | Круглый стол
Воин    | Сэр Ланселот

## Войны с саксами
Воин    | Саксонское вторжение
Тактик  | Гора Бадон
Тактик  | Двенадцать битв

## Честь рыцаря
Тактик  | Гавейн и Зелёный рыцарь
Мастер  | Турнир чемпионов


# ——————————————————————————————
# Глава 3 — Закат Камелота
# Тема: поиск Грааля и предательство. Сложность сначала снижается
# (эмоциональная передышка), затем резко растёт.
# ——————————————————————————————

## Поиски Грааля
Воин    | Священный Грааль
Тактик  | Сэр Галахад
Тактик  | Тень измены
Мастер  | Предательство Ланселота

## Битва при Камлане
Ученик  | Мордред восстаёт
Боец    | Осада Камелота
Воин    | Последний поход
Тактик  | Король былого и грядущего`;
  try {
    const _parsed = parseStoryTxt(_STORY_TXT);
    if (_parsed && _parsed.length > 0) STORY_CHAPTERS = _parsed;
  } catch(e) {}

  const canvas = document.getElementById("gameCanvas");
  const sidebar = document.getElementById("sidebar");
  const game = new KnightsAndCastlesGame(canvas, sidebar, assets);
  // Expose the live game on window so e2e tests (and live debugging) can
  // introspect or drive state transitions without scraping the DOM.
  (window as any).__kcGame = game;
  (window as any).COLS = COLS;
  (window as any).ROWS = ROWS;
  (window as any).CELL_SIZE = CELL_SIZE;
  (window as any).getTerrain = getTerrain;
  (window as any).getCastleP1Col = getCastleP1Col;
  (window as any).getCastleP2Col = getCastleP2Col;
  (window as any).getAllRuins = getAllRuins;
  (window as any).__kcGameRules = { generateAttackActions, generateLegalMoves };
  // Live counters for how much of the AI's plan the game accepts. Type
  // `__kcAIStats()` in the console during / after an AI game; also read by
  // tests/e2e/ai-illegal-moves.spec.ts as a live-play regression guard.
  (window as any).__kcAIStats = () => ({ ...AIPlayer.execStats });

  assets.loadAll();

  // _STORY_TXT is already defined and parsed synchronously above (before game
  // creation), so storyReady is a no-op promise used only to gate onAssetsReady.
  const _STORY_TXT_UNUSED = `# ============================================================
# === AI ПРЕСЕТЫ — ПОШАГОВАЯ СТРАТЕГИЯ ===
# ============================================================
# Градация: 7 уровней вместо 5
# Новые параметры для пошаговой стратегии:
#   positioningWeight  — приоритет позиционирования юнитов
#   flanking           — использование фланговых атак
#   resourceControl    — контроль ресурсных точек
#   defensiveFormation — умение уходить в оборону
#   unitSynergy        — координация между юнитами
#   trapSetting        — расстановка ловушек/засад
#   adaptiveDifficulty — подстройка под стиль игрока

[AI: Новичок]
frameWait=35
randomMoveChance=0.50
mistakeChance=0.35
skipChance=0.20
threatBlindness=0.70
spellReluctance=0.90
scoreNoise=5000
useMinimax=false
minimaxDepth=0
focusFireWeight=0.0
comboDetection=false
territoryWeight=0.10
sacrificeEval=false
aggressionBias=0.10
retreatAwareness=false
positioningWeight=0.0
flanking=false
resourceControl=0.0
defensiveFormation=false
unitSynergy=false
trapSetting=false
adaptiveDifficulty=false
# Ходит почти случайно, не понимает угроз, игнорирует позицию

[AI: Ученик]
frameWait=28
randomMoveChance=0.28
mistakeChance=0.20
skipChance=0.10
threatBlindness=0.40
spellReluctance=0.70
scoreNoise=2800
useMinimax=false
minimaxDepth=0
focusFireWeight=0.15
comboDetection=false
territoryWeight=0.30
sacrificeEval=false
aggressionBias=0.20
retreatAwareness=false
positioningWeight=0.15
flanking=false
resourceControl=0.10
defensiveFormation=false
unitSynergy=false
trapSetting=false
adaptiveDifficulty=false
# Пытается атаковать, но легко читается и не защищается

[AI: Боец]
frameWait=22
randomMoveChance=0.14
mistakeChance=0.12
skipChance=0.05
threatBlindness=0.22
spellReluctance=0.48
scoreNoise=1400
useMinimax=false
minimaxDepth=0
focusFireWeight=0.35
comboDetection=false
territoryWeight=0.50
sacrificeEval=false
aggressionBias=0.40
retreatAwareness=true
positioningWeight=0.35
flanking=false
resourceControl=0.25
defensiveFormation=false
unitSynergy=false
trapSetting=false
adaptiveDifficulty=false
# Давит числом, держит позиции, но не координирует юниты

[AI: Воин]
frameWait=17
randomMoveChance=0.07
mistakeChance=0.07
skipChance=0.01
threatBlindness=0.10
spellReluctance=0.22
scoreNoise=600
useMinimax=false
minimaxDepth=0
focusFireWeight=0.55
comboDetection=true
territoryWeight=0.70
sacrificeEval=false
aggressionBias=0.60
retreatAwareness=true
positioningWeight=0.60
flanking=true
resourceControl=0.50
defensiveFormation=true
unitSynergy=false
trapSetting=false
adaptiveDifficulty=false
# Понимает фланги, контролирует карту, умеет обороняться

[AI: Тактик]
frameWait=13
randomMoveChance=0.02
mistakeChance=0.02
skipChance=0.00
threatBlindness=0.04
spellReluctance=0.10
scoreNoise=250
useMinimax=true
minimaxDepth=2
focusFireWeight=0.78
comboDetection=true
territoryWeight=0.88
sacrificeEval=false
aggressionBias=0.72
retreatAwareness=true
positioningWeight=0.80
flanking=true
resourceControl=0.75
defensiveFormation=true
unitSynergy=true
trapSetting=false
adaptiveDifficulty=false
# Координирует юниты, планирует на 2 хода вперёд, ловит ошибки

[AI: Мастер]
frameWait=9
randomMoveChance=0.00
mistakeChance=0.00
skipChance=0.00
threatBlindness=0.00
spellReluctance=0.00
scoreNoise=0
useMinimax=true
minimaxDepth=3
focusFireWeight=1.0
comboDetection=true
territoryWeight=1.0
sacrificeEval=true
aggressionBias=0.90
retreatAwareness=true
positioningWeight=1.0
flanking=true
resourceControl=1.0
defensiveFormation=true
unitSynergy=true
trapSetting=true
adaptiveDifficulty=false
# Расставляет ловушки, жертвует юнитами ради позиции, не прощает ошибок

[AI: Легенда]
frameWait=6
randomMoveChance=0.00
mistakeChance=0.00
skipChance=0.00
threatBlindness=0.00
spellReluctance=0.00
scoreNoise=0
useMinimax=true
minimaxDepth=4
focusFireWeight=1.0
comboDetection=true
territoryWeight=1.0
sacrificeEval=true
aggressionBias=1.0
retreatAwareness=true
positioningWeight=1.0
flanking=true
resourceControl=1.0
defensiveFormation=true
unitSynergy=true
trapSetting=true
adaptiveDifficulty=true
# Финальный босс. Подстраивается под игрока. Используется только 1 раз.


# ============================================================
# === ИСТОРИЯ ===
# ============================================================
# Формат:
#   # Глава N — Название
#   ## Название подглавы
#   ПресетАИ | Название задания
# ============================================================

# ——————————————————————————————
# Глава 1 — Меч в камне
# Тема: знакомство с механиками. Враги слабые, ошибки прощаются.
# ——————————————————————————————

## Юность Артура
Новичок | Безвестный оруженосец
Новичок | Турнир в Лондоне
Ученик  | Меч в камне

## Корона Логрии
Ученик  | Непокорные бароны
Ученик  | Клятва верности
Боец    | Битва при Бедегрейне

## Эскалибур
Боец    | Владычица Озера
Воин    | Дар Эскалибура


# ——————————————————————————————
# Глава 2 — Рыцари Круглого стола
# Тема: контроль территории, бои на открытой карте.
# Пик главы — первый бой с Тактиком.
# ——————————————————————————————

## Камелот
Боец    | Основание Камелота
Воин    | Круглый стол
Воин    | Сэр Ланселот

## Войны с саксами
Воин    | Саксонское вторжение
Тактик  | Гора Бадон
Тактик  | Двенадцать битв

## Честь рыцаря
Тактик  | Гавейн и Зелёный рыцарь
Мастер  | Турнир чемпионов


# ——————————————————————————————
# Глава 3 — Закат Камелота
# Тема: поиск Грааля и предательство. Сложность сначала снижается
# (эмоциональная передышка), затем резко растёт.
# ——————————————————————————————

## Поиски Грааля
Воин    | Священный Грааль
Тактик  | Сэр Галахад
Тактик  | Тень измены
Мастер  | Предательство Ланселота

## Битва при Камлане
Ученик  | Мордред восстаёт
Боец    | Осада Камелота
Воин    | Последний поход
Тактик  | Король былого и грядущего`;

  // STORY_CHAPTERS already updated synchronously before game construction.
  const storyReady = Promise.resolve();

  let launched = false;
  const boot = () => {
    if (launched) return;
    launched = true;
    storyReady.then(() => game.onAssetsReady());
  };

  assets.whenFinished(boot);
  setTimeout(boot, 3000);
  
})();
