import {
  ROWS,
  START_POSITIONS_P1,
  type BoardLike,
  type Player,
  type StartPosition,
  getCastleP1Col,
  getCastleP2Col,
  getAllRuins,
  getConstructions,
  getTerrain,
  getTowers,
  insideBoard,
} from '@kc/game-rules';
import { Unit } from './Unit.js';

export class Board implements BoardLike {
  readonly player1Bottom: boolean;
  units: Unit[] = [];
  nextId = 1;

  constructor(player1Bottom: boolean, autoInit = true, customPositions?: readonly StartPosition[]) {
    this.player1Bottom = !!player1Bottom;
    if (autoInit) this.initUnits(customPositions);
  }

  initUnits(customPositions?: readonly StartPosition[]): void {
    this.units = [];
    this.nextId = 1;

    const positions = customPositions ?? START_POSITIONS_P1;
    const castleP1 = getCastleP1Col();
    const castleP2 = getCastleP2Col();

    for (const p of positions) {
      const row = this.player1Bottom ? ROWS - 1 - p.row : p.row;
      this.units.push(new Unit(this.nextId++, 1 as Player, p.type, row, p.col + castleP1));
    }

    for (const p of positions) {
      const row = this.player1Bottom ? p.row : ROWS - 1 - p.row;
      this.units.push(new Unit(this.nextId++, 2 as Player, p.type, row, p.col + castleP2));
    }
  }

  unitAt(row: number, col: number): Unit | null {
    for (const u of this.units) {
      if (u.alive() && u.row === row && u.col === col) return u;
    }
    return null;
  }

  isFree(row: number, col: number): boolean {
    if (!insideBoard(row, col)) return false;
    if (this.unitAt(row, col)) return false;
    if (
      getTerrain().some(
        (t) =>
          t.row === row &&
          t.col === col &&
          (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'),
      )
    ) {
      return false;
    }
    // An unfinished tower/bridge site is impassable, like a mountain.
    return !getConstructions().some((c) => c.row === row && c.col === col);
  }

  /**
   * Retire units whose hp hit 0.
   *
   * `onDeath` fires once per unit at the moment it starts dying, before it is
   * filtered out. The attack path handles its own gear drop, but a unit killed
   * by any other route (spell splash, terrain, a future effect) used to vanish
   * silently along with its equipment — passing the hook here makes every death
   * go through the same drop logic.
   */
  removeDead(onDeath?: (unit: Unit) => void): void {
    for (const u of this.units) {
      if (u.hp <= 0 && !u.dying && !u.isDead()) {
        if (onDeath) onDeath(u);
        u.startDeath();
      }
    }
    this.units = this.units.filter((u) => !u.isDead());
  }

  unitsOf(player: Player): Unit[] {
    return this.units.filter((u) => u.player === player && u.alive());
  }

  /**
   * Ruins no longer hold anything: artifacts and gear are scattered invisibly
   * across the whole board at match start (see `scatterHiddenPickups`) and are
   * claimed by walking onto them, not by searching. The rectangles survive only
   * as scenery, so this reports false everywhere — which also stops the AI
   * camping them and disables the "search" action.
   */
  inRuins(_row: number, _col: number): boolean {
    return false;
  }

  /** River water at (row,col). Bridges are crossings, so they are not water. */
  isRiver(row: number, col: number): boolean {
    return getTerrain().some((t) => t.row === row && t.col === col && t.type === 'river');
  }

  isTower(row: number, col: number): boolean {
    return getTowers().some((t) => t.row === row && t.col === col);
  }

  isBridge(row: number, col: number): boolean {
    return getTerrain().some((t) => t.row === row && t.col === col && t.type === 'bridge');
  }
}
