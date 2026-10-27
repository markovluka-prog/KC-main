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
import type { SerializedUnit } from './save.js';
import type { GameState } from './state.js';
import type { Player } from './types.js';
export interface AIWeights {
    material: {
        presence: number;
        perHp: number;
        perArmor: number;
        perDamage: number;
        perEnergy: number;
        byType: Record<string, number>;
        onTower: number;
        towerStake: number;
        wardCover: number;
        danger: number;
        wipeout: number;
    };
    castle: {
        captureUndefended: number;
        captureDefended: number;
        lossUndefended: number;
        lossDefended: number;
        raidThreatRadius: number;
        raidThreatPerCell: number;
        approachPerCell: number;
        spreadPenaltyPerCell: number;
        huntPerCell: number;
    };
    focus: {
        woundedEnemyMax: number;
    };
    retreat: {
        outnumberedHomePerCell: number;
        outnumberedHomeRadius: number;
        lowHpThreshold: number;
        lowHpDistBonusPerCell: number;
        lowHpDistBonusMax: number;
        lowHpScale: number;
    };
    spacing: {
        rangedAdjacentPenalty: number;
        rangedOptimalBonus: number;
        rangedNearBonus: number;
        catapultTooCloseWithinPenalty: number;
        catapultOptimalBonus: number;
        meleeCloseBonus: number;
        meleeNearBonus: number;
    };
    threat: {
        perDamagePoint: number;
        perDamagePointTaken: number;
        victimValueFraction: number;
        lethalValueFraction: number;
        killValueFraction: number;
        hangingBase: number;
        hangingValueFraction: number;
        hangingMax: number;
        hangingScale: number;
        heavilyThreatenedRatio: number;
        heavilyThreatenedPenalty: number;
    };
    cohesion: {
        isolatedPenalty: number;
        radius: number;
    };
    economy: {
        artifactBase: number;
        artifactByName: Record<string, number>;
        completeRecipeBonus: number;
        ruinsControlBonus: number;
        ruinsApproachPerCell: number;
        ruinsApproachRadius: number;
        unequippedWeaponValue: number;
        unequippedArmorValue: number;
    };
    buffs: {
        shieldPerTurn: number;
        damageBuffPerTurn: number;
    };
    tempo: {
        base: number;
        dmgDealt: number;
        dmgTaken: number;
        kill: number;
        hanging: number;
    };
    rollout: {
        opponentNoiseChance: number;
        opponentNoiseTopK: number;
        terminalDiscount: number;
        staticEvalScale: number;
    };
}
export declare const W: AIWeights;
/**
 * Weights fitted to win probability under uniformly random play (the "Свой
 * шанс" AI's definition of a position's chance), plus the logistic
 * calibration that turns an evaluation gap into that probability. See
 * scripts/fit-chance.mjs and `winChance()`.
 */
export declare const CHANCE_W: AIWeights & {
    calibration: {
        scale: number;
        biasP1: number;
    };
};
export declare const FEATURES: readonly string[];
/**
 * A copy of `base` with some weights multiplied, by FEATURES path — e.g.
 * { 'castle.approachPerCell': 2 }. How a personality tilts the search.
 */
export declare function scaleWeights(mult: Record<string, number>, base?: AIWeights): AIWeights;
export declare function weightVector(w: AIWeights): Float64Array;
/**
 * Standalone piece value — hp/armor/damage/type terms only, no positional
 * context. Always priced with the base weights (it shapes the threat
 * features, see the file comment).
 */
export declare function unitValue(u: Pick<SerializedUnit, 'hp' | 'armor' | 'damage' | 'type'>): number;
/**
 * Fill `out` (length FEATURES.length) with the board quantities of `state`
 * from `me`'s perspective. Each block matches a GOAL comment of the original
 * evaluateLightState.
 */
export declare function evalFeatures(state: GameState, me: Player, out?: Float64Array): Float64Array;
/**
 * Static evaluation of `state` from `me`'s perspective — Σ weight × feature.
 * Higher is better for `me`. `w` defaults to the base ai-weights.json.
 */
export declare function evaluate(state: GameState, me: Player, w?: AIWeights): number;
/**
 * `player`'s win chance in `state` under uniformly random play, from the
 * fitted CHANCE_W: N = 1 / (1 + e^(−(E(me) − E(opp) ± bias) / scale)).
 * Decided games return exactly 1 / 0.
 */
export declare function winChance(state: GameState, player: Player): number;
//# sourceMappingURL=evaluate.d.ts.map