/**
 * Simple bot for the 3–4 player free-for-all. The 2-player AI (ai.ts) plans
 * against exactly one opponent, so FFA gets its own greedy bot: every step it
 * plays the best available attack (kills first), otherwise walks one unit
 * toward the nearest enemy unit or castle it does not hold.
 */
import type { AttackAction, MoveAction } from '@kc/game-rules';

interface BotUnit {
  id: number;
  player: number;
  type: string;
  row: number;
  col: number;
  hp: number;
  alive(): boolean;
}

export interface FfaBotGame {
  readonly winner: number | null;
  readonly currentPlayer: number;
  readonly board: { units: BotUnit[]; unitAt(row: number, col: number): BotUnit | null | undefined };
  readonly ffaOwners: Array<number | null> | null;
  readonly pendingWeaponEquip: unknown;
  selectedUnit: BotUnit | null;
  isGameActive(): boolean;
  isFfaBotTurn(): boolean;
  /** 'easy' | 'medium' | 'hard' for the seat now to move (null: human). */
  ffaBotLevel(): string | null;
  ownUnits(player: number): BotUnit[];
  canUnitAct(unit: BotUnit): boolean;
  selectUnit(row: number, col: number, byAi?: boolean): void;
  computeDamage(attacker: BotUnit, target: BotUnit): number;
  moveActionsFor(unit: BotUnit): MoveAction[];
  attackActionsFor(unit: BotUnit): AttackAction[];
  performAttack(row: number, col: number, byAi?: boolean, chosen?: AttackAction | null): boolean;
  performMove(row: number, col: number, byAi?: boolean): boolean;
  forceEndTurn(): void;
  /** Centre cell of FFA castle `i` (index into ffaOwners). */
  ffaCastleCenter(i: number): { row: number; col: number };
}

const FRAME_WAIT = 18;
const MAX_STEPS_PER_TURN = 40;
const RANGED = new Set(['archer', 'crossbow', 'mage', 'catapult']);

const dist = (r1: number, c1: number, r2: number, c2: number): number => Math.abs(r1 - r2) + Math.abs(c1 - c2);

export class FfaBot {
  private frame = 0;
  private steps = 0;
  private turnKey = '';

  constructor(private readonly game: FfaBotGame) {}

  update(): void {
    const g = this.game;
    if (!g.isGameActive() || g.winner !== null || !g.isFfaBotTurn()) return;
    if (++this.frame < FRAME_WAIT) return;
    this.frame = 0;
    const key = `${g.currentPlayer}`;
    if (key !== this.turnKey) {
      this.turnKey = key;
      this.steps = 0;
    }
    try {
      if (++this.steps > MAX_STEPS_PER_TURN || !this.step()) {
        this.turnKey = '';
        g.forceEndTurn();
      }
    } catch (err) {
      console.error('FFA bot step failed; ending its turn.', err);
      this.turnKey = '';
      g.forceEndTurn();
    }
  }

  /** One action. Returns false when there is nothing useful left to do. */
  private step(): boolean {
    const g = this.game;
    const me = g.currentPlayer;
    const level = g.ffaBotLevel() ?? 'medium';
    if (g.pendingWeaponEquip) return false;
    // Easy bots dawdle: sometimes they just end the turn early.
    if (level === 'easy' && Math.random() < 0.25) return false;
    const units = g.ownUnits(me).filter((u) => u.alive() && g.canUnitAct(u));
    if (units.length === 0) return false;

    let bestAtk: { unit: BotUnit; action: AttackAction; score: number } | null = null;
    for (const unit of units) {
      for (const action of g.attackActionsFor(unit)) {
        const target = g.board.unitAt(action.targetRow, action.targetCol);
        if (!target || target.player === me || !target.alive()) continue;
        const dmg = g.computeDamage(unit, target);
        let score = (dmg >= target.hp ? 100 : 0) + Math.min(dmg, target.hp) * 10 + (RANGED.has(unit.type) ? 1 : 0);
        if (level === 'easy') score = Math.random() * 100;
        // Hard bots finish wounded targets and prefer fights they are not alone in.
        if (level === 'hard') score += (1 / Math.max(1, target.hp)) * 20;
        if (!bestAtk || score > bestAtk.score) bestAtk = { unit, action, score };
      }
    }
    if (bestAtk) {
      g.selectUnit(bestAtk.unit.row, bestAtk.unit.col, true);
      if (g.selectedUnit?.id === bestAtk.unit.id) {
        const a = bestAtk.action;
        if (g.performAttack(a.targetRow, a.targetCol, true, a)) return true;
      }
    }

    const goals = this.goals(me);
    if (goals.length === 0) return false;
    const enemies = g.board.units.filter((u) => u.alive() && u.player !== me);
    const allies = g.ownUnits(me).filter((u) => u.alive());
    let bestMove: { unit: BotUnit; move: MoveAction; gain: number } | null = null;
    for (const unit of units) {
      const near = (r: number, c: number): number => {
        let d = Infinity;
        for (const t of goals) d = Math.min(d, dist(r, c, t.row, t.col));
        return d;
      };
      const here = near(unit.row, unit.col);
      // Ranged units hold ~3 cells off the nearest enemy instead of closing in.
      const nearestEnemy = (r: number, c: number): number => {
        let d = Infinity;
        for (const e of enemies) d = Math.min(d, dist(r, c, e.row, e.col));
        return d;
      };
      for (const move of g.moveActionsFor(unit)) {
        let gain: number;
        if (RANGED.has(unit.type) && enemies.length > 0) {
          const hereE = Math.abs(nearestEnemy(unit.row, unit.col) - 3);
          const thereE = Math.abs(nearestEnemy(move.row, move.col) - 3);
          gain = hereE - thereE;
        } else {
          gain = here - near(move.row, move.col);
        }
        if (level === 'easy') gain += Math.random() * 2;
        if (level === 'hard' && !RANGED.has(unit.type)) {
          // Stay near allies: no lone runners into the enemy.
          let ally = Infinity;
          for (const a of allies) if (a !== unit) ally = Math.min(ally, dist(move.row, move.col, a.row, a.col));
          if (ally > 3) gain -= 0.5 * (ally - 3);
        }
        if (gain > 0 && (!bestMove || gain > bestMove.gain)) bestMove = { unit, move, gain };
      }
    }
    if (!bestMove) return false;
    g.selectUnit(bestMove.unit.row, bestMove.unit.col, true);
    if (g.selectedUnit?.id !== bestMove.unit.id) return false;
    return g.performMove(bestMove.move.row, bestMove.move.col, true);
  }

  /** Enemy units plus every castle `me` does not hold. */
  private goals(me: number): Array<{ row: number; col: number }> {
    const g = this.game;
    const out: Array<{ row: number; col: number }> = [];
    for (const u of g.board.units) if (u.alive() && u.player !== me) out.push({ row: u.row, col: u.col });
    (g.ffaOwners ?? []).forEach((owner, i) => {
      if (owner !== me) out.push(g.ffaCastleCenter(i));
    });
    return out;
  }
}
