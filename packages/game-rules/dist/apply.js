/**
 * Phase 1.5 S5 — pure `applyAction(state, action, rng): Result` reducer.
 *
 * The server (Phase 3-4) drives matches by routing each player message
 * through `applyAction`. Every transition is deterministic given (state,
 * action, rng). Outcome is either:
 *   - `{ ok: true, value: nextState, events: [...] }` for valid actions
 *   - `{ ok: false, error: { code, message } }` for illegal ones
 *
 * Combat semantics are ported verbatim from main.ts:1754-1820 so
 * single-player and server-driven matches produce identical results
 * (modulo seeded vs Math.random for ruins loot).
 *
 * The legacy module-level setters in world.ts are NOT touched — this
 * reducer is fully state-passing.
 */
import { ARMORS, BRIDGE_MAX_DURABILITY, BUILD_COST_PER_TURN, BUILD_WORK_TOTAL, DEFAULT_CASTLE_P1_COL, DEFAULT_CASTLE_P2_COL, MAGE_ATTACK_ENERGY_PER_CELL, MAGE_ATTACK_ENERGY_PER_HP, MAGE_BURN_BRIDGE_ENERGY_PER_CELL, MAGE_DRAIN_ENERGY_PER_HP, MAGE_ENERGY_REGEN_PER_TURN, MAGE_HEAL_ENERGY_PER_CELL, MAGE_HEAL_ENERGY_PER_HP, MAGE_MAX_ENERGY, MAGE_WARD_ENERGY_PER_DAMAGE, PARTS, ROWS, RUINS_LOOT_TABLE, UNIT_TYPES, WEAPONS, emptyBackpack, } from './constants.js';
import { weightedChoiceWith } from './rng.js';
import { TOWER_DAMAGE_FACTOR } from './combat.js';
import { insideBoard } from './board.js';
import { ALL8_DIRS, CATAPULT_MIN_RANGE, CAVALRY_RIVER_JUMP_COST, CROSSBOW_PIERCE_COST, CROSSBOW_PIERCE_RANGE, archerRadiusFor, catapultMaxRangeFor, } from './moves.js';
import { MAX_ACTIVATIONS_PER_TURN, RULES_VERSION } from './state.js';
/** True if (row,col) falls inside a (non-zero-size) ruins rectangle. */
function inRuinsArea(area, row, col) {
    if (!area || area.width <= 0 || area.height <= 0)
        return false;
    return row >= area.top && row < area.top + area.height && col >= area.left && col < area.left + area.width;
}
export function createInitialState(opts) {
    return {
        castleP1Col: opts.castleP1Col ?? DEFAULT_CASTLE_P1_COL,
        castleP2Col: opts.castleP2Col ?? DEFAULT_CASTLE_P2_COL,
        towers: opts.towers ? opts.towers.map((t) => ({ ...t })) : [],
        ruins: opts.ruins ? { ...opts.ruins } : { top: 0, left: 0, width: 0, height: 0 },
        ruins2: opts.ruins2 ? { ...opts.ruins2 } : { top: 0, left: 0, width: 0, height: 0 },
        terrain: opts.terrain ? opts.terrain.map((t) => ({ ...t })) : [],
        currentPlayer: opts.player1Starts === false ? 2 : 1,
        turnNumber: 1,
        activatedCount: 0,
        winner: null,
        mode: opts.mode,
        shieldTurns: { 1: 0, 2: 0 },
        damageBuff: { 1: 0, 2: 0 },
        pendingWeaponEquip: null,
        droppedBackpacks: [],
        constructions: opts.constructions ? opts.constructions.map((c) => ({ ...c })) : [],
        bridgeDurability: opts.bridgeDurability ? { ...opts.bridgeDurability } : {},
        hiddenPickups: opts.hiddenPickups ? opts.hiddenPickups.map((p) => ({ ...p })) : [],
        units: opts.units ? opts.units.map(cloneUnit) : [],
        nextUnitId: (opts.units ?? []).reduce((m, u) => Math.max(m, u.id), 0) + 1,
        rngSeed: opts.seed,
        rngCursor: 0,
        rulesVersion: RULES_VERSION,
    };
}
function cloneUnit(u) {
    return {
        ...u,
        weapon: u.weapon ? { ...u.weapon } : null,
        armorGear: u.armorGear ? { ...u.armorGear } : null,
        backpack: { ...u.backpack },
        warding: u.warding ? [...u.warding] : undefined,
    };
}
function cloneState(state) {
    return {
        ...state,
        towers: state.towers.map((t) => ({ ...t })),
        ruins: { ...state.ruins },
        ruins2: state.ruins2 ? { ...state.ruins2 } : undefined,
        terrain: state.terrain.map((t) => ({ ...t })),
        shieldTurns: { ...state.shieldTurns },
        damageBuff: { ...state.damageBuff },
        pendingWeaponEquip: state.pendingWeaponEquip ? { ...state.pendingWeaponEquip } : null,
        droppedBackpacks: (state.droppedBackpacks ?? []).map((d) => ({
            ...d,
            parts: { ...d.parts },
            weapon: d.weapon ? { ...d.weapon } : null,
            armorGear: d.armorGear ? { ...d.armorGear } : null,
        })),
        constructions: (state.constructions ?? []).map((c) => ({ ...c })),
        bridgeDurability: { ...(state.bridgeDurability ?? {}) },
        hiddenPickups: (state.hiddenPickups ?? []).map((p) => ({ ...p })),
        units: state.units.map(cloneUnit),
    };
}
/** Mark a unit as activated for the turn, enforcing the per-turn cap. Returns a
 * ValidationError if a new unit would exceed the cap; null on success. Mutates
 * `next` (already a clone). */
function activateUnit(next, unit) {
    if (unit.activated)
        return null;
    if (next.activatedCount >= MAX_ACTIVATIONS_PER_TURN) {
        return { code: 'activation-limit', message: 'max units activated this turn' };
    }
    unit.activated = true;
    next.activatedCount += 1;
    return null;
}
/** True if a pending/looted/ dropped item may be equipped to `unit`: same
 * player, alive, the matching slot is free, and the unit type is allowed.
 * Mirrors the web client's canEquipWeaponToUnit. */
/** Exported so callers outside apply.ts (the action generator, search code)
 * can check equip eligibility for a pending/dropped item without
 * reimplementing the slot/type rules. */
export function canEquipGear(spec, unit, player) {
    if (unit.player !== player || unit.hp <= 0)
        return false;
    const slot = spec.slot ?? 'weapon';
    if (slot === 'armor') {
        if (unit.armorGear)
            return false;
    }
    else if (unit.weapon) {
        return false;
    }
    const allowed = spec.allowedTypes ?? (spec.archerOnly ? ['archer'] : null);
    if (allowed && !allowed.includes(unit.type))
        return false;
    if (spec.forbidTypes && spec.forbidTypes.includes(unit.type))
        return false;
    return true;
}
/** Lift a static WEAPONS/ARMORS recipe into the serialisable pending-equip shape. */
function weaponToPending(w) {
    return {
        name: w.name,
        amount: w.amount,
        icon: w.icon,
        allowedTypes: w.allowedTypes ? [...w.allowedTypes] : null,
        forbidTypes: w.forbidTypes ? [...w.forbidTypes] : null,
        archerOnly: w.archerOnly,
        slot: w.slot ?? 'weapon',
    };
}
/** Equip a pending/dropped item onto a unit (mutates the unit). Weapon raises
 * damage; armour raises current and max armour so restoration accounts for it. */
function equipGearToUnit(unit, spec) {
    const slot = spec.slot ?? 'weapon';
    if (slot === 'armor') {
        unit.armor += spec.amount;
        unit.maxArmor += spec.amount;
        unit.armorGear = { name: spec.name, icon: spec.icon, amount: spec.amount };
    }
    else {
        unit.damage += spec.amount;
        unit.weapon = { name: spec.name, icon: spec.icon, amount: spec.amount };
    }
}
/** Lift an equipped weapon/armour piece into a transferable GearItem.
 * allowedTypes etc. are recovered from the static catalogue so any future
 * recipient (drop/pickup, hand-to-ally) honours the same restrictions as
 * crafting. */
function gearToItem(slot, gear) {
    const catalogue = slot === 'armor' ? ARMORS : WEAPONS;
    const def = catalogue.find((w) => w.name === gear.name);
    return {
        name: gear.name,
        amount: gear.amount,
        icon: gear.icon,
        allowedTypes: def?.allowedTypes ? [...def.allowedTypes] : null,
        forbidTypes: def?.forbidTypes ? [...def.forbidTypes] : null,
        archerOnly: def?.archerOnly ?? false,
    };
}
/**
 * A killed unit's whole backpack — its weapon parts plus its equipped
 * weapon/armour, if any — dropped as ONE object on its death cell. Pushes
 * onto `next.droppedBackpacks`; no-op if the unit was carrying nothing at all
 * (no parts, no gear) so empty markers never litter the board.
 */
