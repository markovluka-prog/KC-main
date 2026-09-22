/**
 * Static position evaluation for `GameState`, driven by `ai-weights.json`.
 *
 * This is a faithful port of `evaluateLightState`/`simUnitValue`/`evaluateEconomy`
 * from `packages/web/src/game/ai.ts`, retargeted from that file's private
 * `LightState`/`LightUnit` mirror onto the canonical `GameState`/`SerializedUnit`
 * shape so a state-space search (beam search) can walk `applyAction` directly
 * instead of needing a live `main.ts` game object to snapshot from.
 *
 * Every weight, formula and code comment below is carried over verbatim from
 * the original — this file changes WHERE the evaluation runs, not what it
 * computes. Keep it in sync with ai.ts's evaluateLightState by hand until the
 * web AI is migrated to call this instead (see plan step 6).
 *
 * One deliberate difference: the original gated four blocks (castle approach,
 * opponent-threat, cohesion, economy) behind `this.config.*Weight` multipliers
 * that some AI difficulty presets zero out entirely. Those multipliers belong
 * to the *search* layer (how hard to think), not to position evaluation
 * itself, so this port always evaluates all terms at weight 1 — a single
 * canonical `evaluate()` any search depth can call. If a preset wants a
 * cheaper/coarser eval, that's the search's job to special-case, not this
 * function's.
 */
import RAW_WEIGHTS from './ai-weights.json' with { type: 'json' };
import { castleColFor, castleRowFor, inCastleZone } from './apply.js';
import { ARMORS, WEAPONS } from './constants.js';
export const W = RAW_WEIGHTS;
/**
 * Compensates for the missing strategic-overlay layer (see the castle
 * approach block below for the full rationale). 15× brings one cell of
 * advance for an idle unit to ~900 points — comparable to a single spacing
 * bonus (300-1500) or a fraction of the hanging-piece penalty (2500-12000),
 * enough to consistently beat "stand still" without letting open-field
 * marching outweigh an actual tactical opportunity in front of the unit.
 * Measured: with the ×1 baseline, a full arena game (beam vs greedy) stalled
 * turn after turn once initial-contact units stopped closing; ×15 fixed it
 * (see scripts/arena.ts).
 */
const CASTLE_APPROACH_MULTIPLIER = 15;
function manhattan(r1, c1, r2, c2) {
    return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}
/** True if (row,col) sits inside any ruins area on the board. */
function inRuins(state, row, col) {
    const areas = [state.ruins, state.ruins2].filter((a) => !!a && a.width > 0 && a.height > 0);
    return areas.some((a) => row >= a.top && row < a.top + a.height && col >= a.left && col < a.left + a.width);
}
/**
 * Standalone piece value — hp/armor/damage/type terms only, no positional
 * context. Used both inline (material term) and by callers (e.g. a future
 * beam search's combo/trade profitability checks) that need "how much is
 * this unit worth" without re-deriving the formula.
 */
export function unitValue(u) {
    return (u.hp * W.material.perHp +
        u.armor * W.material.perArmor +
        u.damage * W.material.perDamage +
        (W.material.byType[u.type] ?? W.material.byType.archer));
}
/** Attack range (in cells) used by the threat model — mirrors ai.ts's inline ternaries. */
function threatRange(type) {
    return type === 'archer' || type === 'crossbow' ? 2 : type === 'catapult' ? 6 : 1;
}
/**
 * Static evaluation of `state` from `me`'s perspective. Higher is better for
 * `me`. Every GOAL-labelled block below matches a comment block in the
 * original evaluateLightState — kept for diffability against ai.ts.
 */
