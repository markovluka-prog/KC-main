import type { BridgeDurability, Construction, RuinsArea, TerrainCell, TowerPosition } from './types.js';
export declare function getCastleP1Col(): number;
export declare function getCastleP2Col(): number;
export declare function setCastleColumns(p1: number, p2: number): void;
export declare function setCastleP1Col(v: number): void;
export declare function setCastleP2Col(v: number): void;
export declare function getTowers(): readonly TowerPosition[];
export declare function setTowers(next: readonly TowerPosition[]): void;
export declare function getRuins(): RuinsArea;
export declare function setRuins(next: RuinsArea): void;
export declare function getRuins2(): RuinsArea;
export declare function setRuins2(next: RuinsArea | null | undefined): void;
/** Both ruins rectangles, excluding any zero-size (absent) area. */
export declare function getAllRuins(): RuinsArea[];
export declare function getTerrain(): readonly TerrainCell[];
export declare function setTerrain(next: readonly TerrainCell[]): void;
export declare function getConstructions(): readonly Construction[];
export declare function setConstructions(next: readonly Construction[]): void;
export declare function getBridgeDurability(): BridgeDurability;
export declare function setBridgeDurability(next: BridgeDurability): void;
/**
 * Reset world state back to defaults — used when starting a fresh match
 * with `randomizeMapPositions` or when restoring an old snapshot.
 */
export declare function resetWorld(): void;
//# sourceMappingURL=world.d.ts.map