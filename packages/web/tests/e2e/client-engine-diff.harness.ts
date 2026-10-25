/**
 * Browser-side harness for client-engine-diff.spec.ts. Served by the Vite dev
 * server and imported by the page, so `@kc/game-rules` resolves to the SAME
 * module instance the live game (main.ts) uses — world state set here is the
 * world state the game sees.
 *
 * The idea: the offline client (main.ts) re-implements every rule by mutating
 * Unit objects directly, while the AI search and the online server use the
 * pure reducer (applyAction). Any branch where the two disagree is a bug of
 * the "state left inconsistent" kind. So: snapshot the live game as a
 * GameState, pick a legal action, play it on the CLIENT through its own
 * methods, play it on the ENGINE via applyAction, and diff the results.
 */
import {
  flipFacing,
  turnCost,
  applyAction,
  createInitialState,
  emptyBackpack,
  endTurn,
  generateActionsForPlayer,
  mulberry32,
  rockTargetAllowed,
  catapultMaxRangeFor,
  CATAPULT_MIN_RANGE,
  MAGE_MAX_ENERGY,
  setTerrain,
  setTowers,
  setConstructions,
  setBridgeDurability,
  getTerrain,
  getTowers,
  getConstructions,
  getBridgeDurability,
  getCastleP1Col,
  getCastleP2Col,
  validateSnapshot,
  type GameState,
  type ServerAction,
  type SerializedUnit,
} from '@kc/game-rules';

 
type Game = any;

function liveUnits(g: Game): any[] {
  return g.board.units.filter((u: any) => u.hp > 0 && !u.dying);
}

/** vs-AI matches put player 1 at the BOTTOM of the physical board; the engine
 *  is always canonical (player 1 on top). Flip one row between the two. */
function fr(g: Game, row: number): number {
  return g.player1Bottom ? 19 - row : row;
}

/** Snapshot the live client as an engine GameState in canonical orientation. */
export function toState(g: Game): GameState {
  const units: SerializedUnit[] = liveUnits(g).map((u: any) => ({
    id: u.id,
    player: u.player,
    type: u.type,
    row: fr(g, u.row),
    col: u.col,
    maxHp: u.maxHp,
    hp: u.hp,
    startArmor: u.startArmor,
    armor: u.armor,
    maxArmor: u.maxArmor,
    damage: u.damage,
    maxMoves: u.maxMoves,
    movesLeft: u.movesLeft,
    done: u.done,
    activated: !!u.activated,
    visualRow: null,
    visualCol: null,
    dying: false,
    deathProgress: 0,
    weapon: u.weapon ? { name: u.weapon.name, icon: u.weapon.icon, amount: u.weapon.amount } : null,
    armorGear: u.armorGear ? { name: u.armorGear.name, icon: u.armorGear.icon, amount: u.armorGear.amount } : null,
    backpack: { ...u.backpack },
    wardedBy: u.wardedBy ?? null,
    // Facing is in live rows like everything else: up/down swap on a flipped board.
    facing: g.player1Bottom ? flipFacing(u.facing) : u.facing,
    ...(u.type === 'mage' ? { energy: u.energy, maxEnergy: u.maxEnergy, warding: [...(u.warding ?? [])] } : {}),
  }));
  const s = createInitialState({
    mode: 'pvp',
    seed: 1,
    units,
    castleP1Col: getCastleP1Col(),
    castleP2Col: getCastleP2Col(),
    towers: getTowers().map((t: any) => ({ row: fr(g, t.row), col: t.col })),
    terrain: getTerrain().map((t: any) => ({ ...t, row: fr(g, t.row) })),
    constructions: getConstructions().map((c: any) => ({ row: fr(g, c.row), col: c.col, kind: c.kind, progress: c.progress })),
    bridgeDurability: Object.fromEntries(
      Object.entries(getBridgeDurability()).map(([k, v]) => {
        const [r, c] = k.split(',').map(Number);
        return [`${fr(g, r!)},${c}`, v];
      }),
    ),
    hiddenPickups: (g.hiddenPickups ?? []).map((p: any) => ({ ...p, row: fr(g, p.row) })),
  });
  s.currentPlayer = g.currentPlayer;
  s.activatedCount = g.activatedCount;
  s.winner = g.winner;
  s.droppedBackpacks = (g.droppedBackpacks ?? []).map((d: any) => ({
    row: fr(g, d.row),
    col: d.col,
    parts: { ...d.parts },
    weapon: d.weapon ? { ...d.weapon } : null,
    armorGear: d.armorGear ? { ...d.armorGear } : null,
  }));
  return s;
}

