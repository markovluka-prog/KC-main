/**
 * GameState fields owned by the match server only. Save-layer metadata
 * (story progress, map theme, faction selection) lives on the snapshot
 * wrapper instead — the server doesn't need that.
 */
/** Current rules version. Bump when applyAction semantics change. */
export const RULES_VERSION = 1;
/** Max distinct units a player may activate (act with) in a single turn.
 * Mirrors the web client's `maxActivatedPerTurn`. */
export const MAX_ACTIVATIONS_PER_TURN = 3;
//# sourceMappingURL=state.js.map