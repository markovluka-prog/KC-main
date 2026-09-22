/*
 * Absolute strength gauntlet.
 *
 * The A/B bench plays the engine against ITSELF, which cannot see the
 * weaknesses a human exploits: both sides share the same blind spots, so a flaw
 * both players have shows up as 50% and looks like "no change". This script
 * instead scores the bot against FIXED reference opponents whose behaviour never
 * changes, so the number means something on its own and is comparable across
 * runs.
 *
 * Opponents, in rough order of how a human actually beats this bot:
 *   greedy   — takes its single best-scoring action each turn (no lookahead)
 *   raider   — ignores fights, runs straight at the undefended castle
 *   kiter    — keeps ranged units out of reach and plinks
 *
 * Win conditions include CASTLE CAPTURE, which playGame() in the test harness
 * does not check — a bot that gets castled loses here exactly as it does in a
 * real game.
 *
 *   pnpm --filter @kc/web gauntlet
 *   GAUNTLET_GAMES=20 GAUNTLET_BUDGET=400 pnpm --filter @kc/web gauntlet
 */
import { it } from 'vitest';
import { AI_DIFFICULTY, type AIConfig } from '../src/game/ai-config.js';
import {
  applyPlan,
  makeSearcher,
  makeState,
  makeUnit,
  search,
  type HarnessState,
  type HarnessUnit,
  type Player,
} from '../src/game/__tests__/mcts-harness.js';

type Internals = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const KN = { hp: 3, armor: 4, dmg: 5, mv: 2 };
const CV = { hp: 5, armor: 3, dmg: 6, mv: 3 };
const AR = { hp: 3, armor: 1, dmg: 3, mv: 3 };

function mk(id: number, p: Player, type: string, row: number, col: number): HarnessUnit {
  const st = type === 'knight' ? KN : type === 'cavalry' ? CV : AR;
  return makeUnit({
    id, player: p, type: type as never, row, col,
    hp: st.hp, armor: st.armor, damage: st.dmg, maxMoves: st.mv,
  });
}

/** The real 10v10 army opening (mirrors mcts.test.ts realOpening). */
function armyOpening(): HarnessState {
  return makeState(
    [
      mk(11, 2, 'cavalry', 3, 11), mk(12, 2, 'cavalry', 3, 12),
      mk(13, 2, 'knight', 1, 10), mk(14, 2, 'knight', 1, 13),
      mk(15, 2, 'knight', 2, 10), mk(16, 2, 'knight', 2, 13),
      mk(17, 2, 'knight', 0, 10), mk(18, 2, 'archer', 0, 11),
      mk(19, 2, 'archer', 0, 12), mk(20, 2, 'knight', 0, 13),
      mk(1, 1, 'cavalry', 16, 11), mk(2, 1, 'cavalry', 16, 12),
      mk(3, 1, 'knight', 18, 10), mk(4, 1, 'knight', 18, 13),
      mk(5, 1, 'knight', 17, 10), mk(6, 1, 'knight', 17, 13),
      mk(7, 1, 'knight', 19, 10), mk(8, 1, 'archer', 19, 11),
      mk(9, 1, 'archer', 19, 12), mk(10, 1, 'knight', 19, 13),
    ],
    3,
  );
}

/** Best-scoring action per unit, up to the activation cap. No lookahead. */
function greedyTurn(ai: Internals, state: HarnessState, player: Player): HarnessState {
  let cur = ai.cloneLightState(state);
  for (let acted = 0; acted < 3; acted += 1) {
    const avail = cur.units.filter(
      (u: HarnessUnit) =>
        u.player === player && u.hp > 0 && !u.done && u.movesLeft > 0 &&
        ((u as Internals).activated || cur.activationsLeft > 0),
    );
    if (avail.length === 0) break;
    let bu: HarnessUnit | null = null;
    let ba: Internals = null;
    let bs = -Infinity;
    for (const u of avail) {
      const top = ai.scoreLightActions(cur, u, ai.generateActionsForLightState(cur, u), player)[0];
      if (top && top.type !== 'skip' && (top.score ?? 0) > bs) {
        bs = top.score ?? 0; bu = u; ba = top;
      }
    }
    if (!ba || !bu) break;
    cur = ai.applyActionToState(cur, bu.id, ba);
  }
  return ai.applyEndOfTurn(cur, player);
}

