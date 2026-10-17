import { WEAPONS, emptyBackpack, type PartName, type Player } from '@kc/game-rules';
// Common spells were removed from the game entirely — only the mage's own
// abilities exist now, out of scope for the (unmodified) LLM player.
const SPELLS: readonly { name: string; recipe: Partial<Record<PartName, number>>; desc: string }[] = [];
import { AIPlayer, type AIGameAPI, type AIAction, type AIActionType } from './ai.js';

interface SerializedAction {
  type: string;
  row?: number;
  col?: number;
  targetRow?: number;
  targetCol?: number;
  landingRow?: number;
  landingCol?: number;
  index?: number;
  desc: string;
}

interface PlanEntry {
  unitId: number;
  action: AIAction;
}

/**
 * LLM-powered AI player. Uses the backend /api/ai-move endpoint when reachable.
 * Falls back to the heuristic AIPlayer automatically so the AI always moves
 * even when the API server or Ollama is unavailable.
 */
export class LLMPlayer {
  readonly player: Player;
  private readonly game: AIGameAPI;
  private difficulty = 'medium';

  // In-browser heuristic fallback — always works, no HTTP required.
  private readonly heuristic: AIPlayer;

  // LLM turn state
  private pending = false;
  private planReady = false;
  private turnRequested = false;
  private turnPlan: PlanEntry[] = [];
  private frameCounter = 0;
  private readonly FRAME_WAIT = 14;

  // When true, skip LLM this turn and use heuristic directly.
  private useFallback = false;

  constructor(game: AIGameAPI, player: Player) {
    this.game = game;
    this.player = player;
    this.heuristic = new AIPlayer(game, player, 'medium');
  }

  setDifficulty(difficulty: string): void {
    this.difficulty = difficulty;
    this.heuristic.setDifficulty(difficulty as Parameters<AIPlayer['setDifficulty']>[0]);
  }

  setConfig(config: { label?: string }): void {
    if (config.label) {
      this.difficulty = config.label;
      this.heuristic.setConfig(config);
    }
  }

  reset(): void {
    this.pending = false;
    this.planReady = false;
    this.turnRequested = false;
    this.turnPlan = [];
    this.frameCounter = 0;
    this.useFallback = false;
    this.heuristic.reset();
  }

  update(): void {
    const game = this.game;
    if (!game.isGameActive()) return;
    if (game.mode !== 'ai') return;
    if (game.currentPlayer !== this.player) return;
    if (game.winner !== null) return;

    // Equip a crafted/looted weapon before anything else.
    if (game.pendingWeaponEquip) {
      const targets = game.weaponEquipTargets(game.pendingWeaponEquip);
      if (targets.length > 0) {
        targets.sort((a, b) => a.damage - b.damage);
        const first = targets[0];
        if (first) game.equipPendingWeapon(first.id);
      } else {
        game.pendingWeaponEquip = null;
        game.renderSidebar();
      }
      return;
    }

    // Fallback mode: API unavailable or returned empty plan — use heuristic AI.
    if (this.useFallback) {
      this.heuristic.update();
      return;
    }

    // Execute LLM plan step by step.
    if (this.planReady) {
      this.frameCounter++;
      if (this.frameCounter < this.FRAME_WAIT) return;
      this.frameCounter = 0;

      if (this.turnPlan.length === 0) {
        this.planReady = false;
        this.turnRequested = false;
        game.forceEndTurn();
        return;
      }

      this.executeNextStep();
      return;
    }

    // Waiting for HTTP response.
    if (this.pending) return;

    // LLM call finished this turn but produced no usable plan → end turn.
    if (this.turnRequested) {
      this.turnRequested = false;
      game.forceEndTurn();
      return;
    }

    // No units to act → end turn immediately.
    const candidates = game.ownUnits(this.player).filter((u) => !u.done && game.canUnitAct(u));
    if (!candidates.length) {
      game.forceEndTurn();
      return;
    }

    // Fire LLM request (once per turn).
    this.turnRequested = true;
    this.pending = true;
    game.lastEvent = 'ИИ думает...';
    this.fetchPlan().catch((err: unknown) => {
      console.warn('[LLMPlayer] fetchPlan failed, switching to heuristic:', err);
      this.pending = false;
      this.turnRequested = false;
      this.activateFallback();
    });
  }

  private activateFallback(): void {
    this.useFallback = true;
    this.heuristic.reset();
  }

  private executeNextStep(): void {
    const game = this.game;
    const entry = this.turnPlan.shift();
    if (!entry) {
      this.planReady = false;
      game.forceEndTurn();
      return;
    }

    const unit = game.board.units.find((u) => u.id === entry.unitId && u.alive());
    if (!unit || unit.done || unit.movesLeft <= 0 || !game.canUnitAct(unit)) {
      this.frameCounter = this.FRAME_WAIT;
      return;
    }

    game.selectUnit(unit.row, unit.col, true);
    if (game.selectedUnit?.id !== unit.id) return;

    const a = entry.action;
    if (a.type === 'attack' && a.row !== undefined && a.col !== undefined) {
      game.performAttack(a.row, a.col, true);
    } else if (a.type === 'move' && a.row !== undefined && a.col !== undefined) {
      game.performMove(a.row, a.col, true);
    } else if (a.type === 'draw') {
      game.drawArtifact(true);
    } else if (a.type === 'spell' && a.index !== undefined) {
      game.castSpell(a.index, true);
    } else if (a.type === 'craft' && a.index !== undefined) {
      game.craftWeapon(a.index, true);
    } else {
      game.skipSelected(true);
    }
  }