/** Canonical comparable view: only what the rules care about. */
function view(s: GameState): Record<string, unknown> {
  const parts = (b: Record<string, number>) =>
    Object.entries(b)
      .filter(([, n]) => n > 0)
      .sort()
      .map(([k, n]) => `${k}${n}`)
      .join(',');
  const loot = new Map<string, string[]>();
  for (const d of s.droppedBackpacks) {
    const key = `${d.row},${d.col}`;
    const items = loot.get(key) ?? [];
    for (const [k, n] of Object.entries(d.parts)) for (let i = 0; i < n; i += 1) items.push(k);
    if (d.weapon) items.push('W:' + d.weapon.name);
    if (d.armorGear) items.push('A:' + d.armorGear.name);
    if (items.length) loot.set(key, items);
  }
  return {
    currentPlayer: s.currentPlayer,
    winner: s.winner,
    activatedCount: s.activatedCount,
    units: s.units
      .filter((u) => u.hp > 0)
      .map((u) => ({
        id: u.id,
        at: `${u.row},${u.col}`,
        hp: `${u.hp}/${u.maxHp}`,
        armor: `${u.armor}/${u.maxArmor}`,
        damage: u.damage,
        moves: u.movesLeft,
        done: !!u.done,
        activated: !!u.activated,
        energy: u.type === 'mage' ? u.energy : undefined,
        wardedBy: u.wardedBy ?? null,
        facing: u.facing,
        backpack: parts(u.backpack),
        weapon: u.weapon?.name ?? null,
        armorGear: u.armorGear?.name ?? null,
      }))
      .sort((a, b) => a.id - b.id),
    terrain: s.terrain.map((t) => `${t.row},${t.col}:${t.type}`).sort(),
    towers: s.towers.map((t) => `${t.row},${t.col}`).sort(),
    constructions: s.constructions.map((c) => `${c.row},${c.col}:${c.kind}:${c.progress}`).sort(),
    bridgeDurability: Object.entries(s.bridgeDurability).sort(),
    loot: [...loot.entries()].map(([k, v]) => `${k}=${v.sort().join('+')}`).sort(),
    hiddenPickups: s.hiddenPickups.map((p) => `${p.row},${p.col}:${p.kind}:${p.name}`).sort(),
  };
}

function diff(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && path.endsWith('units')) {
    return a.flatMap((x, i) => diff(x, b[i], `${path}[id=${(x as any).id}]`));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => diff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k));
  }
  return [`${path}: client=${JSON.stringify(a)} engine=${JSON.stringify(b)}`];
}

/** Rearrange the freshly started match into a crowded mid-board fight. */
export function setupBrawl(g: Game, seed: number): void {
  const rng = mulberry32(seed * 104729);
  const river = Array.from({ length: 20 }, (_, c) => ({
    row: 10,
    col: c,
    type: (c % 6 === 2 ? 'bridge' : 'river') as 'bridge' | 'river',
  }));
  setTerrain(river);
  setTowers([{ row: 8, col: 4 }, { row: 12, col: 15 }]);
  setConstructions([]);
  const dur: Record<string, number> = {};
  for (const t of river) if (t.type === 'bridge') dur[`${t.row},${t.col}`] = 2;
  setBridgeDurability(dur);
  const taken = new Set(river.map((t) => `${t.row},${t.col}`));
  for (const u of g.board.units) {
    let row = 0;
    let col = 0;
    do {
      row = 6 + Math.floor(rng.next() * 9);
      col = 2 + Math.floor(rng.next() * 16);
    } while (taken.has(`${row},${col}`));
    taken.add(`${row},${col}`);
    u.row = u.visualRow = u.targetRow = row;
    u.col = u.visualCol = u.targetCol = col;
    u.backpack = emptyBackpack();
    u.backpack['Дерево'] = Math.floor(rng.next() * 3);
    u.backpack['Стрелы'] = Math.floor(rng.next() * 3);
    u.backpack['Металл'] = Math.floor(rng.next() * 3);
    u.backpack['Рубин'] = Math.floor(rng.next() * 2);
    u.backpack['Амулет'] = Math.floor(rng.next() * 2);
    if (u.type === 'mage') u.energy = Math.floor(rng.next() * (MAGE_MAX_ENERGY + 1));
    // Random facings, so front/side/back hits and turn costs all get played.
    u.facing = (['up', 'down', 'left', 'right'] as const)[Math.floor(rng.next() * 4)];
  }
  for (const u of g.board.units) {
    const mage = g.board.units.find((m: any) => m.type === 'mage' && m.player === u.player);
    if (mage && mage.id !== u.id && rng.next() < 0.4) u.wardedBy = mage.id;
  }
  g.droppedBackpacks = [];
  // Keep a few buried pickups on open ground so claims happen during moves.
  const pickups: any[] = [];
  for (let i = 0; i < 25; i += 1) {
    const row = 5 + Math.floor(rng.next() * 11);
    const col = Math.floor(rng.next() * 20);
    if (taken.has(`${row},${col}`) || pickups.some((p) => p.row === row && p.col === col)) continue;
    const kinds = [
      { kind: 'part', name: 'Дерево' },
      { kind: 'part', name: 'Рубин' },
      { kind: 'weapon', name: 'Солнечный меч' },
      { kind: 'weapon', name: 'Синий лук' },
      { kind: 'armor', name: 'Кольчуга' },
      { kind: 'armor', name: 'Латы' },
    ];
    pickups.push({ row, col, ...kinds[i % kinds.length] });
  }
  g.hiddenPickups = pickups;
  g.clearHighlights();
  g.selectedUnit = null;
}

