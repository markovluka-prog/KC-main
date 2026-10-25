/**
 * Static position evaluation for `GameState`, driven by `ai-weights.json`.
 *
 * Originally a faithful port of `evaluateLightState`/`simUnitValue`/
 * `evaluateEconomy` from `packages/web/src/game/ai.ts`, retargeted onto the
 * canonical `GameState`/`SerializedUnit` shape so a state-space search (beam
 * search) can walk `applyAction` directly.
 *
 * The score is LINEAR in the weights: `evalFeatures()` turns a position into a
 * fixed vector of board quantities (FEATURES — hp sums, counts, distances,
 * threat sums...) and `evaluate()` is the dot product of that vector with the
 * weights. That is what lets scripts/fit-chance.mjs fit every weight at once
 * by logistic regression against real game outcomes (chance-weights.json).
 * The few non-linear shape parameters (radii, thresholds, hanging cap, the
 * unitValue() used inside the threat terms) always come from the base
 * `ai-weights.json`, so a feature vector means the same thing whichever weight
 * set it is later scored with.
 *
 * Threat geometry follows the real attack rules in moves.ts/actions.ts
 * (archer square radius, crossbow 8-way line, samurai diagonals, catapult
 * 3..6 band, tower range/damage, the mage's energy-paid attack) instead of the
 * old flat manhattan ranges, which missed most of those threats.
 *
 * The original gated four blocks behind `this.config.*Weight` multipliers that
 * belong to the search layer, not to position evaluation; this port always
 * evaluates all terms at weight 1.
 */
import RAW_WEIGHTS from './ai-weights.json' with { type: 'json' };
import CHANCE_RAW from './chance-weights.json' with { type: 'json' };
import { castleColFor, castleRowFor, inCastleZone } from './apply.js';
import { ARMORS, COLS, ROWS, WEAPONS, BUILD_WORK_TOTAL } from './constants.js';
import { TOWER_DAMAGE_FACTOR } from './combat.js';
import { applyFacingDamage } from './facing.js';
import { archerRadiusFor, catapultMaxRangeFor, CATAPULT_MIN_RANGE, CROSSBOW_PIERCE_RANGE } from './moves.js';
export const W = RAW_WEIGHTS;
/**
 * Weights fitted to win probability under uniformly random play (the "Свой
 * шанс" AI's definition of a position's chance), plus the logistic
 * calibration that turns an evaluation gap into that probability. See
 * scripts/fit-chance.mjs and `winChance()`.
 */
export const CHANCE_W = CHANCE_RAW;
/**
 * Compensates for the missing strategic-overlay layer: brings one cell of
 * advance for an idle unit to ~900 points — enough to consistently beat
 * "stand still" without outweighing an actual tactical opportunity.
 * Measured: with ×1 a full arena game (beam vs greedy) stalled once
 * initial-contact units stopped closing; ×15 fixed it (see scripts/arena.ts).
 * Folded into the approach/hunt features, so the weights stay per-cell.
 */
const CASTLE_APPROACH_MULTIPLIER = 15;
/**
 * Feature names = weight paths into AIWeights, in feature-vector order.
 * evaluate() = Σ weight(path) × feature. Signs live in the features (a
 * penalty feature is negative), so every weight is a positive "how much".
 */