function dropUnitBackpack(next, unit) {
    const hasParts = PARTS.some((p) => unit.backpack[p] > 0);
    if (!hasParts && !unit.weapon && !unit.armorGear)
        return;
    next.droppedBackpacks.push({
        row: unit.row,
        col: unit.col,
        parts: { ...unit.backpack },
        weapon: unit.weapon ? gearToItem('weapon', unit.weapon) : null,
        armorGear: unit.armorGear ? gearToItem('armor', unit.armorGear) : null,
    });
}
function findUnit(state, id) {
    return state.units.find((u) => u.id === id && u.hp > 0) ?? null;
}
/**
 * Ward check run before ANY damage is applied to `target`: if a living mage
 * currently shields it (`target.wardedBy`), the hit is fully absorbed (the
 * caller must skip applying `rawDamage` to `target` entirely) and the
 * warding mage pays energy 1-to-1 with the absorbed damage (5 damage
 * absorbed → 5 energy spent; MAGE_WARD_ENERGY_PER_DAMAGE = 1 makes the
 * floor-division below a no-op). If the mage doesn't have enough energy
 * left to cover that, the hit is STILL fully absorbed (target takes 0) but
 * the mage dies instead — see [[kc-mage-ward-mechanic]] for the full spec
 * this implements.
 *
 * Mutates `next` (the mage's energy, or removes it on death) and pushes
 * events. Returns true when the hit was absorbed (caller must not also
 * apply rawDamage to target).
 */
function absorbWithWard(next, target, rawDamage, events) {
    if (!target.wardedBy)
        return false;
    const mage = next.units.find((u) => u.id === target.wardedBy && u.hp > 0 && u.type === 'mage');
    if (!mage) {
        // Warding mage is gone (died some other way) — the flag is stale, clear
        // it and let the hit through normally.
        target.wardedBy = null;
        return false;
    }
    const cost = Math.floor(rawDamage / MAGE_WARD_ENERGY_PER_DAMAGE);
    const mageEnergy = mage.energy ?? 0;
    if (mageEnergy >= cost) {
        mage.energy = mageEnergy - cost;
        events.push({
            kind: 'mage-warded',
            data: { unitId: mage.id, targetId: target.id, absorbed: rawDamage, cost },
        });
    }
    else {
        // Not enough energy to cover the drain — the shield still holds (target
        // takes 0) but the mage itself dies from the overdraw.
        dropUnitBackpack(next, mage);
        next.units = next.units.filter((u) => u.id !== mage.id);
        events.push({ kind: 'mage-died-overdrawn', data: { unitId: mage.id, targetId: target.id, needed: cost, had: mageEnergy } });
        events.push({ kind: 'unit-killed', data: { unitId: mage.id } });
        // The mage's death may itself end the match (its side loses castle
        // defense, etc.) — check same as any other kill.
        maybeFinishMatch(next, events);
    }
    return true;
}
function err(code, message) {
    return { ok: false, error: { code, message } };
}
function ok(value, events) {
    return { ok: true, value, events };
}
/**
 * Apply a single action to the current state. Pure (returns a fresh state).
 * The RNG cursor on the returned state will reflect any random draws so
 * replay determinism holds.
 */