/** Engine-legal actions for the side to move, plus probes the generator never emits. */
function candidates(g: Game, s: GameState, rng: { next(): number }): ServerAction[] {
  const out = generateActionsForPlayer(s, s.currentPlayer).filter((a) => a.kind !== 'search-ruins');
  const mine = s.units.filter((u) => u.player === s.currentPlayer && u.hp > 0);
  const canAct = (u: SerializedUnit) => !u.done && u.movesLeft >= 1 && (u.activated || s.activatedCount < 3);
  for (const cat of mine.filter((u) => u.type === 'catapult' && canAct(u))) {
    for (let i = 0; i < 20; i += 1) {
      const row = Math.floor(rng.next() * 20);
      const col = Math.floor(rng.next() * 20);
      const dist = Math.abs(row - cat.row) + Math.abs(col - cat.col);
      const onTower = s.towers.some((t) => t.row === cat.row && t.col === cat.col);
      const affordable = cat.movesLeft >= 1 + turnCost(cat, row, col); // turning to aim behind costs +1
      if (affordable && dist >= CATAPULT_MIN_RANGE && dist <= catapultMaxRangeFor(onTower) && rockTargetAllowed(s, row, col)) {
        out.push({ kind: 'throw-rock', unitId: cat.id, row, col });
        break;
      }
    }
  }
  const aiTurn = g.mode === 'ai' && s.currentPlayer === 2;
  for (const from of aiTurn ? [] : mine.filter(canAct)) {
    const to = mine.find((u) => u.id !== from.id && Math.max(Math.abs(u.row - from.row), Math.abs(u.col - from.col)) <= 1);
    if (!to) continue;
    const a: ServerAction = {
      kind: 'transfer-items',
      fromUnitId: from.id,
      toUnitId: to.id,
      parts: from.backpack['Дерево'] > 0 ? { 'Дерево': from.backpack['Дерево'] } : {},
      weapon: !!from.weapon,
      armor: !!from.armorGear,
    };
    if (applyAction(s, a, mulberry32(1)).ok) out.push(a);
  }
  return out;
}

/** Play `a` on the live client through its own methods. */
function toPhysical(g: Game, a: ServerAction): ServerAction {
  const x: any = { ...a };
  for (const k of ['row', 'targetRow', 'landingRow']) if (typeof x[k] === 'number') x[k] = fr(g, x[k]);
  if (Array.isArray(x.targets)) x.targets = x.targets.map((t: any) => ({ row: fr(g, t.row), col: t.col }));
  return x;
}