const PART_NAMES = ['Металл', 'Амулет', 'Рубин', 'Дерево', 'Стрелы'];
const TYPE_NAMES = ['cavalry', 'knight', 'samurai', 'crossbow', 'archer', 'catapult', 'mage'];
export const FEATURES = [
    'material.perHp',
    'material.perArmor',
    'material.perDamage',
    'material.perEnergy',
    ...TYPE_NAMES.map((t) => `material.byType.${t}`),
    'material.onTower',
    'material.towerStake',
    'material.presence',
    'material.wipeout',
    'castle.captureUndefended',
    'castle.captureDefended',
    'castle.lossUndefended',
    'castle.lossDefended',
    'castle.raidThreatPerCell',
    'focus.woundedEnemyMax',
    'castle.huntPerCell',
    'retreat.outnumberedHomePerCell',
    'castle.approachPerCell',
    'spacing.rangedAdjacentPenalty',
    'spacing.rangedOptimalBonus',
    'spacing.rangedNearBonus',
    'spacing.catapultTooCloseWithinPenalty',
    'spacing.catapultOptimalBonus',
    'spacing.meleeCloseBonus',
    'spacing.meleeNearBonus',
    'threat.perDamagePoint',
    'threat.perDamagePointTaken',
    'threat.victimValueFraction',
    'threat.lethalValueFraction',
    'threat.killValueFraction',
    'threat.hangingScale',
    'threat.heavilyThreatenedPenalty',
    'cohesion.isolatedPenalty',
    'retreat.lowHpScale',
    ...PART_NAMES.map((p) => `economy.artifactByName.${p}`),
    'economy.completeRecipeBonus',
    'economy.ruinsControlBonus',
    'economy.ruinsApproachPerCell',
    'buffs.shieldPerTurn',
    'buffs.damageBuffPerTurn',
    'tempo.base',
    'tempo.dmgDealt',
    'tempo.dmgTaken',
    'tempo.kill',
    'tempo.hanging',
];
const F = Object.fromEntries(FEATURES.map((n, i) => [n, i]));
const TYPE_F = Object.fromEntries(TYPE_NAMES.map((t) => [t, F[`material.byType.${t}`]]));
const PART_F = PART_NAMES.map((p) => F[`economy.artifactByName.${p}`]);
// Feature indices as plain constants: evalFeatures runs ~100k×/turn and a
// dotted-string lookup into F on every += was its single biggest cost.
const FI_buffs_damageBuffPerTurn = F['buffs.damageBuffPerTurn'];
const FI_buffs_shieldPerTurn = F['buffs.shieldPerTurn'];
const FI_castle_approachPerCell = F['castle.approachPerCell'];
const FI_castle_captureDefended = F['castle.captureDefended'];
const FI_castle_captureUndefended = F['castle.captureUndefended'];
const FI_castle_huntPerCell = F['castle.huntPerCell'];
const FI_castle_lossDefended = F['castle.lossDefended'];
const FI_castle_lossUndefended = F['castle.lossUndefended'];
const FI_castle_raidThreatPerCell = F['castle.raidThreatPerCell'];
const FI_cohesion_isolatedPenalty = F['cohesion.isolatedPenalty'];
const FI_economy_completeRecipeBonus = F['economy.completeRecipeBonus'];
const FI_economy_ruinsApproachPerCell = F['economy.ruinsApproachPerCell'];
const FI_economy_ruinsControlBonus = F['economy.ruinsControlBonus'];
const FI_focus_woundedEnemyMax = F['focus.woundedEnemyMax'];
const FI_material_onTower = F['material.onTower'];
const FI_material_towerStake = F['material.towerStake'];
const FI_material_perArmor = F['material.perArmor'];
const FI_material_perDamage = F['material.perDamage'];
const FI_material_perEnergy = F['material.perEnergy'];
const FI_material_perHp = F['material.perHp'];
const FI_material_presence = F['material.presence'];
const FI_material_wipeout = F['material.wipeout'];
const FI_retreat_lowHpScale = F['retreat.lowHpScale'];
const FI_retreat_outnumberedHomePerCell = F['retreat.outnumberedHomePerCell'];
const FI_spacing_catapultOptimalBonus = F['spacing.catapultOptimalBonus'];
const FI_spacing_catapultTooCloseWithinPenalty = F['spacing.catapultTooCloseWithinPenalty'];
const FI_spacing_meleeCloseBonus = F['spacing.meleeCloseBonus'];
const FI_spacing_meleeNearBonus = F['spacing.meleeNearBonus'];
const FI_spacing_rangedAdjacentPenalty = F['spacing.rangedAdjacentPenalty'];
const FI_spacing_rangedNearBonus = F['spacing.rangedNearBonus'];
const FI_spacing_rangedOptimalBonus = F['spacing.rangedOptimalBonus'];
const FI_tempo_base = F['tempo.base'];
const FI_tempo_dmgDealt = F['tempo.dmgDealt'];
const FI_tempo_dmgTaken = F['tempo.dmgTaken'];
const FI_tempo_hanging = F['tempo.hanging'];
const FI_tempo_kill = F['tempo.kill'];
const FI_threat_hangingScale = F['threat.hangingScale'];
const FI_threat_heavilyThreatenedPenalty = F['threat.heavilyThreatenedPenalty'];
const FI_threat_killValueFraction = F['threat.killValueFraction'];
const FI_threat_lethalValueFraction = F['threat.lethalValueFraction'];
const FI_threat_perDamagePoint = F['threat.perDamagePoint'];
const FI_threat_perDamagePointTaken = F['threat.perDamagePointTaken'];
const FI_threat_victimValueFraction = F['threat.victimValueFraction'];
function weightAt(w, path) {
    let v = w;
    for (const k of path.split('.'))
        v = v?.[k];
    return typeof v === 'number' ? v : 0;
}
/**
 * A copy of `base` with some weights multiplied, by FEATURES path — e.g.
 * { 'castle.approachPerCell': 2 }. How a personality tilts the search.
 */
