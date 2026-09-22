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
import type { SerializedUnit } from './save.js';
import type { GameState } from './state.js';
import type { Player } from './types.js';
export interface AIWeights {
    material: {
        presence: number;
        perHp: number;
        perArmor: number;
        perDamage: number;
        byType: Record<string, number>;
        onTower: number;
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
        victimValueFraction: number;
        hangingBase: number;
        hangingValueFraction: number;
        hangingMax: number;
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
    rollout: {
        opponentNoiseChance: number;
        opponentNoiseTopK: number;
        terminalDiscount: number;
        staticEvalScale: number;
    };
}
export declare const W: AIWeights;
/**
 * Standalone piece value — hp/armor/damage/type terms only, no positional
 * context. Used both inline (material term) and by callers (e.g. a future
 * beam search's combo/trade profitability checks) that need "how much is
 * this unit worth" without re-deriving the formula.
 */
export declare function unitValue(u: Pick<SerializedUnit, 'hp' | 'armor' | 'damage' | 'type'>): number;
/**
 * Static evaluation of `state` from `me`'s perspective. Higher is better for
 * `me`. Every GOAL-labelled block below matches a comment block in the
 * original evaluateLightState — kept for diffability against ai.ts.
 */
export declare function evaluate(state: GameState, me: Player): number;
//# sourceMappingURL=evaluate.d.ts.map