function playOnClient(g: Game, canonical: ServerAction): boolean {
  const a = toPhysical(g, canonical);
  const byId = (id: number) => liveUnits(g).find((u: any) => u.id === id);
  const unitId = 'unitId' in a ? a.unitId : a.kind === 'transfer-items' ? a.fromUnitId : -1;
  const unit = byId(unitId);
  if (!unit) return false;
  if (g.selectedUnit?.id !== unit.id) {
    if (!g.selectUnit(unit.row, unit.col)) return false;
  }
  switch (a.kind) {
    case 'move':
      return g.performMove(a.row, a.col);
    case 'attack': {
      const match = g
        .attackActionsFor(unit)
        .find(
          (x: any) =>
            x.mode === a.mode &&
            x.targetRow === a.targetRow &&
            x.targetCol === a.targetCol &&
            x.landingRow === a.landingRow &&
            x.landingCol === a.landingCol,
        );
      if (!match) return false;
      const key =
        match.mode === 'shot' || match.mode === 'pierce'
          ? { r: match.targetRow, c: match.targetCol }
          : { r: match.landingRow, c: match.landingCol };
      return g.performAttack(key.r, key.c, false, match);
    }
    case 'craft':
      return g.craftWeapon(a.index);
    case 'craft-armor':
      return g.craftArmor(a.index);
    case 'castle-heal':
      g.applyCastleHealing();
      return true;
    case 'mage-attack':
      return g.performMageAttack({ row: a.targetRow, col: a.targetCol }, a.damage);
    case 'mage-drain': {
      const t = byId(a.targetUnitId);
      return !!t && g.performMageDrain({ row: t.row, col: t.col });
    }
    case 'mage-heal': {
      const t = byId(a.targetUnitId);
      return !!t && g.performMageHeal({ row: t.row, col: t.col });
    }
    case 'mage-burn-bridge':
      return g.performMageBurnBridge({ row: a.row, col: a.col });
    case 'mage-ward':
      g.mageMode = 'ward';
      g.mageWardPicks = new Set(a.toggleUnitIds);
      return g.confirmMageWard();
    case 'build-tower':
    case 'build-bridge': {
      const kind = a.kind === 'build-tower' ? 'tower' : 'bridge';
      g.buildMode = kind;
      g.buildTargets = g.buildTargetsFor(unit, kind);
      return g.buildStructure(a.row, a.col);
    }
    case 'throw-rock':
      g.rockMode = true;
      g.rockTargets = g.rockTargetsFor(unit);
      return g.throwRock(a.row, a.col);
    case 'transfer-items': {
      g.transferOpenUnitId = a.fromUnitId;
      g.transferTargetId = a.toUnitId;
      g.transferSelection = {
        ...(a.parts && a.parts['Дерево'] ? { 'part:Дерево': true } : {}),
        ...(a.weapon ? { weapon: true } : {}),
        ...(a.armor ? { armor: true } : {}),
      };
      const ok = g.confirmTransfer();
      // A transfer is free; in the UI the player then moves on, which gives
      // an untouched unit's activation back (Esc / picking another unit).
      g.cancelSelection();
      return ok;
    }
    default:
      return false;
  }
}

export interface DiffReport {
  steps: number;
  kinds: Record<string, number>;
  failures: string[];
}