export function scaleWeights(mult, base = W) {
    const out = JSON.parse(JSON.stringify(base));
    for (const [path, m] of Object.entries(mult)) {
        const ks = path.split('.');
        let o = out;
        for (const k of ks.slice(0, -1))
            o = o[k];
        const last = ks[ks.length - 1];
        if (typeof o[last] === 'number')
            o[last] = o[last] * m;
    }
    return out;
}
/** Weight vector in FEATURES order (cached per weight object). */
const VEC_CACHE = new WeakMap();
export function weightVector(w) {
    let v = VEC_CACHE.get(w);
    if (!v) {
        v = Float64Array.from(FEATURES, (p) => weightAt(w, p));
        VEC_CACHE.set(w, v);
    }
    return v;
}
function manhattan(r1, c1, r2, c2) {
    return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}
/** Distance used for cells a walker can't reach at all (walled off). */
const UNREACHABLE = 60;
/** Path cost of one river cell (≈ the turns a bridge or leap costs). */
const RIVER_STEP = 4;
/**
 * Walking distance from every cell to `player`'s castle zone, around rivers,
 * mountains, rocks and unfinished build sites (units ignored — they move).
 * Manhattan distance used to drive the castle approach, and it trapped whole
 * armies: a river between them and the castle made every detour score worse,
 * so a 10-vs-2 army sat 11 cells from the castle for 150 turns (measured,
 * greedy seed 3). Cached per terrain array (cloneState shares it by
 * reference; it only changes when a bridge is built or burned).
 */
const PATH_CACHE = new WeakMap();
/** Last field returned per player — the search asks for the same one ~100k×. */
const PATH_LAST = [null, null, null];
function castlePathField(state, player) {
    const last = PATH_LAST[player];
    const col = castleColFor(state, player);
    if (last && last.terrain === state.terrain && last.sites === state.constructions && last.col === col)
        return last.field;
    const field = castlePathFieldSlow(state, player);
    PATH_LAST[player] = { terrain: state.terrain, sites: state.constructions, col, field };
    return field;
}
function castlePathFieldSlow(state, player) {
    let byKey = PATH_CACHE.get(state.terrain);
    if (!byKey) {
        byKey = new Map();
        PATH_CACHE.set(state.terrain, byKey);
    }
    const sites = state.constructions ?? [];
    const key = `${player}:${castleColFor(state, player)}:${sites.map((c) => `${c.kind[0]}${c.row * COLS + c.col}`).join(',')}`;
    let field = byKey.get(key);
    if (field)
        return field;
    // Step cost per cell: 1 on open ground, RIVER_STEP on water (crossing
    // means building a bridge or a cavalry leap — slow, but never impossible:
    // some maps have an unbroken river and no bridge at all), 0 = impassable.
    const N = COLS * ROWS;
    const cost = new Uint8Array(N).fill(1);
    const inside = (t) => t.row >= 0 && t.row < ROWS && t.col >= 0 && t.col < COLS;
    for (const t of state.terrain) {
        if (!inside(t))
            continue;
        if (t.type === 'river')
            cost[t.row * COLS + t.col] = RIVER_STEP;
        else if (t.type === 'mountain' || t.type === 'rock')
            cost[t.row * COLS + t.col] = 0;
    }
    for (const t of state.terrain)
        if (t.type === 'bridge' && inside(t))
            cost[t.row * COLS + t.col] = 1;
    // A bridge under construction is nearly a bridge (rewards building it); a
    // tower site blocks the cell like the finished tower's footprint would.
    for (const c of sites)
        if (inside(c))
            cost[c.row * COLS + c.col] = c.kind === 'bridge' ? 2 : 0;
    // Dijkstra with a bucket queue (costs are tiny integers).
    field = new Int8Array(N).fill(UNREACHABLE);
    const buckets = Array.from({ length: UNREACHABLE + 1 }, () => []);
    const r0 = castleRowFor(player);
    const c0 = castleColFor(state, player);
    for (let r = r0; r < r0 + 4; r++)
        for (let c = c0; c < c0 + 4; c++) {
            if (r < 0 || r >= ROWS || c < 0 || c >= COLS)
                continue;
            field[r * COLS + c] = 0;
            buckets[0].push(r * COLS + c);
        }
    for (let d = 0; d < UNREACHABLE; d++) {
        for (const i of buckets[d]) {
            if (field[i] !== d)
                continue;
            const r = (i / COLS) | 0;
            const c = i % COLS;
            const nb = [r > 0 ? i - COLS : -1, r < ROWS - 1 ? i + COLS : -1, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1];
            for (const j of nb) {
                if (j < 0 || cost[j] === 0)
                    continue;
                const nd = d + cost[j];
                if (nd >= UNREACHABLE || field[j] <= nd)
                    continue;
                field[j] = nd;
                buckets[nd].push(j);
            }
        }
    }
    byKey.set(key, field);
    return field;
}
/** True if (row,col) sits inside any ruins area on the board. */
function inRuins(state, row, col) {
    const areas = [state.ruins, state.ruins2].filter((a) => !!a && a.width > 0 && a.height > 0);
    return areas.some((a) => row >= a.top && row < a.top + a.height && col >= a.left && col < a.left + a.width);
}
/**
 * Standalone piece value — hp/armor/damage/type terms only, no positional
 * context. Always priced with the base weights (it shapes the threat
 * features, see the file comment).
 */
