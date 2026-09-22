/**
 * Bridge layer (Phase 1.5 S4) — preserves the legacy module-state API
 * (`getCastleP1Col`, `setTowers`, etc.) but the underlying storage is now
 * a writable subset of `GameState`. The web client (single-player) keeps
 * using these getters/setters; the server (Phase 3+) never imports from
 * this file and instead passes its own `GameState` through `applyAction`.
 *
 * This file does NOT export the full GameState — only the layout slice
 * that's truly process-global (default castle columns, towers, ruins).
 * Per-match state (units, buffs, inventory, turn counter) lives on the
 * `KnightsAndCastlesGame` class on the web side and on the server's own
 * GameState wherever else.
 */
import { COLS, DEFAULT_CASTLE_P1_COL, DEFAULT_CASTLE_P2_COL, DEFAULT_RUINS, DEFAULT_TOWERS, } from './constants.js';
const EMPTY_RUINS = { top: 0, left: 0, width: 0, height: 0 };
function createDefaultLayout() {
    return {
        castleP1Col: DEFAULT_CASTLE_P1_COL,
        castleP2Col: DEFAULT_CASTLE_P2_COL,
        towers: DEFAULT_TOWERS.map((t) => ({ ...t })),
        ruins: { ...DEFAULT_RUINS },
        ruins2: { ...EMPTY_RUINS },
        terrain: [],
        constructions: [],
        bridgeDurability: {},
    };
}
let defaultLayout = createDefaultLayout();
export function getCastleP1Col() {
    return defaultLayout.castleP1Col;
}
export function getCastleP2Col() {
    return defaultLayout.castleP2Col;
}
export function setCastleColumns(p1, p2) {
    defaultLayout.castleP1Col = clampCastleColumn(p1);
    defaultLayout.castleP2Col = clampCastleColumn(p2);
}
export function setCastleP1Col(v) {
    defaultLayout.castleP1Col = clampCastleColumn(v);
}
export function setCastleP2Col(v) {
    defaultLayout.castleP2Col = clampCastleColumn(v);
}
export function getTowers() {
    return defaultLayout.towers;
}
export function setTowers(next) {
    defaultLayout.towers = next.map((t) => ({ ...t }));
}
export function getRuins() {
    return defaultLayout.ruins;
}
export function setRuins(next) {
    defaultLayout.ruins = { ...next };
}
export function getRuins2() {
    return defaultLayout.ruins2;
}
export function setRuins2(next) {
    defaultLayout.ruins2 = next ? { ...next } : { ...EMPTY_RUINS };
}
/** Both ruins rectangles, excluding any zero-size (absent) area. */
export function getAllRuins() {
    return [defaultLayout.ruins, defaultLayout.ruins2].filter((r) => r.width > 0 && r.height > 0);
}
export function getTerrain() {
    return defaultLayout.terrain;
}
export function setTerrain(next) {
    defaultLayout.terrain = next.map((t) => ({ ...t }));
}
export function getConstructions() {
    return defaultLayout.constructions;
}
export function setConstructions(next) {
    defaultLayout.constructions = next.map((c) => ({ ...c }));
}
export function getBridgeDurability() {
    return defaultLayout.bridgeDurability;
}
export function setBridgeDurability(next) {
    defaultLayout.bridgeDurability = { ...next };
}
/**
 * Reset world state back to defaults — used when starting a fresh match
 * with `randomizeMapPositions` or when restoring an old snapshot.
 */
export function resetWorld() {
    defaultLayout = createDefaultLayout();
}
function clampCastleColumn(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n))
        return DEFAULT_CASTLE_P1_COL;
    return Math.max(0, Math.min(COLS - 4, n));
}
//# sourceMappingURL=world.js.map