export function runDiff(g: Game, seed: number, maxSteps: number): DiffReport {
  const rng = mulberry32(seed * 2654435761);
  const kinds: Record<string, number> = {};
  const failures: string[] = [];
  let steps = 0;
  let idleTurns = 0;
  while (steps < maxSteps && g.winner === null && failures.length === 0) {
    const before = toState(g);
    const acts = candidates(g, before, rng);
    if (acts.length === 0 || idleTurns > 50) {
      g.forceEndTurn();
      idleTurns += 1;
      const exp = view(endTurn(before));
      const got = view(toState(g));
      const d = diff(got, exp);
      if (d.length) failures.push(`end-turn: ${d.slice(0, 6).join(' | ')}`);
      continue;
    }
    idleTurns = 0;
    // Every so often: a save→load round trip (through the same validator as
    // "Continue") and an action→undo must both leave the game exactly as it was.
    if (steps % 9 === 4 && !g.pendingWeaponEquip) {
      const raw = JSON.parse(JSON.stringify(g.createSaveSnapshot()));
      const validated = validateSnapshot(raw);
      if (!validated) {
        failures.push('save snapshot rejected by validateSnapshot');
        break;
      }
      g.restoreSavedState(validated);
      const d = diff(view(toState(g)), view(before));
      if (d.length) failures.push(`save/load round trip: ${d.slice(0, 8).join(' | ')}`);
    }
    // Online path: the client rebuilds its board from the server's GameState
    // (applyServerState). Feeding it the engine view of the current position
    // must reproduce that position exactly.
    if (steps % 13 === 10 && !g.player1Bottom && !g.pendingWeaponEquip) {
      const st = JSON.parse(JSON.stringify(toState(g)));
      g.applyServerState({ state: st, you: st.currentPlayer, status: 'in_progress', events: [] });
      const d = diff(view(toState(g)), view(st));
      if (d.length) failures.push(`applyServerState round trip: ${d.slice(0, 8).join(' | ')}`);
    }
    const doUndo = steps % 11 === 7;
    if (doUndo) g.recordUndo();
    const fights = acts.filter((a) => a.kind !== 'move');
    const pool = fights.length && rng.next() < 0.7 ? fights : acts;
    const a = pool[Math.floor(rng.next() * pool.length)]!;
    const engine = applyAction(before, a, mulberry32(1));
    if (!engine.ok) {
      failures.push(`engine rejected its own legal action ${JSON.stringify(a)}: ${engine.error.code}`);
      break;
    }
    const ok = playOnClient(g, a);
    if (!ok) {
      const sel = g.selectedUnit;
      failures.push(
        `client refused engine-legal ${JSON.stringify(a)} — selected=${sel?.id}@${sel?.row},${sel?.col} ` +
          `moves=${sel?.movesLeft} done=${sel?.done} act=${g.activatedCount} pending=${!!g.pendingWeaponEquip} ` +
          `moveMap=[${[...g.moveMap.keys()].join(' ')}] terrainAt=${JSON.stringify(getTerrain().filter((t: any) => 'row' in a && t.row === (a as any).row && t.col === (a as any).col))}`,
      );
      break;
    }
    let expected = engine.value;
    // The client auto-ends the turn once nothing can act; mirror that.
    if (g.currentPlayer !== before.currentPlayer && expected.winner === null) expected = endTurn(expected);
    const d = diff(view(toState(g)), view(expected));
    if (d.length) failures.push(`${JSON.stringify(a)}: ${d.slice(0, 8).join(' | ')}`);
    if (doUndo && g.winner === null && g.currentPlayer === before.currentPlayer && g.undoStack.length > 0) {
      g.performUndo();
      const u = diff(view(toState(g)), view(before));
      if (u.length) failures.push(`undo of ${JSON.stringify(a)}: ${u.slice(0, 8).join(' | ')}`);
      // Redo it so the run keeps exploring forward.
      if (!u.length && playOnClient(g, a)) {
        /* replayed */
      }
    }
    kinds[a.kind === 'attack' ? `attack:${a.mode}` : a.kind] = (kinds[a.kind === 'attack' ? `attack:${a.mode}` : a.kind] ?? 0) + 1;
    steps += 1;
  }
  return { steps, kinds, failures };
}

/** Board invariants a live game must always satisfy (same list as the engine fuzz). */
export function invariantViolations(g: Game): string[] {
  const s = toState(g);
  const out: string[] = [];
  const cells = new Set<string>();
  for (const u of s.units) {
    const k = `${u.row},${u.col}`;
    if (cells.has(k)) out.push(`two units on ${k}`);
    cells.add(k);
    if (s.terrain.some((t) => t.row === u.row && t.col === u.col && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'))) {
      out.push(`unit ${u.id} on blocked terrain ${k}`);
    }
    if (s.constructions.some((c) => c.row === u.row && c.col === u.col)) out.push(`unit ${u.id} inside a build site`);
    if (u.hp > u.maxHp || u.armor > u.maxArmor || u.armor < 0) out.push(`unit ${u.id} stats out of range`);
    if (u.movesLeft < 0 || u.movesLeft > u.maxMoves) out.push(`unit ${u.id} moves out of range`);
    if (u.wardedBy) {
      const m = s.units.find((x) => x.id === u.wardedBy);
      if (!m || m.type !== 'mage' || m.player !== u.player) out.push(`unit ${u.id} warded by missing/foreign mage`);
    }
  }
  for (const d of s.droppedBackpacks) {
    if (s.terrain.some((t) => t.row === d.row && t.col === d.col && (t.type === 'river' || t.type === 'rock' || t.type === 'mountain'))) {
      out.push(`loot on blocked terrain ${d.row},${d.col}`);
    }
  }
  if (s.activatedCount > 3) out.push(`activatedCount ${s.activatedCount}`);
  return out;
}