export function unitValue(u) {
    return (u.hp * W.material.perHp +
        u.armor * W.material.perArmor +
        u.damage * W.material.perDamage +
        (W.material.byType[u.type] ?? W.material.byType.archer));
}
function isRanged(type) {
    return type === 'archer' || type === 'crossbow' || type === 'catapult';
}
/**
 * Raw damage `a` can deal to `t` from where it stands right now (before
 * armor), or -1 when the attack rules don't let it reach. Mirrors
 * generateAttackActions/generateMageActions; the mage hits for whatever
 * energy is left after paying for distance.
 */
function hitDamage(state, a, t, aOnTower) {
    const dr = Math.abs(a.row - t.row);
    const dc = Math.abs(a.col - t.col);
    // Nothing but the mage and the catapult reaches past 3 cells (archer on a tower).
    if ((dr > 3 || dc > 3) && a.type !== 'mage' && a.type !== 'catapult')
        return -1;
    const cheb = Math.max(dr, dc);
    let ok;
    switch (a.type) {
        case 'knight':
        case 'cavalry':
            ok = dr + dc === 1;
            break;
        case 'samurai':
            ok = cheb === 1;
            break;
        case 'archer':
            ok = cheb <= archerRadiusFor(aOnTower);
            break;
        case 'crossbow':
            ok = (dr === 0 || dc === 0 || dr === dc) && cheb <= CROSSBOW_PIERCE_RANGE;
            break;
        case 'catapult':
            ok = dr + dc >= CATAPULT_MIN_RANGE && dr + dc <= catapultMaxRangeFor(aOnTower);
            break;
        case 'mage':
            return Math.max(-1, applyFacingDamage((a.energy ?? 0) - cheb, t, a.row, a.col));
        default:
            ok = dr + dc === 1;
    }
    if (!ok)
        return -1;
    let dmg = a.damage;
    if (aOnTower && isRanged(a.type))
        dmg = Math.max(1, Math.round(dmg * TOWER_DAMAGE_FACTOR));
    if (state.damageBuff[a.player] > 0)
        dmg += 2;
    // Facing: a unit standing in its victim's back half hits ×2 (facing.ts).
    return applyFacingDamage(dmg, t, a.row, a.col);
}
/**
 * Damage `a` could deal to `t` next turn after walking (the hanging-piece
 * scan): manhattan reach = walk + attack reach. Catapults are slow (1 cell)
 * and can't fire point-blank, as before.
 */
