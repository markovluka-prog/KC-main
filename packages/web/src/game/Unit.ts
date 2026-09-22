import {
  MAGE_ENERGY_REGEN_PER_TURN,
  MAGE_MAX_ENERGY,
  UNIT_TYPES,
  emptyBackpack,
  type Backpack,
  type Player,
  type UnitState,
  type UnitTypeKey,
} from '@kc/game-rules';

export interface UnitWeapon {
  name: string;
  icon: string;
  amount: number;
}

/**
 * Stateful unit used by the web client. Implements `UnitState` from game-rules
 * (so the pure rule functions can operate on it) and adds movement/death
 * animation state for the canvas renderer.
 */
export class Unit implements UnitState {
  readonly id: number;
  readonly player: Player;
  readonly type: UnitTypeKey;
  readonly name: string;

  row: number;
  col: number;

  maxHp: number;
  hp: number;
  startArmor: number;
  armor: number;
  maxArmor: number;
  damage: number;
  weapon: UnitWeapon | null = null;
  /** Equipped armour gear (raises armor/maxArmor; dropped on death). */
  armorGear: UnitWeapon | null = null;

  maxMoves: number;
  movesLeft: number;

  /** This unit's own carry of weapon parts — no shared per-player pool. */
  backpack: Backpack;
  /** Mage only: current/max energy for its 4 abilities. Unused by every other type. */
  energy: number;
  maxEnergy: number;
  /** Mage only: unit ids this mage is currently warding. */
  warding: number[] = [];
  /**
   * Any unit: the id of the living mage currently shielding it, or null.
   * A warded unit takes ZERO damage from a hit — the hit is converted to
   * energy drained from the warding mage instead (or kills the mage if it
   * can't afford the drain). See [[kc-mage-ward-mechanic]] and
   * apply.ts's absorbWithWard (server-side twin of this client's
   * Game.absorbWithWard in main.ts).
   */
  wardedBy: number | null = null;

  done = false;
  activated = false;

  // Smooth movement animation
  visualRow: number;
  visualCol: number;
  targetRow: number;
  targetCol: number;
  /** 1.0 == arrived at target cell. */
  moveProgress = 1.0;
  /** Vertical arc offset (0..1..0) applied during movement for a "hop" feel. */
  moveArcY = 0;

  // Death animation
  dying = false;
  deathProgress = 0;
  readonly deathDuration = 120; // ~2 seconds @ 60fps

  // Anim #1: selection bounce — scale pulse on select
  selectBounce = 0; // counts up from 0, drives sin-based scale

  // Anim #5: hit flash — white overlay for N frames on damage
  hitFlash = 0;

  constructor(id: number, player: Player, type: UnitTypeKey, row: number, col: number) {
    const t = UNIT_TYPES[type];
    this.id = id;
    this.player = player;
    this.type = type;
    this.name = t.name;
    this.row = row;
    this.col = col;

    this.maxHp = t.hp;
    this.hp = t.hp;
    this.startArmor = t.armor;
    this.armor = t.armor;
    this.maxArmor = t.armor;
    this.damage = t.damage;
    this.maxMoves = t.moves;
    this.movesLeft = t.moves;
    this.backpack = emptyBackpack();
    this.maxEnergy = type === 'mage' ? MAGE_MAX_ENERGY : 0;
    this.energy = this.maxEnergy;

    this.visualRow = row;
    this.visualCol = col;
    this.targetRow = row;
    this.targetCol = col;
  }

  alive(): boolean {
    return this.hp > 0 && !this.dying;
  }

  resetTurn(): void {
    this.movesLeft = this.maxMoves;
    this.done = false;
    this.activated = false;
    if (this.type === 'mage') {
      this.energy = Math.min(this.maxEnergy, this.energy + MAGE_ENERGY_REGEN_PER_TURN);
    }
  }

  startMoveTo(targetRow: number, targetCol: number): void {
    this.targetRow = targetRow;
    this.targetCol = targetCol;
    this.moveProgress = 0.0;
    this.moveArcY = 0;
  }

  /** Trigger a selection bounce — call when unit is selected. */
  triggerSelectBounce(): void {
    this.selectBounce = 1;
  }

  /** Trigger hit-flash — call when unit receives damage. */
  triggerHitFlash(): void {
    this.hitFlash = 8;
  }

  /** Current render scale driven by selectBounce (1.0 when idle). */
  get bounceScale(): number {
    if (this.selectBounce <= 0) return 1;
    // Half-sine: peaks at 1.2, back to 1.0 after ~14 frames
    const t = this.selectBounce / 14;
    return 1 + 0.22 * Math.sin(t * Math.PI);
  }

  updateMovement(): void {
    if (this.dying) {
      this.deathProgress += 1;
      return;
    }

    // Decay select bounce
    if (this.selectBounce > 0) {
      this.selectBounce = Math.min(this.selectBounce + 1, 15);
      if (this.selectBounce >= 15) this.selectBounce = 0;
    }

    // Decay hit flash
    if (this.hitFlash > 0) this.hitFlash--;

    if (this.moveProgress < 1.0) {
      this.moveProgress += 0.12;
      if (this.moveProgress >= 1.0) {
        this.moveProgress = 1.0;
        this.moveArcY = 0;
        this.visualRow = this.targetRow;
        this.visualCol = this.targetCol;
      } else {
        const t = this.moveProgress;
        // ease-in-out for horizontal
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        this.visualRow = this.row * (1 - eased) + this.targetRow * eased;
        this.visualCol = this.col * (1 - eased) + this.targetCol * eased;
        // Anim #3: arc — lift up by ~0.4 cell at the midpoint
        this.moveArcY = Math.sin(t * Math.PI) * 0.4;
      }
    }
  }

  isMoving(): boolean {
    return this.moveProgress < 1.0;
  }

  startDeath(): void {
    this.dying = true;
    this.deathProgress = 0;
  }

  isDead(): boolean {
    return this.dying && this.deathProgress >= this.deathDuration;
  }
}