/**
 * The castle rush a human uses: send everything at the enemy castle, take a
 * free kill only when it costs nothing. Punishes a bot that leaves home empty.
 */
function raiderTurn(ai: Internals, state: HarnessState, player: Player): HarnessState {
  const zone = ai.castleZone(player === 1 ? 2 : 1);
  const goalRow = zone.row + 2;
  const goalCol = zone.col + 2;
  let cur = ai.cloneLightState(state);
  for (let acted = 0; acted < 3; acted += 1) {
    const avail = cur.units.filter(
      (u: HarnessUnit) =>
        u.player === player && u.hp > 0 && !u.done && u.movesLeft > 0 &&
        ((u as Internals).activated || cur.activationsLeft > 0),
    );
    if (avail.length === 0) break;
    let bu: HarnessUnit | null = null;
    let ba: Internals = null;
    let bestGain = -Infinity;
    for (const u of avail) {
      const acts = ai.scoreLightActions(cur, u, ai.generateActionsForLightState(cur, u), player);
      const kill = acts.find((a: Internals) => a.type === 'attack' && (a.score ?? 0) >= 25000);
      if (kill) { bu = u; ba = kill; bestGain = Infinity; break; }
      const curD = Math.abs(u.row - goalRow) + Math.abs(u.col - goalCol);
      for (const a of acts) {
        if (a.type !== 'move') continue;
        const d = Math.abs(a.row - goalRow) + Math.abs(a.col - goalCol);
        if (curD - d > bestGain) { bestGain = curD - d; bu = u; ba = a; }
      }
    }
    if (!ba || !bu || bestGain <= 0) break;
    cur = ai.applyActionToState(cur, bu.id, ba);
  }
  return ai.applyEndOfTurn(cur, player);
}

/** Ranged units stay out of reach and shoot; melee holds the home castle. */
function kiterTurn(ai: Internals, state: HarnessState, player: Player): HarnessState {
  let cur = ai.cloneLightState(state);
  for (let acted = 0; acted < 3; acted += 1) {
    const avail = cur.units.filter(
      (u: HarnessUnit) =>
        u.player === player && u.hp > 0 && !u.done && u.movesLeft > 0 &&
        ((u as Internals).activated || cur.activationsLeft > 0),
    );
    if (avail.length === 0) break;
    let bu: HarnessUnit | null = null;
    let ba: Internals = null;
    let bs = -Infinity;
    for (const u of avail) {
      const acts = ai.scoreLightActions(cur, u, ai.generateActionsForLightState(cur, u), player);
      for (const a of acts) {
        if (a.type === 'skip') continue;
        let v = a.score ?? 0;
        // Ranged: heavily prefer shooting, and never stand where it can be hit.
        if (u.type === 'archer' || u.type === 'crossbow') {
          if (a.type === 'attack') v += 20000;
          if (a.type === 'move' && ai.simThreatAt(cur, a.row, a.col, u, null) > 0) v -= 30000;
        }
        if (v > bs) { bs = v; bu = u; ba = a; }
      }
    }
    if (!ba || !bu) break;
    cur = ai.applyActionToState(cur, bu.id, ba);
  }
  return ai.applyEndOfTurn(cur, player);
}

type Policy = (ai: Internals, s: HarnessState, p: Player) => HarnessState;

const POLICIES: Record<string, Policy> = { greedy: greedyTurn, raider: raiderTurn, kiter: kiterTurn };