function reachDamage(state, a, t, aOnTower) {
    const dist = manhattan(a.row, a.col, t.row, t.col);
    const cheb = Math.max(Math.abs(a.row - t.row), Math.abs(a.col - t.col));
    let reach;
    switch (a.type) {
        case 'samurai':
            reach = 2;
            break;
        case 'archer':
            reach = 2 * archerRadiusFor(aOnTower);
            break;
        case 'crossbow':
            reach = 2 * CROSSBOW_PIERCE_RANGE;
            break;
        case 'catapult':
            if (dist < CATAPULT_MIN_RANGE)
                return -1;
            reach = catapultMaxRangeFor(aOnTower);
            break;
        case 'mage':
            return Math.max(-1, (a.energy ?? 0) - Math.max(0, cheb - a.maxMoves));
        default:
            reach = 1;
    }
    const move = a.type === 'catapult' ? 1 : a.maxMoves;
    if (dist > move + reach)
        return -1;
    let dmg = a.damage;
    if (aOnTower && isRanged(a.type))
        dmg = Math.max(1, Math.round(dmg * TOWER_DAMAGE_FACTOR));
    if (state.damageBuff[a.player] > 0)
        dmg += 2;
    return dmg;
}
/** Ids of living mages, refreshed per evalFeatures() call (ward checks). */
const LIVE_MAGES = new Set();
// Per-unit scratch for the fused pair pass in evalFeatures (no per-call allocation).
let MIN_DIST = new Float64Array(32);
let MY_BEST = new Float64Array(32);
let MY_KILL = new Float64Array(32);
let THREAT_TOTAL = new Float64Array(32);
let MY_TOWER = new Uint8Array(32);
let MY_VAL = new Float64Array(32);
let OPP_BEST = new Float64Array(32);
let OPP_VICTIM = new Float64Array(32);
let OPP_LETHAL = new Uint8Array(32);
let OPP_TOWER = new Uint8Array(32);
let OPP_VAL = new Float64Array(32);
function growPairBuffers(n) {
    MIN_DIST = new Float64Array(n);
    MY_BEST = new Float64Array(n);
    MY_KILL = new Float64Array(n);
    THREAT_TOTAL = new Float64Array(n);
    MY_TOWER = new Uint8Array(n);
    MY_VAL = new Float64Array(n);
    OPP_BEST = new Float64Array(n);
    OPP_VICTIM = new Float64Array(n);
    OPP_LETHAL = new Uint8Array(n);
    OPP_TOWER = new Uint8Array(n);
    OPP_VAL = new Float64Array(n);
}
function afterArmor(state, raw, t) {
    // A ward from a living mage absorbs the whole hit (the mage pays energy).
    if (t.wardedBy && LIVE_MAGES.has(t.wardedBy))
        return 0;
    let dmg = Math.max(0, raw - t.armor);
    if (state.shieldTurns[t.player] > 0)
        dmg = Math.max(0, dmg - 2);
    return dmg;
}
/**
 * Fill `out` (length FEATURES.length) with the board quantities of `state`
 * from `me`'s perspective. Each block matches a GOAL comment of the original
 * evaluateLightState.
 */