export function applyAction(state, action, rng) {
    if (state.winner !== null && action.kind !== 'end-turn') {
        return err('game-over', 'Match is finished.');
    }
    // A crafted/looted weapon must be equipped before anything else can happen —
    // mirrors the web client's blockUntilWeaponEquipped gate.
    if (state.pendingWeaponEquip && action.kind !== 'equip-weapon') {
        return err('weapon-pending', 'equip the crafted weapon first');
    }
    switch (action.kind) {
        case 'move':
            return applyMove(state, action);
        case 'attack':
            return applyAttack(state, action);
        case 'end-turn':
            return ok(endTurn(state), [{ kind: 'turn-ended', data: { player: state.currentPlayer } }]);
        case 'resign':
            return applyResign(state, action.player);
        case 'craft':
            return applyCraft(state, action.unitId, action.index);
        case 'craft-armor':
            return applyCraftArmor(state, action.unitId, action.index);
        case 'draw-part':
            return applyDrawPart(state, action.unitId, rng);
        case 'equip-weapon':
            return applyEquipWeapon(state, action.unitId);
        case 'search-ruins':
            return applySearchRuins(state, action.unitId, rng);
        case 'castle-heal':
            return applyCastleHeal(state, action.unitId);
        case 'transfer-items':
            return applyTransferItems(state, action);
        case 'build-tower':
            return applyBuild(state, action.unitId, action.row, action.col, 'tower');
        case 'build-bridge':
            return applyBuild(state, action.unitId, action.row, action.col, 'bridge');
        case 'mage-attack':
            return applyMageAttack(state, action);
        case 'mage-ward':
            return applyMageWard(state, action);
        case 'mage-drain':
            return applyMageDrain(state, action);
        case 'mage-burn-bridge':
            return applyMageBurnBridge(state, action);
        case 'mage-heal':
            return applyMageHeal(state, action);
        default:
            return err('unknown-action', 'Unrecognised action kind.');
    }
}
function applyMove(state, a) {
    const next = cloneState(state);
    const u = findUnit(next, a.unitId);
    if (!u)
        return err('unit-not-found', `unit ${a.unitId} not alive`);
    if (u.player !== next.currentPlayer)
        return err('wrong-turn', "not this player's turn");
    if (u.done)
        return err('unit-cannot-act', 'unit already finished');
    if (u.movesLeft < a.cost)
        return err('no-moves-left', 'insufficient movesLeft');
    // Cell free?
    if (next.units.some((o) => o.id !== u.id && o.hp > 0 && o.row === a.row && o.col === a.col)) {
        return err('illegal-move', 'destination occupied');
    }
    // Terrain: river and mountain block movement (bridge passable)
    if (next.terrain.some((t) => t.row === a.row && t.col === a.col && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'))) {
        return err('illegal-move', 'blocked by terrain');
    }
    // An unfinished tower/bridge site is impassable, like a mountain.
    if ((next.constructions ?? []).some((c) => c.row === a.row && c.col === a.col)) {
        return err('illegal-move', 'blocked by an unfinished construction site');
    }
    // Cavalry river leap: 2 orthogonal cells over exactly one river tile. Any
    // other 2-cell jump stays illegal, so this can't be used as a generic dash.
    const dRow = a.row - u.row;
    const dCol = a.col - u.col;
    const isTwoCellHop = Math.abs(dRow) + Math.abs(dCol) === 2 && (dRow === 0 || dCol === 0);
    if (isTwoCellHop) {
        const midRow = u.row + dRow / 2;
        const midCol = u.col + dCol / 2;
        const midIsRiver = next.terrain.some((t) => t.row === midRow && t.col === midCol && t.type === 'river');
        if (u.type !== 'cavalry' || !midIsRiver || a.cost !== CAVALRY_RIVER_JUMP_COST) {
            return err('illegal-move', 'only cavalry may leap a one-cell river');
        }
    }
    const actErr = activateUnit(next, u);
    if (actErr)
        return { ok: false, error: actErr };
    u.row = a.row;
    u.col = a.col;
    u.movesLeft -= a.cost;
    if (u.movesLeft <= 0)
        u.done = true;
    const moveEvents = [
        { kind: 'unit-moved', data: { unitId: u.id, row: a.row, col: a.col } },
    ];
    claimHiddenPickup(next, u, moveEvents);
    pickUpDroppedItems(next, u, moveEvents);
    maybeFinishMatch(next, moveEvents);
    return ok(next, moveEvents);
}
/**
 * Claim the hidden pickup buried under a unit that just arrived, if any.
 * Weapon parts go straight into the finder's own backpack. Gear is equipped
 * to the finder when it can wear it; otherwise it becomes a pending equip so
 * the player can put it on a compatible ally — and if nobody can wear it, it
 * drops on the cell as ordinary loot (as a single-item backpack so the
 * drop/pickup model stays uniform). Removes the pickup either way: nothing
 * respawns. Mutates `next`.
 */
function claimHiddenPickup(next, unit, events) {
    if (!next.hiddenPickups || next.hiddenPickups.length === 0)
        return;
    const idx = next.hiddenPickups.findIndex((p) => p.row === unit.row && p.col === unit.col);
    if (idx < 0)
        return;
    const found = next.hiddenPickups[idx];
    next.hiddenPickups = next.hiddenPickups.filter((_, i) => i !== idx);
    if (found.kind === 'part') {
        const name = found.name;
        unit.backpack[name] = (unit.backpack[name] ?? 0) + 1;
        events.push({
            kind: 'part-found',
            data: { unitId: unit.id, player: unit.player, name },
        });
        return;
    }
    const catalogue = found.kind === 'armor' ? ARMORS : WEAPONS;
    const gear = catalogue.find((w) => w.name === found.name);
    if (!gear)
        return;
    const slot = found.kind === 'armor' ? 'armor' : 'weapon';
    const item = gearToItem(slot, gear);
    // The finder wears it when it can.
    if (canEquipGear({ ...item, slot }, unit, unit.player)) {
        equipGearToUnit(unit, item);
        events.push({
            kind: 'weapon-equipped',
            data: { unitId: unit.id, name: gear.name, amount: gear.amount, slot, pickedUp: true },
        });
        return;
    }
    // Otherwise offer it to a compatible ally, exactly like ruins loot did.
    const hasRecipient = next.units.some((o) => o.hp > 0 && o.player === unit.player && canEquipGear({ ...item, slot }, o, unit.player));
    if (hasRecipient) {
        next.pendingWeaponEquip = { ...item, slot };
        events.push({
            kind: 'weapon-found',
            data: { unitId: unit.id, player: unit.player, name: gear.name, slot },
        });
        return;
    }
    // Nobody in the army can wear it — leave it lying on the cell.
    next.droppedBackpacks.push({
        row: unit.row,
        col: unit.col,
        parts: emptyBackpack(),
        weapon: slot === 'weapon' ? item : null,
        armorGear: slot === 'armor' ? item : null,
    });
}
/**
 * After a unit lands on `(unit.row, unit.col)`, auto-collect any dropped
 * backpack there: every weapon part goes straight into the finder's own
 * backpack, and any weapon/armour piece it can wear is equipped — all at
 * once, since a dropped backpack is picked up whole (see
 * [[per-unit-backpack]]). Gear the finder can't wear stays behind as a
 * smaller leftover backpack. Deterministic — runs identically client- and
 * server-side. Mutates `next`.
 */
function pickUpDroppedItems(next, unit, events) {
    if (!next.droppedBackpacks || next.droppedBackpacks.length === 0)
        return;
    const remaining = [];
    for (const pack of next.droppedBackpacks) {
        if (pack.row !== unit.row || pack.col !== unit.col) {
            remaining.push(pack);
            continue;
        }
        for (const p of PARTS) {
            const n = pack.parts[p] ?? 0;
            if (n > 0)
                unit.backpack[p] = (unit.backpack[p] ?? 0) + n;
        }
        if (pack.parts && PARTS.some((p) => (pack.parts[p] ?? 0) > 0)) {
            events.push({ kind: 'part-found', data: { unitId: unit.id, player: unit.player, parts: { ...pack.parts } } });
        }
        let leftoverWeapon = pack.weapon;
        if (pack.weapon && canEquipGear({ ...pack.weapon, slot: 'weapon' }, unit, unit.player)) {
            equipGearToUnit(unit, pack.weapon);
            events.push({
                kind: 'weapon-equipped',
                data: { unitId: unit.id, name: pack.weapon.name, amount: pack.weapon.amount, slot: 'weapon', pickedUp: true },
            });
            leftoverWeapon = null;
        }
        let leftoverArmor = pack.armorGear;
        if (pack.armorGear && canEquipGear({ ...pack.armorGear, slot: 'armor' }, unit, unit.player)) {
            equipGearToUnit(unit, { ...pack.armorGear, slot: 'armor' });
            events.push({
                kind: 'weapon-equipped',
                data: { unitId: unit.id, name: pack.armorGear.name, amount: pack.armorGear.amount, slot: 'armor', pickedUp: true },
            });
            leftoverArmor = null;
        }
        if (leftoverWeapon || leftoverArmor) {
            remaining.push({ row: pack.row, col: pack.col, parts: emptyBackpack(), weapon: leftoverWeapon, armorGear: leftoverArmor });
        }
    }
    next.droppedBackpacks = remaining;
}
/**
 * A catapult's ordinary shot, retargeted at an empty bridge cell instead of a
 * living unit: same range (manhattan 3–6, 3–9 from a tower) and cost (1) as
 * a normal catapult attack, but knocks 1 hit point off the bridge instead of
 * dealing damage. At 0 hit points the bridge is destroyed outright — the
 * cell reverts to plain river, impassable again until rebuilt.
 */
function applyCatapultBridgeShot(next, attacker, a) {
    const isBridge = next.terrain.some((t) => t.row === a.targetRow && t.col === a.targetCol && t.type === 'bridge');
    if (!isBridge)
        return err('no-target', 'no living target at given cell');
    const attackerOnTower = isOnTower(next, attacker.row, attacker.col);
    const manhattan = Math.abs(a.targetRow - attacker.row) + Math.abs(a.targetCol - attacker.col);
    if (manhattan < CATAPULT_MIN_RANGE || manhattan > catapultMaxRangeFor(attackerOnTower) || a.cost !== 1) {
        return err('illegal-attack', 'catapult target out of range');
    }
    const actErr = activateUnit(next, attacker);
    if (actErr)
        return { ok: false, error: actErr };
    const key = bridgeKey(a.targetRow, a.targetCol);
    const hpLeft = (next.bridgeDurability[key] ?? BRIDGE_MAX_DURABILITY) - 1;
    const events = [];
    if (hpLeft <= 0) {
        const rest = { ...next.bridgeDurability };
        delete rest[key];
        next.bridgeDurability = rest;
        next.terrain = next.terrain
            .filter((t) => !(t.row === a.targetRow && t.col === a.targetCol && t.type === 'bridge'))
            .concat([{ row: a.targetRow, col: a.targetCol, type: 'river' }]);
        events.push({ kind: 'bridge-burned', data: { row: a.targetRow, col: a.targetCol, by: attacker.id } });
    }
    else {
        next.bridgeDurability = { ...next.bridgeDurability, [key]: hpLeft };
        events.push({ kind: 'bridge-burned', data: { row: a.targetRow, col: a.targetCol, by: attacker.id, hpLeft } });
    }
    attacker.movesLeft -= a.cost;
    if (attacker.movesLeft <= 0)
        attacker.done = true;
    return ok(next, events);
}
/**
 * Crossbow's piercing bolt: fires along one of the 8 straight directions
 * through CROSSBOW_PIERCE_RANGE cells, hitting a unit standing on ANY of
 * them — friend or foe alike, unlike every other attack in the game. Costs a
 * flat 2 moves regardless of how many cells are actually occupied.
 */
function applyPierceAttack(next, attacker, a) {
    if (attacker.type !== 'crossbow')
        return err('illegal-attack', 'only the crossbow can fire a pierce shot');
    if (a.cost !== CROSSBOW_PIERCE_COST)
        return err('illegal-attack', 'pierce shot has a fixed cost');
    const dr = Math.sign(a.targetRow - attacker.row);
    const dc = Math.sign(a.targetCol - attacker.col);
    const isValidDir = ALL8_DIRS.some(([r, c]) => r === dr && c === dc);
    if (!isValidDir)
        return err('illegal-attack', 'pierce shot must fire in a straight line');
    const line = a.targets && a.targets.length > 0
        ? a.targets
        : Array.from({ length: CROSSBOW_PIERCE_RANGE }, (_, i) => ({
            row: attacker.row + dr * (i + 1),
            col: attacker.col + dc * (i + 1),
        }));
    // Validate every cell actually lies on the claimed line, in order, no more
    // than CROSSBOW_PIERCE_RANGE deep — a client can't smuggle in extra/off-line
    // cells via `targets`.
    if (line.length > CROSSBOW_PIERCE_RANGE) {
        return err('illegal-attack', 'pierce shot line too long');
    }
    for (let i = 0; i < line.length; i++) {
        const expectRow = attacker.row + dr * (i + 1);
        const expectCol = attacker.col + dc * (i + 1);
        if (line[i].row !== expectRow || line[i].col !== expectCol) {
            return err('illegal-attack', 'pierce shot targets off the line');
        }
    }
    // No explicit board-bounds check: a cell off the 0..19 board can never
    // match a real unit's row/col, so an off-board line entry simply never
    // hits anything below — it can't be used to smuggle in a phantom target.
    const hits = line
        .map((cell) => next.units.find((u) => u.row === cell.row && u.col === cell.col && u.hp > 0))
        .filter((u) => !!u);
    if (hits.length === 0)
        return err('no-target', 'no living unit on the pierce line');
    const actErr = activateUnit(next, attacker);
    if (actErr)
        return { ok: false, error: actErr };
    const attackerOnTower = isOnTower(next, attacker.row, attacker.col);
    let damage = attacker.damage;
    if (attackerOnTower)
        damage = Math.max(1, Math.round(damage * TOWER_DAMAGE_FACTOR));
    if (next.damageBuff[attacker.player] > 0)
        damage += 2;
    const events = [];
    for (const target of hits) {
        // A warding mage overdrawn by an earlier hit on this same pierce line
        // may have already killed a LATER target in `hits` (if that target was
        // itself the mage). Skip anything already dead.
        if (target.hp <= 0)
            continue;
        let hitDamage = damage;
        if (hitDamage === 0 && attacker.damage > 0)
            hitDamage = 1;
        // Ward check first: a shielded target takes 0 damage from this hit
        // outright (its warding mage pays energy for it, or dies overdrawn).
        if (absorbWithWard(next, target, hitDamage, events)) {
            events.push({
                kind: 'unit-attacked',
                data: { attackerId: attacker.id, targetId: target.id, damage: 0, hpLeft: target.hp, warded: true },
            });
            continue;
        }
        let damageToHp = 0;
        if (hitDamage > target.armor) {
            damageToHp = hitDamage - target.armor;
            target.armor = 0;
        }
        else {
            target.armor -= hitDamage;
        }
        target.hp -= damageToHp;
        events.push({
            kind: 'unit-attacked',
            data: { attackerId: attacker.id, targetId: target.id, damage: hitDamage, hpLeft: target.hp },
        });
        if (target.hp <= 0) {
            dropUnitBackpack(next, target);
            events.push({ kind: 'unit-killed', data: { unitId: target.id } });
        }
    }
    next.units = next.units.filter((u) => u.hp > 0);
    maybeFinishMatch(next, events);
    attacker.movesLeft -= a.cost;
    if (attacker.movesLeft <= 0)
        attacker.done = true;
    return ok(next, events);
}
function applyAttack(state, a) {
    const next = cloneState(state);
    const attacker = findUnit(next, a.unitId);
    if (!attacker)
        return err('unit-not-found', `attacker ${a.unitId} not alive`);
    if (attacker.player !== next.currentPlayer)
        return err('wrong-turn', "not this player's turn");
    if (attacker.done)
        return err('unit-cannot-act', 'unit already finished');
    if (attacker.movesLeft < a.cost)
        return err('no-moves-left', 'insufficient movesLeft');
    if (a.mode === 'pierce')
        return applyPierceAttack(next, attacker, a);
    const target = next.units.find((u) => u.row === a.targetRow && u.col === a.targetCol && u.hp > 0);
    if (!target) {
        // A catapult may fire at an empty bridge cell to shatter it (1 hit point
        // per hit) instead of requiring a living target — same range/cost rule
        // as an ordinary catapult shot.
        if (attacker.type === 'catapult') {
            return applyCatapultBridgeShot(next, attacker, a);
        }
        return err('no-target', 'no living target at given cell');
    }
    if (target.player === attacker.player)
        return err('illegal-attack', 'cannot attack own unit');
    // A ranged unit shooting from a mage tower gets ~1.5× range (high ground)
    // in exchange for weaker shots.
    const attackerOnTower = isOnTower(next, attacker.row, attacker.col);
    // Catapult: target must be at manhattan distance 3–6 (3–9 from a tower), cost = 1.
    if (attacker.type === 'catapult') {
        const manhattan = Math.abs(a.targetRow - attacker.row) + Math.abs(a.targetCol - attacker.col);
        if (manhattan < CATAPULT_MIN_RANGE ||
            manhattan > catapultMaxRangeFor(attackerOnTower) ||
            a.cost !== 1) {
            return err('illegal-attack', 'catapult target out of range');
        }
    }
    // Archer/crossbow: target must be within square zone. Cost equals the
    // Chebyshev distance to the target (adjacent = 1, range-2 = 2), matching
    // generateAttackActions.
    // BUGFIX: previously required a.cost === 1, which rejected every legal
    // range-2 ranged shot produced by the move generator (cost up to
    // ARCHER_SQUARE_RADIUS). Validate cost against the actual distance instead.
    if (attacker.type === 'archer' || attacker.type === 'crossbow') {
        const chebyshev = Math.max(Math.abs(a.targetRow - attacker.row), Math.abs(a.targetCol - attacker.col));
        if (chebyshev < 1 ||
            chebyshev > archerRadiusFor(attackerOnTower) ||
            a.cost !== chebyshev) {
            return err('illegal-attack', 'archer/crossbow shot out of square range');
        }
    }
    const actErr = activateUnit(next, attacker);
    if (actErr)
        return { ok: false, error: actErr };
    // Jump / l-attack: check landing cell for terrain blocks.
    if (a.mode === 'jump' || a.mode === 'l-attack') {
        if (next.terrain.some((t) => t.row === a.landingRow &&
            t.col === a.landingCol &&
            (t.type === 'river' || t.type === 'mountain' || t.type === 'rock')) ||
            (next.constructions ?? []).some((c) => c.row === a.landingRow && c.col === a.landingCol)) {
            return err('illegal-attack', 'landing cell blocked by terrain');
        }
        attacker.row = a.landingRow;
        attacker.col = a.landingCol;
    }
    // Damage formula — verbatim port of main.ts:1759-1786.
    let damage = attacker.damage;
    // Tower trade-off: extended range costs damage for ranged attackers.
    if (attackerOnTower &&
        (attacker.type === 'archer' || attacker.type === 'crossbow' || attacker.type === 'catapult')) {
        damage = Math.max(1, Math.round(damage * TOWER_DAMAGE_FACTOR));
    }
    if (next.damageBuff[attacker.player] > 0)
        damage += 2;
    // Archer/crossbow min-1 rule: ranged units always deal at least 1 damage.
    if ((attacker.type === 'archer' || attacker.type === 'crossbow') &&
        damage === 0 &&
        attacker.damage > 0) {
        damage = 1;
    }
    attacker.movesLeft -= a.cost;
    if (attacker.movesLeft <= 0)
        attacker.done = true;
    const events = [];
    // Ward check first: a shielded target takes 0 damage from this hit
    // outright (its warding mage pays energy for it, or dies overdrawn).
    if (absorbWithWard(next, target, damage, events)) {
        events.unshift({
            kind: 'unit-attacked',
            data: { attackerId: attacker.id, targetId: target.id, damage: 0, hpLeft: target.hp, warded: true },
        });
        if (a.mode === 'jump' || a.mode === 'l-attack')
            pickUpDroppedItems(next, attacker, events);
        return ok(next, events);
    }
    let damageToHp = 0;
    if (damage > target.armor) {
        damageToHp = damage - target.armor;
        target.armor = 0;
    }
    else {
        target.armor -= damage;
    }
    target.hp -= damageToHp;
    events.push({
        kind: 'unit-attacked',
        data: { attackerId: attacker.id, targetId: target.id, damage, hpLeft: target.hp },
    });
    if (target.hp <= 0) {
        // Drop the slain unit's whole backpack onto its cell so it can be picked up later.
        dropUnitBackpack(next, target);
        next.units = next.units.filter((u) => u.id !== target.id);
        events.push({ kind: 'unit-killed', data: { unitId: target.id } });
        maybeFinishMatch(next, events);
    }
    // A jump/l-attack lands the attacker on a new cell — let it grab gear there.
    if (a.mode === 'jump' || a.mode === 'l-attack')
        pickUpDroppedItems(next, attacker, events);
    return ok(next, events);
}
/**
 * True when (row,col) falls inside a 4×4 castle footprint anchored at
 * (castleRow, castleCol). Exported so callers outside apply.ts (the AI's
 * evaluate()/beam search) can reuse the exact same zone rule instead of
 * reimplementing it — see castleRowFor/castleColFor below for the canonical
 * per-player anchor.
 */
export function inCastleZone(u, castleRow, castleCol) {
    return u.row >= castleRow && u.row < castleRow + 4 && u.col >= castleCol && u.col < castleCol + 4;
}
/** Row of `player`'s own castle footprint (top-left anchor row). */
export function castleRowFor(player) {
    return player === 1 ? 0 : ROWS - 4;
}
/** Column of `player`'s own castle footprint (top-left anchor col), from state. */
export function castleColFor(state, player) {
    return player === 1 ? state.castleP1Col : state.castleP2Col;
}
/** True if `player` has a living unit standing inside its own castle zone. */
export function defendsOwnCastle(state, player) {
    const row = castleRowFor(player);
    const col = castleColFor(state, player);
    return state.units.some((u) => u.player === player && u.hp > 0 && inCastleZone(u, row, col));
}
/** True if `player` has a living unit standing inside the OTHER player's castle zone. */
export function occupiesEnemyCastle(state, player) {
    const enemy = player === 1 ? 2 : 1;
    const row = castleRowFor(enemy);
    const col = castleColFor(state, enemy);
    return state.units.some((u) => u.player === player && u.hp > 0 && inCastleZone(u, row, col));
}
function maybeFinishMatch(state, events) {
    if (state.winner !== null)
        return;
    const p2CastleRow = ROWS - 4; // 16
    const p1CastleRow = 0;
    // P1 wins: has a unit inside P2's castle AND no P2 units defend it
    const p1InP2Castle = state.units.some((u) => u.player === 1 && u.hp > 0 && inCastleZone(u, p2CastleRow, state.castleP2Col));
    const p2InOwnCastle = state.units.some((u) => u.player === 2 && u.hp > 0 && inCastleZone(u, p2CastleRow, state.castleP2Col));
    if (p1InP2Castle && !p2InOwnCastle) {
        state.winner = 1;
        events.push({ kind: 'match-finished', data: { winner: 1 } });
        return;
    }
    // P2 wins: has a unit inside P1's castle AND no P1 units defend it
    const p2InP1Castle = state.units.some((u) => u.player === 2 && u.hp > 0 && inCastleZone(u, p1CastleRow, state.castleP1Col));
    const p1InOwnCastle = state.units.some((u) => u.player === 1 && u.hp > 0 && inCastleZone(u, p1CastleRow, state.castleP1Col));
    if (p2InP1Castle && !p1InOwnCastle) {
        state.winner = 2;
        events.push({ kind: 'match-finished', data: { winner: 2 } });
    }
}
/**
 * End the current turn. Resets done/movesLeft for the next player, decrements
 * shield/buff timers for the ending player, advances turnNumber.
 * Symmetric with `AIPlayer.applyEndOfTurn` in packages/web/src/game/ai.ts.
 */
export function endTurn(state) {
    const next = cloneState(state);
    const ending = next.currentPlayer;
    const upcoming = ending === 1 ? 2 : 1;
    next.units.forEach((u) => {
        // Activation resets for everyone; moves/done refill for the upcoming player.
        u.activated = false;
        if (u.player === upcoming && u.hp > 0) {
            u.done = false;
            const t = UNIT_TYPES[u.type];
            u.movesLeft = t ? t.moves : u.movesLeft;
            // Mage energy regenerates at the start of its own side's turn.
            if (u.type === 'mage') {
                const max = u.maxEnergy ?? MAGE_MAX_ENERGY;
                u.energy = Math.min(max, (u.energy ?? max) + MAGE_ENERGY_REGEN_PER_TURN);
            }
        }
    });
    next.activatedCount = 0;
    if (next.shieldTurns[ending] > 0)
        next.shieldTurns[ending] -= 1;
    if (next.damageBuff[ending] > 0)
        next.damageBuff[ending] -= 1;
    next.currentPlayer = upcoming;
    next.turnNumber += 1;
    return next;
}
function applyResign(state, player) {
    if (player !== 1 && player !== 2)
        return err('unknown-action', 'invalid player');
    const next = cloneState(state);
    next.winner = player === 1 ? 2 : 1;
    return ok(next, [{ kind: 'match-finished', data: { winner: next.winner, reason: 'resign' } }]);
}
function isOnTower(state, row, col) {
    return state.towers.some((t) => t.row === row && t.col === col);
}
/**
 * Craft a weapon (Солнечный меч / Синий лук) from a unit's own backpack of
 * weapon parts. Mirrors
 * the web client's craftWeapon(): requires a unit with a move to spend, deducts
 * the recipe, and — if an eligible ally exists — sets `pendingWeaponEquip` so the
 * next action must equip it. If no eligible recipient exists the weapon is
 * dropped (the move is still spent), exactly as in the offline game.
 */
/** True if `backpack` holds at least `recipe`'s counts of every part. */
function canAffordFromBackpack(backpack, recipe) {
    for (const [part, n] of Object.entries(recipe)) {
        if ((backpack[part] ?? 0) < (n ?? 0))
            return false;
    }
    return true;
}
function applyCraft(state, unitId, index) {
    const weapon = WEAPONS[index];
    if (!weapon)
        return err('unknown-action', `no weapon at index ${index}`);
    const u = findUnit(state, unitId);
    if (!u)
        return err('unit-not-found', `unit ${unitId} not alive`);
    if (u.player !== state.currentPlayer)
        return err('wrong-turn', "not this player's turn");
    if (u.done)
        return err('unit-cannot-act', 'unit already finished');
    if (u.movesLeft < 1)
        return err('no-moves-left', 'crafting costs one move');
    if (!canAffordFromBackpack(u.backpack, weapon.recipe)) {
        return err('craft-unaffordable', 'missing parts');
    }
    const next = cloneState(state);
    const nextU = next.units.find((x) => x.id === unitId);
    const actErr = activateUnit(next, nextU);
    if (actErr)
        return { ok: false, error: actErr };
    for (const [part, n] of Object.entries(weapon.recipe)) {
        nextU.backpack[part] -= n ?? 0;
    }
    nextU.movesLeft = Math.max(0, nextU.movesLeft - 1);
    if (nextU.movesLeft <= 0)
        nextU.done = true;
    // The crafter gets the weapon by default when it's able to wear it;
    // otherwise it's offered to any eligible ally, same as looted gear.
    const pending = weaponToPending(weapon);
    if (canEquipGear(pending, nextU, next.currentPlayer)) {
        equipGearToUnit(nextU, pending);
        return ok(next, [{ kind: 'weapon-crafted', data: { unitId, index, name: weapon.name, dropped: false } }]);
    }
    const hasRecipient = next.units.some((t) => canEquipGear(pending, t, next.currentPlayer));
    if (hasRecipient)
        next.pendingWeaponEquip = pending;
    return ok(next, [
        {
            kind: 'weapon-crafted',
            data: { unitId, index, name: weapon.name, dropped: !hasRecipient },
        },
    ]);
}
/**
 * Craft a piece of armour from the crafter's own backpack. Mirrors applyCraft
 * but indexes the ARMORS catalogue and produces a pending equip in the armour slot.
 */
function applyCraftArmor(state, unitId, index) {
    const armor = ARMORS[index];
    if (!armor)
        return err('unknown-action', `no armor at index ${index}`);
    const u = findUnit(state, unitId);
    if (!u)
        return err('unit-not-found', `unit ${unitId} not alive`);
    if (u.player !== state.currentPlayer)
        return err('wrong-turn', "not this player's turn");
    if (u.done)
        return err('unit-cannot-act', 'unit already finished');
    if (u.movesLeft < 1)
        return err('no-moves-left', 'crafting costs one move');
    if (!canAffordFromBackpack(u.backpack, armor.recipe)) {
        return err('craft-unaffordable', 'missing parts');
    }
    const next = cloneState(state);
    const nextU = next.units.find((x) => x.id === unitId);
    const actErr = activateUnit(next, nextU);
    if (actErr)
        return { ok: false, error: actErr };
    for (const [part, n] of Object.entries(armor.recipe)) {
        nextU.backpack[part] -= n ?? 0;
    }
    nextU.movesLeft = Math.max(0, nextU.movesLeft - 1);
    if (nextU.movesLeft <= 0)
        nextU.done = true;
    const pending = weaponToPending(armor);
    if (canEquipGear(pending, nextU, next.currentPlayer)) {
        equipGearToUnit(nextU, pending);
        return ok(next, [
            { kind: 'weapon-crafted', data: { unitId, index, name: armor.name, slot: 'armor', dropped: false } },
        ]);
    }
    const hasRecipient = next.units.some((t) => canEquipGear(pending, t, next.currentPlayer));
    if (hasRecipient)
        next.pendingWeaponEquip = pending;
    return ok(next, [
        {
            kind: 'weapon-crafted',
            data: { unitId, index, name: armor.name, slot: 'armor', dropped: !hasRecipient },
        },
    ]);
}
function applyDrawPart(state, unitId, rng) {
    const u = findUnit(state, unitId);
    if (!u)
        return err('unit-not-found', `unit ${unitId} not alive`);
    if (u.player !== state.currentPlayer)
        return err('wrong-turn', "not this player's turn");
    return applySearchRuins(state, unitId, rng);
}
function applyEquipWeapon(state, unitId) {
    const pending = state.pendingWeaponEquip;
    if (!pending)
        return err('no-pending-weapon', 'no weapon awaiting equip');
    const u = findUnit(state, unitId);
    if (!u)
        return err('unit-not-found', `unit ${unitId} not alive`);
    if (!canEquipGear(pending, u, state.currentPlayer)) {
        return err('cannot-equip', 'unit cannot equip this item');
    }
    const next = cloneState(state);
    const target = next.units.find((x) => x.id === unitId);
    equipGearToUnit(target, pending);
    next.pendingWeaponEquip = null;
    return ok(next, [
        {
            kind: 'weapon-equipped',
            data: { unitId, name: pending.name, amount: pending.amount, slot: pending.slot ?? 'weapon' },
        },
    ]);
}
/**
 * Hand weapon parts and/or a carried weapon/armour piece from one of your own
 * units to another standing adjacent. Free — costs no moves, doesn't require
 * either unit to be "actable" (not done, not already activated), and doesn't
 * count toward the per-turn activation cap. Both units must belong to the
 * player whose turn it is.
 */
function applyTransferItems(state, a) {
    const from = findUnit(state, a.fromUnitId);
    const to = findUnit(state, a.toUnitId);
    if (!from || !to)
        return err('unit-not-found', 'both units must be alive');
    if (from.id === to.id)
        return err('unknown-action', 'cannot transfer to yourself');
    if (from.player !== state.currentPlayer || to.player !== state.currentPlayer) {
        return err('wrong-turn', 'both units must belong to the current player');
    }
    const chebyshev = Math.max(Math.abs(from.row - to.row), Math.abs(from.col - to.col));
    if (chebyshev > 1)
        return err('not-adjacent', 'units must stand adjacent to transfer items');
    const parts = a.parts ?? {};
    const wantsWeapon = !!a.weapon;
    const wantsArmor = !!a.armor;
    let anyRequested = wantsWeapon || wantsArmor;
    for (const n of Object.values(parts)) {
        if ((n ?? 0) > 0)
            anyRequested = true;
    }
    if (!anyRequested)
        return err('nothing-to-transfer', 'nothing selected to hand over');
    // Validate parts: sender must actually hold at least as many of each as requested.
    for (const [part, n] of Object.entries(parts)) {
        if ((n ?? 0) < 0)
            return err('nothing-to-transfer', 'negative part count');
        if ((from.backpack[part] ?? 0) < (n ?? 0)) {
            return err('nothing-to-transfer', `sender doesn't have enough ${part}`);
        }
    }
    if (wantsWeapon && !from.weapon)
        return err('nothing-to-transfer', 'sender has no weapon to hand over');
    if (wantsArmor && !from.armorGear)
        return err('nothing-to-transfer', 'sender has no armour to hand over');
    // Receiver must have the slot free for anything it's about to receive.
    if (wantsWeapon && to.weapon)
        return err('cannot-equip', 'receiver already carries a weapon');
    if (wantsArmor && to.armorGear)
        return err('cannot-equip', 'receiver already carries armour');
    // A weapon/armour piece the receiving unit type can't legally wear can't be
    // handed over either — it would just sit unusable in a slot that blocks any
    // future pickup.
    if (wantsWeapon && from.weapon && !canEquipGear(gearToItem('weapon', from.weapon), to, state.currentPlayer)) {
        return err('cannot-equip', "receiver's unit type cannot equip this weapon");
    }
    if (wantsArmor &&
        from.armorGear &&
        !canEquipGear({ ...gearToItem('armor', from.armorGear), slot: 'armor' }, to, state.currentPlayer)) {
        return err('cannot-equip', "receiver's unit type cannot equip this armour");
    }
    const next = cloneState(state);
    const nextFrom = next.units.find((u) => u.id === from.id);
    const nextTo = next.units.find((u) => u.id === to.id);
    for (const [part, n] of Object.entries(parts)) {
        if (!n)
            continue;
        nextFrom.backpack[part] -= n;
        nextTo.backpack[part] = (nextTo.backpack[part] ?? 0) + n;
    }
    if (wantsWeapon && nextFrom.weapon) {
        nextTo.damage += nextFrom.weapon.amount;
        nextTo.weapon = nextFrom.weapon;
        nextFrom.damage -= nextFrom.weapon.amount;
        nextFrom.weapon = null;
    }
    if (wantsArmor && nextFrom.armorGear) {
        nextTo.armor += nextFrom.armorGear.amount;
        nextTo.maxArmor += nextFrom.armorGear.amount;
        nextTo.armorGear = nextFrom.armorGear;
        nextFrom.armor = Math.max(0, nextFrom.armor - nextFrom.armorGear.amount);
        nextFrom.maxArmor = Math.max(0, nextFrom.maxArmor - nextFrom.armorGear.amount);
        nextFrom.armorGear = null;
    }
    return ok(next, [
        {
            kind: 'items-transferred',
            data: { fromUnitId: from.id, toUnitId: to.id, parts, weapon: wantsWeapon, armor: wantsArmor },
        },
    ]);
}
function applySearchRuins(state, unitId, rng) {
    const u = findUnit(state, unitId);
    if (!u)
        return err('unit-not-found', `unit ${unitId} not alive`);
    if (u.player !== state.currentPlayer)
        return err('wrong-turn', "not this player's turn");
    if (u.done)
        return err('unit-cannot-act', 'unit already finished');
    if (!inRuinsArea(state.ruins, u.row, u.col) && !inRuinsArea(state.ruins2, u.row, u.col)) {
        return err('unit-not-on-ruins', 'unit must be standing on ruins');
    }
    const next = cloneState(state);
    const acted = next.units.find((x) => x.id === unitId);
    const actErr = activateUnit(next, acted);
    if (actErr)
        return { ok: false, error: actErr };
    const loot = pickLoot(rng);
    if (loot.type === 'part') {
        acted.backpack[loot.name] += 1;
    }
    else if (loot.type === 'weapon' || loot.type === 'armor') {
        // Looted gear must be equipped to an eligible ally, just like a crafted
        // one; if nobody can take it the gear is dropped.
        const catalogue = loot.type === 'armor' ? ARMORS : WEAPONS;
        const gear = catalogue.find((w) => w.name === loot.name);
        if (gear) {
            const pending = weaponToPending(gear);
            if (next.units.some((t) => canEquipGear(pending, t, next.currentPlayer))) {
                next.pendingWeaponEquip = pending;
            }
        }
    }
    next.rngCursor += 1;
    // Mark unit done — searching consumes the turn.
    acted.movesLeft = 0;
    acted.done = true;
    return ok(next, [{ kind: 'ruins-searched', data: { unitId, loot } }]);
}
/**
 * Restore a unit to full hp/armour while it stands in its OWN castle. Mirrors
 * the web client's applyCastleHealing: costs the unit its whole turn.
 */
function applyCastleHeal(state, unitId) {
    const u = findUnit(state, unitId);
    if (!u)
        return err('unit-not-found', `unit ${unitId} not alive`);
    if (u.player !== state.currentPlayer)
        return err('wrong-turn', "not this player's turn");
    if (u.done)
        return err('unit-cannot-act', 'unit already finished');
    if (u.movesLeft < 1)
        return err('no-moves-left', 'healing costs a move');
    const ownCastleRow = u.player === 1 ? 0 : ROWS - 4;
    const ownCastleCol = u.player === 1 ? state.castleP1Col : state.castleP2Col;
    if (!inCastleZone(u, ownCastleRow, ownCastleCol)) {
        return err('unit-not-in-castle', 'unit must stand in its own castle to heal');
    }
    const next = cloneState(state);
    const acted = next.units.find((x) => x.id === unitId);
    const actErr = activateUnit(next, acted);
    if (actErr)
        return { ok: false, error: actErr };
    acted.hp = acted.maxHp;
    acted.armor = acted.maxArmor;
    acted.movesLeft = 0;
    acted.done = true;
    return ok(next, [{ kind: 'castle-healed', data: { player: acted.player, unitId } }]);
}
/**
 * Shared entry checks for all 4 mage-* actions: the acting unit must be a
 * living mage belonging to the current player, not yet done, with a move
 * left to spend (each ability costs exactly 1 move on top of its energy —
 * see MAGE_* constants in constants.ts). Returns the mage on success.
 */
function requireActingMage(state, unitId) {
    const u = findUnit(state, unitId);
    if (!u)
        return { code: 'unit-not-found', message: `unit ${unitId} not alive` };
    if (u.player !== state.currentPlayer)
        return { code: 'wrong-turn', message: "not this player's turn" };
    if (u.type !== 'mage')
        return { code: 'not-a-mage', message: 'only a mage can use this ability' };
    if (u.done)
        return { code: 'unit-cannot-act', message: 'unit already finished' };
    if (u.movesLeft < 1)
        return { code: 'no-moves-left', message: 'ability costs a move' };
    return u;
}
function isValidationError(x) {
    return 'code' in x;
}
/**
 * Mage attack: the player picks how much damage to deal (>=1) to one enemy
 * at any Chebyshev distance, no line-of-sight check. Costs 1 move plus
 * `chosenDamage * 1 + distance * MAGE_ATTACK_ENERGY_PER_CELL` energy — same
 * "1 energy per point, plus distance" shape as mage-heal. Armour absorbs
 * first, same damage split as a normal attack. MAGE_ATTACK_DAMAGE is no
 * longer the dealt amount (kept only as a UI default/suggestion).
 */
function applyMageAttack(state, a) {
    const mage = requireActingMage(state, a.unitId);
    if (isValidationError(mage))
        return { ok: false, error: mage };
    const target = state.units.find((u) => u.row === a.targetRow && u.col === a.targetCol && u.hp > 0);
    if (!target)
        return err('no-target', 'no living target at given cell');
    if (target.player === mage.player)
        return err('illegal-attack', 'cannot attack own unit');
    const chosenDamage = Math.floor(a.damage);
    if (!Number.isFinite(chosenDamage) || chosenDamage < 1) {
        return err('illegal-attack', 'damage must be a positive integer');
    }
    const chebyshev = Math.max(Math.abs(a.targetRow - mage.row), Math.abs(a.targetCol - mage.col));
    const cost = chosenDamage * MAGE_ATTACK_ENERGY_PER_HP + chebyshev * MAGE_ATTACK_ENERGY_PER_CELL;
    if ((mage.energy ?? 0) < cost)
        return err('no-energy', 'not enough energy for this attack');
    const next = cloneState(state);
    const nextMage = next.units.find((x) => x.id === mage.id);
    const nextTarget = next.units.find((x) => x.id === target.id);
    const actErr = activateUnit(next, nextMage);
    if (actErr)
        return { ok: false, error: actErr };
    let damage = chosenDamage;
    if (next.damageBuff[nextMage.player] > 0)
        damage += 2;
    nextMage.energy = (nextMage.energy ?? 0) - cost;
    nextMage.movesLeft -= 1;
    if (nextMage.movesLeft <= 0)
        nextMage.done = true;
    const events = [];
    // Ward check first — note this can kill nextMage itself if it's overdrawn
    // (e.g. the target is warded by this same mage, an edge case but not
    // rejected: the attack already committed its move/energy).
    if (absorbWithWard(next, nextTarget, damage, events)) {
        events.unshift({
            kind: 'mage-attacked',
            data: { unitId: nextMage.id, targetId: nextTarget.id, damage: 0, hpLeft: nextTarget.hp, cost, warded: true },
        });
        return ok(next, events);
    }
    let damageToHp = 0;
    if (damage > nextTarget.armor) {
        damageToHp = damage - nextTarget.armor;
        nextTarget.armor = 0;
    }
    else {
        nextTarget.armor -= damage;
    }
    nextTarget.hp -= damageToHp;
    events.push({ kind: 'mage-attacked', data: { unitId: nextMage.id, targetId: nextTarget.id, damage, hpLeft: nextTarget.hp, cost } });
    if (nextTarget.hp <= 0) {
        dropUnitBackpack(next, nextTarget);
        next.units = next.units.filter((u) => u.id !== nextTarget.id);
        events.push({ kind: 'unit-killed', data: { unitId: nextTarget.id } });
        maybeFinishMatch(next, events);
    }
    return ok(next, events);
}
/**
 * Ward: a per-unit shield, toggled in bulk. Every id in `toggleUnitIds`
 * flips — an unwarded living ally becomes warded by this mage; a unit this
 * mage is currently warding has its ward removed. Ids that don't resolve to
 * a living ally of the mage's own side are silently skipped (client-side
 * targeting already restricts the picker to legal ids; a stale id just does
 * nothing rather than failing the whole batch).
 *
 * Free of energy cost up front — the whole point of this ability is that
 * warding costs nothing until a warded unit is actually hit (see
 * absorbWithWard). Costs exactly 1 move, no matter how many ids are
 * toggled — the client batches an entire pick/unpick session into one
 * `mage-ward` action (see [[kc-mage-ward-mechanic]]).
 */
function applyMageWard(state, a) {
    const mage = requireActingMage(state, a.unitId);
    if (isValidationError(mage))
        return { ok: false, error: mage };
    const toggled = a.toggleUnitIds.filter((id) => state.units.some((u) => u.id === id && u.hp > 0 && u.player === mage.player));
    if (toggled.length === 0)
        return err('no-warding-target', 'no living ally to toggle');
    const next = cloneState(state);
    const nextMage = next.units.find((x) => x.id === mage.id);
    const actErr = activateUnit(next, nextMage);
    if (actErr)
        return { ok: false, error: actErr };
    const added = [];
    const removed = [];
    for (const id of toggled) {
        const u = next.units.find((x) => x.id === id && x.hp > 0);
        if (!u)
            continue;
        if (u.wardedBy === nextMage.id) {
            u.wardedBy = null;
            removed.push(id);
        }
        else {
            // Re-warding a unit currently shielded by a DIFFERENT mage simply
            // switches which mage is on the hook for it.
            u.wardedBy = nextMage.id;
            added.push(id);
        }
    }
    nextMage.warding = next.units.filter((u) => u.wardedBy === nextMage.id).map((u) => u.id);
    nextMage.movesLeft -= 1;
    if (nextMage.movesLeft <= 0)
        nextMage.done = true;
    return ok(next, [
        { kind: 'mage-warded', data: { unitId: nextMage.id, added, removed } },
    ]);
}
/**
 * Drain: the mage takes 1 HP from an adjacent unit (ally or enemy, as long
 * as that unit isn't warded by some OTHER mage) and converts it straight to
 * energy at MAGE_DRAIN_ENERGY_PER_HP energy per HP. Costs a move but no
 * energy of its own — it's how a mage refuels mid-fight.
 *
 * Draining a target warded by a DIFFERENT mage is blocked outright (that
 * mage's shield isn't this mage's to spend down). Draining a target this
 * SAME mage is warding is allowed — the 1 hp still goes through the ward
 * (absorbWithWard), which is a no-op drain of energy from itself; that's an
 * intentionally odd edge case left as-is rather than special-cased away.
 */
function applyMageDrain(state, a) {
    const mage = requireActingMage(state, a.unitId);
    if (isValidationError(mage))
        return { ok: false, error: mage };
    const target = findUnit(state, a.targetUnitId);
    if (!target)
        return err('unit-not-found', 'drain target not alive');
    if (target.id === mage.id)
        return err('illegal-attack', 'cannot drain yourself');
    const chebyshev = Math.max(Math.abs(target.row - mage.row), Math.abs(target.col - mage.col));
    if (chebyshev > 1)
        return err('not-adjacent', 'drain target must stand adjacent');
    if (target.wardedBy && target.wardedBy !== mage.id) {
        return err('illegal-attack', 'target is warded by another mage');
    }
    if (target.hp <= 1)
        return err('illegal-attack', 'cannot drain a target down to 0 hp');
    const next = cloneState(state);
    const nextMage = next.units.find((x) => x.id === mage.id);
    const nextTarget = next.units.find((x) => x.id === target.id);
    const actErr = activateUnit(next, nextMage);
    if (actErr)
        return { ok: false, error: actErr };
    const events = [];
    if (absorbWithWard(next, nextTarget, 1, events)) {
        events.unshift({
            kind: 'mage-drained',
            data: { unitId: nextMage.id, targetId: nextTarget.id, hpLeft: nextTarget.hp, energyGained: 0, warded: true },
        });
        // absorbWithWard may have just killed nextMage itself (self-warded target,
        // overdrawn) — only spend its move if it's still alive to spend it.
        if (nextMage.hp > 0) {
            nextMage.movesLeft -= 1;
            if (nextMage.movesLeft <= 0)
                nextMage.done = true;
        }
        return ok(next, events);
    }
    nextTarget.hp -= 1;
    const maxEnergy = nextMage.maxEnergy ?? MAGE_MAX_ENERGY;
    nextMage.energy = Math.min(maxEnergy, (nextMage.energy ?? 0) + MAGE_DRAIN_ENERGY_PER_HP);
    nextMage.movesLeft -= 1;
    if (nextMage.movesLeft <= 0)
        nextMage.done = true;
    events.push({
        kind: 'mage-drained',
        data: { unitId: nextMage.id, targetId: nextTarget.id, hpLeft: nextTarget.hp, energyGained: MAGE_DRAIN_ENERGY_PER_HP },
    });
    return ok(next, events);
}
/**
 * Burn bridge: destroys a built bridge outright at any Chebyshev distance
 * (no partial-durability chipping like a catapult hit — one cast removes it
 * completely). Costs 1 move plus distance × MAGE_BURN_BRIDGE_ENERGY_PER_CELL
 * energy.
 */
function applyMageBurnBridge(state, a) {
    const mage = requireActingMage(state, a.unitId);
    if (isValidationError(mage))
        return { ok: false, error: mage };
    const isBridge = state.terrain.some((t) => t.row === a.row && t.col === a.col && t.type === 'bridge');
    if (!isBridge)
        return err('no-bridge-here', 'no bridge at given cell');
    const chebyshev = Math.max(Math.abs(a.row - mage.row), Math.abs(a.col - mage.col));
    const cost = chebyshev * MAGE_BURN_BRIDGE_ENERGY_PER_CELL;
    if ((mage.energy ?? 0) < cost)
        return err('no-energy', 'not enough energy to burn this bridge');
    const next = cloneState(state);
    const nextMage = next.units.find((x) => x.id === mage.id);
    const actErr = activateUnit(next, nextMage);
    if (actErr)
        return { ok: false, error: actErr };
    const key = bridgeKey(a.row, a.col);
    const rest = { ...next.bridgeDurability };
    delete rest[key];
    next.bridgeDurability = rest;
    next.terrain = next.terrain
        .filter((t) => !(t.row === a.row && t.col === a.col && t.type === 'bridge'))
        .concat([{ row: a.row, col: a.col, type: 'river' }]);
    nextMage.energy = (nextMage.energy ?? 0) - cost;
    nextMage.movesLeft -= 1;
    if (nextMage.movesLeft <= 0)
        nextMage.done = true;
    return ok(next, [{ kind: 'bridge-burned', data: { row: a.row, col: a.col, by: nextMage.id, cost } }]);
}
/**
 * Heal: restores HP to any living unit — self or ally, no enemy — at any
 * Chebyshev distance. 1 HP = 1 energy (MAGE_HEAL_ENERGY_PER_HP) is the base
 * cost; on top of that, distance to the target always adds its own cost at
 * MAGE_HEAL_ENERGY_PER_CELL energy per cell (Chebyshev), same shape as
 * mage-attack/mage-burn-bridge — the farther away the target, the more it
 * costs to reach, on top of however much HP is actually restored. Heals up
 * to the target's maxHp; healing 0 (already full) is rejected outright
 * rather than silently burning a move and energy for nothing.
 */
function applyMageHeal(state, a) {
    const mage = requireActingMage(state, a.unitId);
    if (isValidationError(mage))
        return { ok: false, error: mage };
    const target = findUnit(state, a.targetUnitId);
    if (!target)
        return err('no-heal-target', 'heal target not alive');
    if (target.player !== mage.player)
        return err('no-heal-target', 'can only heal your own units');
    if (target.hp >= target.maxHp)
        return err('already-full-hp', 'target is already at full hp');
    const chebyshev = Math.max(Math.abs(target.row - mage.row), Math.abs(target.col - mage.col));
    const missingHp = target.maxHp - target.hp;
    const healedHp = missingHp; // full top-up in one cast
    const cost = healedHp * MAGE_HEAL_ENERGY_PER_HP + chebyshev * MAGE_HEAL_ENERGY_PER_CELL;
    if ((mage.energy ?? 0) < cost)
        return err('no-energy', 'not enough energy for this heal');
    const next = cloneState(state);
    const nextMage = next.units.find((x) => x.id === mage.id);
    const nextTarget = next.units.find((x) => x.id === target.id);
    const actErr = activateUnit(next, nextMage);
    if (actErr)
        return { ok: false, error: actErr };
    nextTarget.hp = nextTarget.maxHp;
    nextMage.energy = (nextMage.energy ?? 0) - cost;
    nextMage.movesLeft -= 1;
    if (nextMage.movesLeft <= 0)
        nextMage.done = true;
    return ok(next, [
        {
            kind: 'mage-healed',
            data: { unitId: nextMage.id, targetId: nextTarget.id, healedHp, hpLeft: nextTarget.hp, cost, distance: chebyshev },
        },
    ]);
}
/** True when (row,col) is impassable for reasons OTHER than an in-progress
 * construction: river/mountain/rock terrain, or a live unit standing there. */
function isBlockedByTerrainOrUnit(state, row, col) {
    if (state.units.some((u) => u.hp > 0 && u.row === row && u.col === col))
        return true;
    return state.terrain.some((t) => t.row === row && t.col === col && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'));
}
function bridgeKey(row, col) {
    return `${row},${col}`;
}
/**
 * A knight builds a tower or bridge by standing on a cell orthogonally
 * adjacent to the target cell and spending its whole turn (all movesLeft,
 * which must be exactly its full BUILD_COST_PER_TURN — it can't half-commit
 * moves elsewhere first) on the site. Building is NOT a per-unit activation
 * — any knight can add work to an in-progress site, including one a
 * different knight started; the site tracks progress, not who's building it.
 *
 * The target cell is impassable (like a mountain) while under construction.
 * Once `progress` reaches BUILD_WORK_TOTAL the site is promoted: a tower
 * becomes a real TowerPosition, a bridge overwrites the river cell there
 * with a `bridge` TerrainCell and gets BRIDGE_MAX_DURABILITY hit points.
 */
function applyBuild(state, unitId, row, col, kind) {
    const u = findUnit(state, unitId);
    if (!u)
        return err('unit-not-found', `unit ${unitId} not alive`);
    if (u.player !== state.currentPlayer)
        return err('wrong-turn', "not this player's turn");
    if (u.type !== 'knight')
        return err('unit-cannot-act', 'only a knight can build');
    if (u.done)
        return err('unit-cannot-act', 'unit already finished');
    if (u.movesLeft !== BUILD_COST_PER_TURN) {
        return err('no-moves-left', 'building spends the knight\'s whole turn, all at once');
    }
    if (!insideBoard(row, col))
        return err('not-empty-cell', 'target cell is off the board');
    const chebyshev = Math.max(Math.abs(row - u.row), Math.abs(col - u.col));
    const isOrtho = (row === u.row || col === u.col) && chebyshev === 1;
    if (!isOrtho)
        return err('not-adjacent', 'must build from an orthogonally adjacent cell');
    const existing = state.constructions.find((c) => c.row === row && c.col === col);
    if (existing && existing.kind !== kind) {
        return err('already-built', 'a different structure is already under construction here');
    }
    if (!existing) {
        if (kind === 'tower') {
            if (state.towers.some((t) => t.row === row && t.col === col)) {
                return err('already-built', 'a tower already stands here');
            }
            if (isBlockedByTerrainOrUnit(state, row, col)) {
                return err('not-empty-cell', 'target cell is not free to build on');
            }
        }
        else {
            const isRiver = state.terrain.some((t) => t.row === row && t.col === col && t.type === 'river');
            if (!isRiver)
                return err('not-river-cell', 'a bridge can only be built on a river cell');
            if (state.units.some((o) => o.hp > 0 && o.row === row && o.col === col)) {
                return err('cell-occupied', 'a unit is standing on the river cell');
            }
        }
    }
    const next = cloneState(state);
    const nextU = next.units.find((x) => x.id === unitId);
    nextU.movesLeft = 0;
    nextU.done = true;
    const site = next.constructions.find((c) => c.row === row && c.col === col);
    const progress = (site ? site.progress : 0) + BUILD_COST_PER_TURN;
    const events = [];
    if (progress >= BUILD_WORK_TOTAL) {
        // Finished — promote the site and remove it from constructions.
        next.constructions = next.constructions.filter((c) => !(c.row === row && c.col === col));
        if (kind === 'tower') {
            next.towers = [...next.towers, { row, col }];
            events.push({ kind: 'tower-built', data: { row, col, unitId } });
        }
        else {
            next.terrain = next.terrain
                .filter((t) => !(t.row === row && t.col === col))
                .concat([{ row, col, type: 'bridge' }]);
            next.bridgeDurability = { ...next.bridgeDurability, [bridgeKey(row, col)]: BRIDGE_MAX_DURABILITY };
            events.push({ kind: 'bridge-built', data: { row, col, unitId } });
        }
    }
    else if (site) {
        next.constructions = next.constructions.map((c) => c.row === row && c.col === col ? { ...c, progress } : c);
    }
    else {
        next.constructions = [...next.constructions, { row, col, kind, progress }];
    }
    return ok(next, events);
}
function pickLoot(rng) {
    const items = [...RUINS_LOOT_TABLE];
    const weights = items.map((i) => i.weight);
    return weightedChoiceWith(rng, items, weights);
}
//# sourceMappingURL=apply.js.map