/** Plays the searching bot (player 2) against a fixed policy (player 1). */
function playVersus(
  botConfig: Partial<AIConfig>,
  policy: Policy,
  maxTurns: number,
  botFirst: boolean,
): 'bot' | 'opp' | 'draw' {
  let state = armyOpening();
  const bot = makeSearcher(2, botConfig, state, true) as Internals;
  const ref = makeSearcher(1, { ...AI_DIFFICULTY.medium, intelligence: 1 }, state, true) as Internals;
  const inZone = (p: Player, owner: Player): boolean =>
    state.units.some((u: HarnessUnit) => u.player === p && u.hp > 0 && bot.inCastleZone(u.row, u.col, owner));

  let botTurn = botFirst;
  for (let t = 0; t < maxTurns; t += 1) {
    if (botTurn) {
      const { plan } = search(bot as never, state);
      state = plan.length > 0 ? applyPlan(bot as never, state, 2, plan) : bot.applyEndOfTurn(state, 2);
    } else {
      state = policy(ref, state, 1);
    }
    // Win checks, including castle capture (the real win condition).
    if (state.units.every((u: HarnessUnit) => u.player !== 1 || u.hp <= 0)) return 'bot';
    if (state.units.every((u: HarnessUnit) => u.player !== 2 || u.hp <= 0)) return 'opp';
    if (inZone(2, 1) && !inZone(1, 1)) return 'bot';
    if (inZone(1, 2) && !inZone(2, 2)) {
      if (process.env.GAUNTLET_TRACE === '1') {
        const def = state.units.filter((u: HarnessUnit) => u.player === 2 && u.hp > 0 && bot.inCastleZone(u.row, u.col, 2)).length;
        const alive2 = state.units.filter((u: HarnessUnit) => u.player === 2 && u.hp > 0).length;
        console.log(`    CASTLED on turn ${t}: bot had ${alive2} units alive, ${def} defending home`);
      }
      return 'opp';
    }
    botTurn = !botTurn;
  }
  return 'draw';
}

function runGauntlet(): void {
  const games = Number(process.env.GAUNTLET_GAMES ?? '10');
  const budget = Number(process.env.GAUNTLET_BUDGET ?? '300');
  const maxTurns = Number(process.env.GAUNTLET_MAXTURNS ?? '60');
  const cfg: Partial<AIConfig> = {
    ...AI_DIFFICULTY.hard,
    label: 'gauntlet',
    intelligence: 1,
    mctsTimeBudgetMs: budget,
    mctsSelectionTemp: 0,
    trustSearch: true,
    ...(process.env.GAUNTLET_LEGACY === '1'
      ? { legacyPlanGen: true }
      : process.env.GAUNTLET_LEGACY === 'plans'
        ? { legacyPlanGen: true }
        : process.env.GAUNTLET_LEGACY === 'threat'
          ? { accurateThreatModel: true }
          : {}),
  } as Partial<AIConfig>;

  console.log(`\nAI gauntlet — bot vs fixed reference opponents`);
  console.log(`games=${games} budget=${budget}ms maxTurns=${maxTurns}\n`);

  let totalW = 0;
  let totalG = 0;
  for (const [name, policy] of Object.entries(POLICIES)) {
    let w = 0;
    let l = 0;
    let d = 0;
    const t0 = Date.now();
    for (let g = 0; g < games; g += 1) {
      const r = playVersus(cfg, policy, maxTurns, g % 2 === 0);
      if (r === 'bot') w += 1;
      else if (r === 'opp') l += 1;
      else d += 1;
    }
    totalW += w;
    totalG += games;
    const pct = ((w / games) * 100).toFixed(0);
    console.log(
      `  vs ${name.padEnd(7)} ${String(w).padStart(2)}W ${String(l).padStart(2)}L ${String(d).padStart(2)}D   ${pct.padStart(3)}%   (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    );
  }
  console.log(`\n  OVERALL: ${totalW}/${totalG} = ${((totalW / totalG) * 100).toFixed(1)}%`);
  console.log(`  (a genuinely strong bot should be at or near 100% vs all three)\n`);
}

it('ai gauntlet', () => {
  runGauntlet();
}, 3_600_000);