  private async fetchPlan(): Promise<void> {
    const game = this.game;
    const myUnits = game.ownUnits(this.player).filter((u) => !u.done && game.canUnitAct(u));
    const enemyPlayer: Player = this.player === 1 ? 2 : 1;
    const enemyUnits = game.ownUnits(enemyPlayer);
    // No shared pool any more — sum every unit's own backpack.
    const inv: Record<PartName, number> = emptyBackpack();
    for (const u of game.ownUnits(this.player)) {
      for (const [art, n] of Object.entries(u.backpack ?? {}) as [PartName, number][]) {
        if (n > 0) inv[art] += n;
      }
    }

    const myUnitsPayload = myUnits.map((u) => {
      const moves = game.moveActionsFor(u);
      const attacks = game.attackActionsFor(u);

      const actions: SerializedAction[] = [
        ...moves.map((m) => ({
          type: 'move',
          row: m.row,
          col: m.col,
          desc: `Move to (row ${m.row}, col ${m.col})`,
        })),
        ...attacks.map((a) => {
          const target = game.board.unitAt(a.targetRow, a.targetCol);
          const dmg = target ? game.computeDamage(u, target) : 0;
          const kills = target ? dmg >= target.hp : false;
          return {
            type: 'attack',
            row: a.row,
            col: a.col,
            targetRow: a.targetRow,
            targetCol: a.targetCol,
            landingRow: a.landingRow,
            landingCol: a.landingCol,
            desc: `Attack ${target?.type ?? 'unit'} #${target?.id ?? '?'} at (row ${a.targetRow}, col ${a.targetCol}), deal ${dmg} dmg${kills ? ' [KILLS!]' : ''}, land at (row ${a.landingRow}, col ${a.landingCol})`,
          };
        }),
      ];

      if (game.board.isTower(u.row, u.col) && u.movesLeft >= 1) {
        SPELLS.forEach((spell, i) => {
          if (!game.canAfford(inv, spell.recipe)) return;
          const cost = Object.entries(spell.recipe)
            .map(([art, n]) => `${art}x${n}`)
            .join(', ');
          actions.push({
            type: 'spell',
            index: i,
            desc: `Cast spell "${spell.name}" from mage tower - ${spell.desc} (costs ${cost})`,
          });
        });
      }

      if (u.movesLeft >= 1 && !game.pendingWeaponEquip) {
        WEAPONS.forEach((w, wi) => {
          // Crafting spends the crafter's own backpack.
          if (!game.canAfford(u.backpack, w.recipe)) return;
          const allies = game.ownUnits(this.player);
          const hasRecipient = allies.some((ally) => {
            if (ally.hp <= 0) return false;
            if (w.archerOnly) return ally.type === 'archer' || ally.type === 'crossbow';
            return !(w.forbidTypes ?? []).includes(ally.type as never);
          });
          if (!hasRecipient) return;
          const cost = Object.entries(w.recipe)
            .map(([art, n]) => `${art}x${n}`)
            .join(', ');
          actions.push({
            type: 'craft',
            index: wi,
            desc: `Craft weapon "${w.name}" - ${w.desc} (costs ${cost})`,
          });
        });
      }

      if (game.board.inRuins(u.row, u.col) && u.movesLeft >= 1) {
        actions.push({
          type: 'draw',
          desc: "Search ruins for artifact loot (consumes this unit's remaining turn)",
        });
      }

      return {
        id: u.id,
        type: u.type,
        row: u.row,
        col: u.col,
        hp: u.hp,
        maxHp: u.maxHp,
        armor: u.armor,
        damage: u.damage,
        movesLeft: u.movesLeft,
        availableActions: actions,
      };
    });

    const inventoryPayload: Record<string, number> = {};
    for (const [art, count] of Object.entries(inv) as [PartName, number][]) {
      if (count > 0) inventoryPayload[art] = count;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let response: Response;
    try {
      response = await fetch('/api/ai-move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          player: this.player,
          difficulty: this.difficulty,
          myUnits: myUnitsPayload,
          enemyUnits: enemyUnits.map((u) => ({
            id: u.id,
            type: u.type,
            row: u.row,
            col: u.col,
            hp: u.hp,
            maxHp: u.maxHp,
            armor: u.armor,
            damage: u.damage,
          })),
          inventory: inventoryPayload,
          damageBuff: game.damageBuff[this.player],
          shieldTurns: game.shieldTurns[this.player],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // API reachable but returned error → switch to heuristic permanently this session.
      this.pending = false;
      this.turnRequested = false;
      this.activateFallback();
      return;
    }

    const data = (await response.json()) as {
      plan: Array<{ unitId: number; action: SerializedAction }>;
    };

    const plan = data.plan.map((p) => ({
      unitId: p.unitId,
      action: {
        type: p.action.type as AIActionType,
        row: p.action.row,
        col: p.action.col,
        targetRow: p.action.targetRow,
        targetCol: p.action.targetCol,
        landingRow: p.action.landingRow,
        landingCol: p.action.landingCol,
        index: p.action.index,
        score: 0,
      } as AIAction,
    }));

    this.pending = false;

    if (plan.length === 0) {
      // LLM returned empty plan — use heuristic for this and all future turns.
      this.turnRequested = false;
      this.activateFallback();
      return;
    }

    this.turnPlan = plan;
    this.planReady = true;
  }
}