export function evaluate(state, me) {
    const opp = me === 1 ? 2 : 1;
    let score = 0;
    let myCount = 0;
    let oppCount = 0;
    const myUnits = [];
    const oppUnits = [];
    for (const u of state.units) {
        if (u.hp <= 0)
            continue;
        if (u.player === me) {
            myUnits.push(u);
            myCount += 1;
        }
        else {
            oppUnits.push(u);
            oppCount += 1;
        }
        const sign = u.player === me ? 1 : -1;
        score += sign * (u.hp * W.material.perHp + u.armor * W.material.perArmor + u.damage * W.material.perDamage);
        score += sign * (W.material.byType[u.type] ?? W.material.byType.archer);
        if (state.towers.some((t) => t.row === u.row && t.col === u.col))
            score += sign * W.material.onTower;
    }
    score += (myCount - oppCount) * W.material.presence;
    if (myCount === 0)
        score -= W.material.wipeout;
    if (oppCount === 0)
        score += W.material.wipeout;
    // ── GOAL 1: Castle capture — near-win signal ─────────────────────────────
    const oppCastleRow = castleRowFor(opp);
    const oppCastleCol = castleColFor(state, opp);
    const myCastleRow = castleRowFor(me);
    const myCastleCol = castleColFor(state, me);
    const myUnitInEnemyCastle = myUnits.some((u) => inCastleZone(u, oppCastleRow, oppCastleCol));
    const oppDefendingOwnCastle = oppUnits.some((u) => inCastleZone(u, oppCastleRow, oppCastleCol));
    if (myUnitInEnemyCastle && !oppDefendingOwnCastle)
        score += W.castle.captureUndefended;
    else if (myUnitInEnemyCastle)
        score += W.castle.captureDefended;
    // ── GOAL 2: Castle defense — threat signal ───────────────────────────────
    const oppInMyCastle = oppUnits.some((u) => inCastleZone(u, myCastleRow, myCastleCol));
    const myDefendingOwnCastle = myUnits.some((u) => inCastleZone(u, myCastleRow, myCastleCol));
    if (oppInMyCastle && !myDefendingOwnCastle)
        score -= W.castle.lossUndefended;
    else if (oppInMyCastle)
        score -= W.castle.lossDefended;
    // ── GOAL 2b: Anticipate the raid ────────────────────────────────────────
    if (!oppInMyCastle && !myDefendingOwnCastle) {
        const homeRow = myCastleRow + 2;
        const homeCol = myCastleCol + 2;
        let nearest = Infinity;
        for (const ou of oppUnits) {
            const d = manhattan(ou.row, ou.col, homeRow, homeCol);
            if (d < nearest)
                nearest = d;
        }
        if (nearest <= W.castle.raidThreatRadius)
            score -= (W.castle.raidThreatRadius + 1 - nearest) * W.castle.raidThreatPerCell;
    }
    // ── GOAL 3: Finish wounded enemies ──────────────────────────────────────
    for (const ou of oppUnits) {
        if (ou.hp < ou.maxHp)
            score += (1 - ou.hp / ou.maxHp) * W.focus.woundedEnemyMax;
    }
    // ── GOAL 3b: Hunt down the last survivors ────────────────────────────────
    // material.wipeout only fires once oppCount hits exactly 0 — no single move
    // against a scattered handful of survivors gets there, so nothing pulled
    // the army toward finishing them off. Measured: with a dominant 8-vs-3
    // material lead and the last defenders scattered (one alone in a corner),
    // the beam search stalled in place for 30+ turns instead of running them
    // down or storming the now-lightly-defended castle — the position already
    // "looked fine" by every other term, so nothing rewarded doing anything
    // about it. This only activates once the opponent is already crippled
    // (≤4 units AND outnumbered ≥2:1), so it never distorts an even fight —
    // early-game jockeying is still governed by castle-approach/threat/spacing.
    if (oppCount > 0 && oppCount <= 4 && myCount >= oppCount * 2) {
        let nearestPairDist = Infinity;
        for (const mu of myUnits) {
            for (const ou of oppUnits) {
                const d = manhattan(mu.row, mu.col, ou.row, ou.col);
                if (d < nearestPairDist)
                    nearestPairDist = d;
            }
        }
        // Same per-cell weight as castle-approach so "go finish them" competes on
        // the same footing as "go take the castle" instead of one drowning the other.
        score += Math.max(0, 28 - nearestPairDist) * W.castle.approachPerCell * CASTLE_APPROACH_MULTIPLIER;
    }
    // ── GOAL 4: Outnumbered? retreat toward own castle ───────────────────────
    if (myCount < oppCount) {
        const homeCenterRow = myCastleRow + 2;
        const homeCenterCol = myCastleCol + 2;
        for (const mu of myUnits) {
            const distHome = manhattan(mu.row, mu.col, homeCenterRow, homeCenterCol);
            score +=
                Math.max(0, W.retreat.outnumberedHomeRadius - distHome) *
                    W.retreat.outnumberedHomePerCell *
                    (oppCount - myCount);
        }
    }
    // ── Castle approach ──────────────────────────────────────────────────────
    // NOTE ON THE MULTIPLIER: the original evaluateLightState scales this term
    // by `config.castleApproachWeight` (1.2-2.4 across the shipped MCTS/minimax
    // presets), which on its own is similarly weak (60 × ~2 = ~120 per cell of
    // advance — small next to spacing/threat terms in the thousands). That
    // version gets away with it because a SEPARATE strategic layer
    // (applyStrategicOverlay / the GOAP sally→march→assault script) drives the
    // long march across open ground; evaluate() there only has to break ties
    // once units are already close enough for tactics to matter.
    //
    // This beam search has no such overlay — evaluate() alone must be able to
    // pull units across open board on its own, or a flat-eval beam plateaus the
    // instant no immediate tactical gain exists (measured: a full arena game
    // stalling turn after turn once initial contact-range units stopped
    // closing). CASTLE_APPROACH_MULTIPLIER compensates for the missing overlay
    // — tuned so a single cell of advance for an otherwise-idle unit
    // consistently outscores "stand still", without approaching the scale of
    // castle.captureUndefended/lossUndefended (which must still dominate this
    // term the instant a real capture/defense question is on the table).
    {
        const myGoalCenterRow = oppCastleRow + 2;
        const myGoalCenterCol = oppCastleCol + 2;
        const oppGoalCenterRow = myCastleRow + 2;
        const oppGoalCenterCol = myCastleCol + 2;
        let myAdvance = 0;
        let oppAdvance = 0;
        for (const u of myUnits)
            myAdvance += 28 - manhattan(u.row, u.col, myGoalCenterRow, myGoalCenterCol);
        for (const u of oppUnits)
            oppAdvance += 28 - manhattan(u.row, u.col, oppGoalCenterRow, oppGoalCenterCol);
        score += (myAdvance - oppAdvance) * W.castle.approachPerCell * CASTLE_APPROACH_MULTIPLIER;
    }
    // ── GOAL 5: Ranged units — keep distance, penalise melee exposure ────────
    for (const mu of myUnits) {
        if (mu.type === 'archer' || mu.type === 'crossbow') {
            let minEnemyDist = 99;
            for (const ou of oppUnits)
                minEnemyDist = Math.min(minEnemyDist, manhattan(mu.row, mu.col, ou.row, ou.col));
            if (minEnemyDist <= 1)
                score -= W.spacing.rangedAdjacentPenalty;
            else if (minEnemyDist === 2)
                score += W.spacing.rangedOptimalBonus;
            else if (minEnemyDist <= 4)
                score += W.spacing.rangedNearBonus;
        }
        else if (mu.type === 'catapult') {
            let minEnemyDist = 99;
            for (const ou of oppUnits)
                minEnemyDist = Math.min(minEnemyDist, manhattan(mu.row, mu.col, ou.row, ou.col));
            if (minEnemyDist < 3)
                score -= W.spacing.catapultTooCloseWithinPenalty;
            else if (minEnemyDist <= 6)
                score += W.spacing.catapultOptimalBonus;
        }
        else {
            let minDist = 99;
            for (const ou of oppUnits)
                minDist = Math.min(minDist, manhattan(mu.row, mu.col, ou.row, ou.col));
            if (minDist <= 2)
                score += W.spacing.meleeCloseBonus;
            else if (minDist <= 4)
                score += W.spacing.meleeNearBonus;
        }
    }
    // ── Opponent threat / counter potential ───────────────────────────────────
    if (oppUnits.length > 0 && myUnits.length > 0) {
        let threatPenalty = 0;
        let counterValue = 0;
        for (const ou of oppUnits) {
            let bestDmg = 0;
            let bestVictimValue = 0;
            let bestLethal = false;
            for (const mu of myUnits) {
                const dist = manhattan(ou.row, ou.col, mu.row, mu.col);
                if (dist > threatRange(ou.type))
                    continue;
                let dmg = ou.damage;
                if (state.damageBuff[ou.player] > 0)
                    dmg += 2;
                dmg = Math.max(0, dmg - mu.armor);
                if (state.shieldTurns[mu.player] > 0)
                    dmg = Math.max(0, dmg - 2);
                if (dmg > bestDmg) {
                    bestDmg = dmg;
                    bestVictimValue = unitValue(mu);
                    bestLethal = dmg >= mu.hp;
                }
            }
            threatPenalty +=
                bestDmg * W.threat.perDamagePoint + (bestDmg >= 1 ? bestVictimValue * W.threat.victimValueFraction : 0);
            if (bestLethal)
                threatPenalty += bestVictimValue;
        }
        for (const mu of myUnits) {
            let bestDmg = 0;
            let bestKillValue = 0;
            for (const ou of oppUnits) {
                const dist = manhattan(mu.row, mu.col, ou.row, ou.col);
                if (dist > threatRange(mu.type))
                    continue;
                let dmg = mu.damage;
                if (state.damageBuff[mu.player] > 0)
                    dmg += 2;
                dmg = Math.max(0, dmg - ou.armor);
                if (state.shieldTurns[ou.player] > 0)
                    dmg = Math.max(0, dmg - 2);
                if (dmg > bestDmg) {
                    bestDmg = dmg;
                    bestKillValue = dmg >= ou.hp ? unitValue(ou) : 0;
                }
            }
            counterValue += bestDmg * W.threat.perDamagePoint + bestKillValue;
        }
        score += counterValue - threatPenalty;
    }
    // ── Cohesion ────────────────────────────────────────────────────────────
    if (myUnits.length > 1) {
        let isolated = 0;
        for (const mu of myUnits) {
            let nearby = 0;
            for (const al of myUnits) {
                if (al.id === mu.id)
                    continue;
                if (manhattan(mu.row, mu.col, al.row, al.col) <= W.cohesion.radius)
                    nearby += 1;
            }
            if (nearby === 0)
                isolated += 1;
        }
        score -= isolated * W.cohesion.isolatedPenalty;
    }
    // ── Hanging piece penalty ──────────────────────────────────────────────
    for (const mu of myUnits) {
        let totalThreat = 0;
        for (const ou of oppUnits) {
            const dist = manhattan(ou.row, ou.col, mu.row, mu.col);
            const atkRange = threatRange(ou.type);
            const moveRange = ou.type === 'catapult' ? 1 : ou.maxMoves;
            if (dist > moveRange + atkRange)
                continue;
            if (ou.type === 'catapult' && dist < 3)
                continue;
            let dmg = ou.damage;
            if (state.damageBuff[ou.player] > 0)
                dmg += 2;
            dmg = Math.max(0, dmg - mu.armor);
            if (state.shieldTurns[mu.player] > 0)
                dmg = Math.max(0, dmg - 2);
            totalThreat += dmg;
        }
        if (totalThreat >= mu.hp) {
            const val = unitValue(mu);
            score -= Math.min(W.threat.hangingMax, W.threat.hangingBase + val * W.threat.hangingValueFraction);
        }
        else if (totalThreat > mu.hp * W.threat.heavilyThreatenedRatio) {
            score -= W.threat.heavilyThreatenedPenalty;
        }
    }
    // ── Low-HP retreat nudge ───────────────────────────────────────────────
    for (const mu of myUnits) {
        if (mu.hp >= mu.maxHp * W.retreat.lowHpThreshold)
            continue;
        const hpFraction = mu.hp / mu.maxHp;
        let minEnemyDist = 99;
        for (const ou of oppUnits)
            minEnemyDist = Math.min(minEnemyDist, manhattan(mu.row, mu.col, ou.row, ou.col));
        const distBonus = Math.min(W.retreat.lowHpDistBonusMax, minEnemyDist * W.retreat.lowHpDistBonusPerCell * (1 - hpFraction));
        score += distBonus;
    }
    score += evaluateEconomy(state, me);
    return score;
}
/**
 * Economy term — weapon parts held (summed across every unit's own backpack —
 * there's no shared per-player pool any more), recipes completed, ruins
 * control, active buffs. See ai.ts's evaluateEconomy doc comment for why this
 * exists (search previously had zero signal for the ruins/crafting subgame).
 */