export function evalFeatures(state, me, out = new Float64Array(FEATURES.length)) {
    out.fill(0);
    const opp = me === 1 ? 2 : 1;
    const myUnits = [];
    const oppUnits = [];
    const towerList = state.towers;
    const onTower = (u) => {
        for (let i = 0; i < towerList.length; i++)
            if (towerList[i].row === u.row && towerList[i].col === u.col)
                return true;
        return false;
    };
    LIVE_MAGES.clear();
    for (const u of state.units)
        if (u.type === 'mage' && u.hp > 0)
            LIVE_MAGES.add(u.id);
    for (const u of state.units) {
        if (u.hp <= 0)
            continue;
        const sign = u.player === me ? 1 : -1;
        (sign > 0 ? myUnits : oppUnits).push(u);
        out[FI_material_perHp] += sign * u.hp;
        out[FI_material_perArmor] += sign * u.armor;
        out[FI_material_perDamage] += sign * u.damage;
        out[FI_material_perEnergy] += sign * (u.energy ?? 0);
        out[TYPE_F[u.type] ?? TYPE_F.archer] += sign;
        if (onTower(u))
            out[FI_material_onTower] += sign;
    }
    // Towers and tower sites are neutral, so without this a half-built tower is
    // worth nothing and finishing it is worth nothing. Credit each one (progress
    // as a fraction of BUILD_WORK_TOTAL, finished = 1) to the side with the
    // nearest unit within 3 cells, so starting, continuing and completing a
    // tower each raise the score.
    const credit = (r, c, frac) => {
        let best = 4, side = 0;
        for (const u of state.units) {
            if (u.hp <= 0)
                continue;
            const d = Math.abs(u.row - r) + Math.abs(u.col - c);
            if (d < best) {
                best = d;
                side = u.player === me ? 1 : -1;
            }
            else if (d === best && side !== (u.player === me ? 1 : -1))
                side = 0;
        }
        out[FI_material_towerStake] += side * frac;
    };
    for (const t of towerList)
        credit(t.row, t.col, 1);
    for (const c of state.constructions ?? [])
        if (c.kind === 'tower')
            credit(c.row, c.col, Math.min(1, c.progress / BUILD_WORK_TOTAL));
    const myCount = myUnits.length;
    const oppCount = oppUnits.length;
    out[FI_material_presence] = myCount - oppCount;
    out[FI_material_wipeout] = (oppCount === 0 ? 1 : 0) - (myCount === 0 ? 1 : 0);
    // ── GOAL 1/2: Castle capture / defense ──────────────────────────────────
    const oppCastleRow = castleRowFor(opp);
    const oppCastleCol = castleColFor(state, opp);
    const myCastleRow = castleRowFor(me);
    const myCastleCol = castleColFor(state, me);
    const myUnitInEnemyCastle = myUnits.some((u) => inCastleZone(u, oppCastleRow, oppCastleCol));
    const oppDefendingOwnCastle = oppUnits.some((u) => inCastleZone(u, oppCastleRow, oppCastleCol));
    if (myUnitInEnemyCastle && !oppDefendingOwnCastle)
        out[FI_castle_captureUndefended] = 1;
    else if (myUnitInEnemyCastle)
        out[FI_castle_captureDefended] = 1;
    const oppInMyCastle = oppUnits.some((u) => inCastleZone(u, myCastleRow, myCastleCol));
    const myDefendingOwnCastle = myUnits.some((u) => inCastleZone(u, myCastleRow, myCastleCol));
    if (oppInMyCastle && !myDefendingOwnCastle)
        out[FI_castle_lossUndefended] = -1;
    else if (oppInMyCastle)
        out[FI_castle_lossDefended] = -1;
    // ── GOAL 2b: Anticipate the raid ────────────────────────────────────────
    if (!oppInMyCastle && !myDefendingOwnCastle) {
        let nearest = Infinity;
        for (const ou of oppUnits)
            nearest = Math.min(nearest, manhattan(ou.row, ou.col, myCastleRow + 2, myCastleCol + 2));
        if (nearest <= W.castle.raidThreatRadius)
            out[FI_castle_raidThreatPerCell] = -(W.castle.raidThreatRadius + 1 - nearest);
    }
    // ── GOAL 3: Finish wounded enemies ──────────────────────────────────────
    for (const ou of oppUnits)
        if (ou.hp < ou.maxHp)
            out[FI_focus_woundedEnemyMax] += 1 - ou.hp / ou.maxHp;
    // ── One pass over every (mine, theirs) pair ────────────────────────────
    // Distances, both directions of "who can hit whom from here", and next-turn
    // reach, all at once — this used to be six separate pair loops and was
    // most of the evaluation's cost (evaluate runs ~100k× per searched turn).
    // Iteration order matches the old loops, so ties resolve identically.
    const nM = myCount;
    const nO = oppCount;
    if (MIN_DIST.length < nM)
        growPairBuffers(Math.max(nM, nO) * 2);
    if (OPP_BEST.length < nO)
        growPairBuffers(Math.max(nM, nO) * 2);
    for (let a = 0; a < nM; a++) {
        MIN_DIST[a] = 99;
        MY_BEST[a] = 0;
        MY_KILL[a] = 0;
        THREAT_TOTAL[a] = 0;
        MY_TOWER[a] = onTower(myUnits[a]) ? 1 : 0;
        MY_VAL[a] = unitValue(myUnits[a]);
    }
    for (let b = 0; b < nO; b++) {
        OPP_BEST[b] = 0;
        OPP_VICTIM[b] = 0;
        OPP_LETHAL[b] = 0;
        OPP_TOWER[b] = onTower(oppUnits[b]) ? 1 : 0;
        OPP_VAL[b] = unitValue(oppUnits[b]);
    }
    for (let a = 0; a < nM; a++) {
        const mu = myUnits[a];
        for (let b = 0; b < nO; b++) {
            const ou = oppUnits[b];
            const d = manhattan(mu.row, mu.col, ou.row, ou.col);
            if (d < MIN_DIST[a])
                MIN_DIST[a] = d;
            // they hit me (from where they stand)
            let raw = hitDamage(state, ou, mu, OPP_TOWER[b] === 1);
            if (raw >= 0) {
                const dmg = afterArmor(state, raw, mu);
                if (dmg > OPP_BEST[b]) {
                    OPP_BEST[b] = dmg;
                    OPP_VICTIM[b] = MY_VAL[a];
                    OPP_LETHAL[b] = dmg >= mu.hp ? 1 : 0;
                }
            }
            // I hit them
            raw = hitDamage(state, mu, ou, MY_TOWER[a] === 1);
            if (raw >= 0) {
                const dmg = afterArmor(state, raw, ou);
                if (dmg > MY_BEST[a]) {
                    MY_BEST[a] = dmg;
                    MY_KILL[a] = dmg >= ou.hp ? OPP_VAL[b] : 0;
                }
            }
            // they can reach me next turn
            raw = reachDamage(state, ou, mu, OPP_TOWER[b] === 1);
            if (raw >= 0)
                THREAT_TOTAL[a] += afterArmor(state, raw, mu);
        }
    }
    // ── GOAL 3b: Hunt down the last survivors ────────────────────────────────
    // Only once the opponent is crippled (≤4 units AND outnumbered ≥2:1): a
    // dominant army otherwise stalls, since nothing pulls it onto the scattered
    // last defenders (measured: 30+ idle turns at 8-vs-3).
    if (oppCount > 0 && oppCount <= 4 && myCount >= oppCount * 2) {
        let nearestPairDist = Infinity;
        for (let a = 0; a < nM; a++)
            if (MIN_DIST[a] < nearestPairDist)
                nearestPairDist = MIN_DIST[a];
        out[FI_castle_huntPerCell] = Math.max(0, 28 - nearestPairDist) * CASTLE_APPROACH_MULTIPLIER;
    }
    // ── GOAL 4: Outnumbered? retreat toward own castle ───────────────────────
    if (myCount < oppCount) {
        for (const mu of myUnits) {
            const distHome = manhattan(mu.row, mu.col, myCastleRow + 2, myCastleCol + 2);
            out[FI_retreat_outnumberedHomePerCell] +=
                Math.max(0, W.retreat.outnumberedHomeRadius - distHome) * (oppCount - myCount);
        }
    }
    // ── Castle approach ──────────────────────────────────────────────────────
    {
        // Walking distance to the castle zone (+2 ≈ the old distance-to-centre
        // offset, keeping the scale of approachPerCell).
        const toOpp = castlePathField(state, opp);
        const toMe = castlePathField(state, me);
        let myAdvance = 0;
        let oppAdvance = 0;
        for (const u of myUnits)
            myAdvance += 28 - (toOpp[u.row * COLS + u.col] + 2);
        for (const u of oppUnits)
            oppAdvance += 28 - (toMe[u.row * COLS + u.col] + 2);
        out[FI_castle_approachPerCell] = (myAdvance - 0.4 * oppAdvance) * CASTLE_APPROACH_MULTIPLIER;
    }
    // ── GOAL 5: Spacing — ranged keep distance, melee close in ───────────────
    for (let a = 0; a < nM; a++) {
        const mu = myUnits[a];
        const minDist = MIN_DIST[a];
        if (mu.type === 'archer' || mu.type === 'crossbow') {
            if (minDist <= 1)
                out[FI_spacing_rangedAdjacentPenalty] -= 1;
            else if (minDist === 2)
                out[FI_spacing_rangedOptimalBonus] += 1;
            else if (minDist <= 4)
                out[FI_spacing_rangedNearBonus] += 1;
        }
        else if (mu.type === 'catapult') {
            if (minDist < 3)
                out[FI_spacing_catapultTooCloseWithinPenalty] -= 1;
            else if (minDist <= 6)
                out[FI_spacing_catapultOptimalBonus] += 1;
        }
        else {
            if (minDist <= 2)
                out[FI_spacing_meleeCloseBonus] += 1;
            else if (minDist <= 4)
                out[FI_spacing_meleeNearBonus] += 1;
        }
    }
    // ── Opponent threat / counter potential (from current squares) ──────────
    let dealt = 0;
    let taken = 0;
    let kills = 0;
    if (nO > 0 && nM > 0) {
        for (let b = 0; b < nO; b++) {
            taken += OPP_BEST[b];
            if (OPP_BEST[b] >= 1)
                out[FI_threat_victimValueFraction] -= OPP_VICTIM[b];
            if (OPP_LETHAL[b] === 1)
                out[FI_threat_lethalValueFraction] -= OPP_VICTIM[b];
        }
        for (let a = 0; a < nM; a++) {
            dealt += MY_BEST[a];
            kills += MY_KILL[a];
        }
    }
    out[FI_threat_perDamagePoint] = dealt;
    out[FI_threat_perDamagePointTaken] = -taken;
    out[FI_threat_killValueFraction] = kills;
    // ── Cohesion ────────────────────────────────────────────────────────────
    if (myUnits.length > 1) {
        for (const mu of myUnits) {
            let nearby = false;
            for (const al of myUnits) {
                if (al.id !== mu.id && manhattan(mu.row, mu.col, al.row, al.col) <= W.cohesion.radius) {
                    nearby = true;
                    break;
                }
            }
            if (!nearby)
                out[FI_cohesion_isolatedPenalty] -= 1;
        }
    }
    // ── Hanging piece penalty (reachable next turn) ──────────────────────────
    let hanging = 0;
    for (let a = 0; a < nM; a++) {
        const mu = myUnits[a];
        const totalThreat = THREAT_TOTAL[a];
        if (totalThreat >= mu.hp) {
            hanging -= Math.min(W.threat.hangingMax, W.threat.hangingBase + MY_VAL[a] * W.threat.hangingValueFraction);
        }
        else if (totalThreat > mu.hp * W.threat.heavilyThreatenedRatio) {
            out[FI_threat_heavilyThreatenedPenalty] -= 1;
        }
    }
    out[FI_threat_hangingScale] = hanging;
    // ── Low-HP retreat nudge ───────────────────────────────────────────────
    for (let a = 0; a < nM; a++) {
        const mu = myUnits[a];
        if (mu.hp >= mu.maxHp * W.retreat.lowHpThreshold)
            continue;
        out[FI_retreat_lowHpScale] += Math.min(W.retreat.lowHpDistBonusMax, MIN_DIST[a] * W.retreat.lowHpDistBonusPerCell * (1 - mu.hp / mu.maxHp));
    }
    // ── Side to move ────────────────────────────────────────────────────────
    // The same threat is worth more to whoever acts next: t = +1 on my move.
    const t = state.currentPlayer === me ? 1 : -1;
    out[FI_tempo_base] = t;
    out[FI_tempo_dmgDealt] = t * dealt;
    out[FI_tempo_dmgTaken] = -t * taken;
    out[FI_tempo_kill] = t * kills;
    out[FI_tempo_hanging] = t * hanging;
    economyFeatures(state, me, myUnits, out);
    return out;
}
/**
 * Economy — weapon parts held (summed across every unit's own backpack),
 * recipes completed, ruins control, active buffs.
 */