function evaluateEconomy(state, me) {
    const myUnitsForInv = state.units.filter((u) => u.player === me && u.hp > 0);
    const inv = { 'Металл': 0, 'Амулет': 0, 'Рубин': 0, 'Дерево': 0, 'Стрелы': 0 };
    for (const u of myUnitsForInv) {
        for (const part of Object.keys(inv))
            inv[part] += u.backpack[part] ?? 0;
    }
    let score = 0;
    for (const part of Object.keys(inv)) {
        const count = inv[part] ?? 0;
        if (count <= 0)
            continue;
        score += count * (W.economy.artifactByName[part] ?? W.economy.artifactBase);
    }
    const affordable = (recipe) => Object.keys(recipe).every((p) => (inv[p] ?? 0) >= (recipe[p] ?? 0));
    for (const w of WEAPONS)
        if (affordable(w.recipe))
            score += W.economy.completeRecipeBonus;
    for (const a of ARMORS)
        if (affordable(a.recipe))
            score += W.economy.completeRecipeBonus;
    const myUnits = state.units.filter((u) => u.player === me && u.hp > 0);
    let ruinsControlled = false;
    for (const u of myUnits) {
        if (inRuins(state, u.row, u.col)) {
            ruinsControlled = true;
            break;
        }
    }
    if (ruinsControlled)
        score += W.economy.ruinsControlBonus;
    const ruinsAreas = [state.ruins, state.ruins2].filter((a) => !!a && a.width > 0 && a.height > 0);
    if (ruinsAreas.length > 0 && myUnits.length > 0) {
        let nearest = Infinity;
        for (const u of myUnits) {
            for (const r of ruinsAreas) {
                const d = manhattan(u.row, u.col, r.top + Math.floor(r.height / 2), r.left + Math.floor(r.width / 2));
                if (d < nearest)
                    nearest = d;
            }
        }
        if (nearest <= W.economy.ruinsApproachRadius) {
            score += (W.economy.ruinsApproachRadius - nearest) * W.economy.ruinsApproachPerCell;
        }
    }
    score += (state.shieldTurns[me] ?? 0) * W.buffs.shieldPerTurn;
    score += (state.damageBuff[me] ?? 0) * W.buffs.damageBuffPerTurn;
    const opp = me === 1 ? 2 : 1;
    score -= (state.shieldTurns[opp] ?? 0) * W.buffs.shieldPerTurn;
    score -= (state.damageBuff[opp] ?? 0) * W.buffs.damageBuffPerTurn;
    return score;
}
//# sourceMappingURL=evaluate.js.map