/** Every weapon/armour recipe as [part index, count] pairs, built once. */
const RECIPES = [...WEAPONS, ...ARMORS].map((x) => Object.keys(x.recipe).map((p) => [PART_NAMES.indexOf(p), x.recipe[p] ?? 0]));
const INV = new Float64Array(PART_NAMES.length);
function economyFeatures(state, me, myUnits, out) {
    INV.fill(0);
    for (const u of myUnits)
        for (let i = 0; i < PART_NAMES.length; i++)
            INV[i] += u.backpack[PART_NAMES[i]] ?? 0;
    for (let i = 0; i < PART_NAMES.length; i++)
        if (INV[i] > 0)
            out[PART_F[i]] = INV[i];
    for (const recipe of RECIPES) {
        let ok = true;
        for (const [i, n] of recipe)
            if (INV[i] < n) {
                ok = false;
                break;
            }
        if (ok)
            out[FI_economy_completeRecipeBonus] += 1;
    }
    const r1 = state.ruins && state.ruins.width > 0 && state.ruins.height > 0 ? state.ruins : null;
    const r2 = state.ruins2 && state.ruins2.width > 0 && state.ruins2.height > 0 ? state.ruins2 : null;
    const ruinsAreas = r1 && r2 ? [r1, r2] : r1 ? [r1] : r2 ? [r2] : [];
    if (ruinsAreas.length > 0 && myUnits.some((u) => inRuins(state, u.row, u.col)))
        out[FI_economy_ruinsControlBonus] = 1;
    if (ruinsAreas.length > 0 && myUnits.length > 0) {
        let nearest = Infinity;
        for (const u of myUnits)
            for (const r of ruinsAreas)
                nearest = Math.min(nearest, manhattan(u.row, u.col, r.top + Math.floor(r.height / 2), r.left + Math.floor(r.width / 2)));
        if (nearest <= W.economy.ruinsApproachRadius)
            out[FI_economy_ruinsApproachPerCell] = W.economy.ruinsApproachRadius - nearest;
    }
    const opp = me === 1 ? 2 : 1;
    out[FI_buffs_shieldPerTurn] = (state.shieldTurns[me] ?? 0) - (state.shieldTurns[opp] ?? 0);
    out[FI_buffs_damageBuffPerTurn] = (state.damageBuff[me] ?? 0) - (state.damageBuff[opp] ?? 0);
}
const SCRATCH = new Float64Array(FEATURES.length);
/**
 * Static evaluation of `state` from `me`'s perspective — Σ weight × feature.
 * Higher is better for `me`. `w` defaults to the base ai-weights.json.
 */
export function evaluate(state, me, w = W) {
    const f = evalFeatures(state, me, SCRATCH);
    const v = weightVector(w);
    let score = 0;
    for (let i = 0; i < f.length; i++)
        score += f[i] * v[i];
    return score;
}
/**
 * `player`'s win chance in `state` under uniformly random play, from the
 * fitted CHANCE_W: N = 1 / (1 + e^(−(E(me) − E(opp) ± bias) / scale)).
 * Decided games return exactly 1 / 0.
 */
export function winChance(state, player) {
    if (state.winner !== null)
        return state.winner === player ? 1 : 0;
    const opp = player === 1 ? 2 : 1;
    const { scale, biasP1 } = CHANCE_W.calibration;
    const d = evaluate(state, player, CHANCE_W) - evaluate(state, opp, CHANCE_W) + (player === 1 ? biasP1 : -biasP1);
    return 1 / (1 + Math.exp(-d / scale));
}
//# sourceMappingURL=evaluate.js.map