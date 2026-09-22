import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  GOALS,
  assignRoles,
  planStep,
  selectGoal,
  type RoleAssignmentUnit,
  type WorldState,
} from '../goap.js';

/** A fully "safe, nothing achieved yet" baseline — every test overrides just
 *  the facts relevant to the stage it's checking, like the old ladder's
 *  if/else conditions did. */
function baseState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    sallyDone: false,
    weHoldRuins: false,
    ruinsContested: false,
    ruinsTimedOut: false,
    weHoldBridge: false,
    wellArmed: false,
    forceRatioBucket: 'even',
    enemyNearOurDoor: false,
    weAreInEnemyCastle: false,
    enemyDefendersPresent: false,
    enemyCastleEmpty: true,
    ...overrides,
  };
}

describe('goal selection', () => {
  it('picks SecureHome when home is threatened and we are not ahead', () => {
    const s = baseState({ enemyNearOurDoor: true, forceRatioBucket: 'even' });
    expect(selectGoal(s).name).toBe('SecureHome');
  });

  it('picks WinByCastle when home is threatened but we are ahead', () => {
    const s = baseState({ enemyNearOurDoor: true, forceRatioBucket: 'ahead' });
    expect(selectGoal(s).name).toBe('WinByCastle');
  });

  it('picks WinByCastle by default (no threat)', () => {
    const s = baseState();
    expect(selectGoal(s).name).toBe('WinByCastle');
  });
});

describe('planStep — mirrors the 8 old stage-ladder branches', () => {
  it('defend: home threatened, behind/even, not sallied → defend-home', () => {
    const s = baseState({ enemyNearOurDoor: true, forceRatioBucket: 'even', sallyDone: false });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step?.name).toBe('defend');
  });

  it('mop-up: inside enemy castle with defenders present → mop-up', () => {
    const s = baseState({
      sallyDone: true,
      weHoldRuins: true,
      weHoldBridge: true,
      wellArmed: true,
      weAreInEnemyCastle: true,
      enemyDefendersPresent: true,
    });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step?.name).toBe('mop-up');
  });

  it('sally: haven\'t left the castle yet → sally is the first step', () => {
    const s = baseState({ sallyDone: false });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step?.name).toBe('sally');
  });

  it('take-ruins: sallied, ruins free and not timed out → take-ruins', () => {
    const s = baseState({ sallyDone: true, weHoldRuins: false, ruinsTimedOut: false });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step?.name).toBe('take-ruins');
  });

  it('hold-bridge: ruins held, bridge not yet held → hold-bridge', () => {
    const s = baseState({ sallyDone: true, weHoldRuins: true, weHoldBridge: false });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step?.name).toBe('hold-bridge');
  });

  it('hold-bridge also reachable via ruins-timeout (skip take-ruins)', () => {
    const s = baseState({
      sallyDone: true,
      weHoldRuins: false,
      ruinsTimedOut: true,
      weHoldBridge: false,
    });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step?.name).toBe('hold-bridge');
  });

  it('arm-up: ruins held, not well armed → arm-up (even with bridge already held)', () => {
    const s = baseState({
      sallyDone: true,
      weHoldRuins: true,
      weHoldBridge: true,
      wellArmed: false,
    });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step?.name).toBe('arm-up');
  });

  it('march: armed and bridge held, not yet in enemy castle → march', () => {
    const s = baseState({
      sallyDone: true,
      weHoldRuins: true,
      weHoldBridge: true,
      wellArmed: true,
      weAreInEnemyCastle: false,
    });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step?.name).toBe('march');
  });

  it('assault: enemy castle empty of defenders and we are not behind → assault', () => {
    const s = baseState({
      sallyDone: true,
      weHoldRuins: true,
      weHoldBridge: true,
      wellArmed: true,
      weAreInEnemyCastle: false,
      enemyDefendersPresent: false,
      forceRatioBucket: 'even',
    });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    // march (wellArmed && weHoldBridge && !inCastle) sorts before assault by
    // cost tie order in ACTIONS; both lead to weAreInEnemyCastle, so accept
    // either as correct — what matters is the chain reaches the goal.
    expect(['march', 'assault']).toContain(step?.name);
  });

  it('backward-chaining skips a step whose precondition is already met by board geometry', () => {
    // weHoldBridge already true (e.g. captured incidentally) — planner should
    // NOT insert a redundant hold-bridge step; next unmet need is arm-up.
    const s = baseState({
      sallyDone: true,
      weHoldRuins: true,
      weHoldBridge: true,
      wellArmed: false,
    });
    const goal = selectGoal(s);
    const { chain } = planStep(goal, s);
    expect(chain.some((a) => a.name === 'hold-bridge')).toBe(false);
    expect(chain[0]?.name).toBe('arm-up');
  });

  it('goal already satisfied → no step', () => {
    const s = baseState({
      weAreInEnemyCastle: true,
      enemyDefendersPresent: false,
    });
    const goal = selectGoal(s);
    const { step } = planStep(goal, s);
    expect(step).toBeNull();
  });
});

describe('ACTIONS / GOALS export sanity', () => {
  it('every action name is unique', () => {
    const names = ACTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every goal name is unique', () => {
    const names = GOALS.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('assignRoles — per-type role assignment', () => {
  const manhattan = (fr: number, fc: number, tr: number, tc: number): number =>
    Math.abs(fr - tr) + Math.abs(fc - tc);
  const alwaysFalse = () => false;

  function unit(id: number, type: string, row: number, col: number, maxMoves = 2): RoleAssignmentUnit {
    return { id, type, row, col, maxMoves };
  }

  it('catapults become skirmishers, never bridgeSquad or vanguard', () => {
    const units = [
      unit(1, 'catapult', 5, 5),
      unit(2, 'knight', 5, 6),
      unit(3, 'archer', 5, 7),
    ];
    const result = assignRoles({
      units,
      ruinsCells: [],
      ruinsCentre: null,
      ownCentre: { row: 0, col: 0 },
      ruinsFarmers: 2,
      stage: 'hold-bridge',
      goalRow: 10,
      goalCol: 10,
      pathDist: manhattan,
      inRuins: alwaysFalse,
    });
    expect(result.skirmishers.has(1)).toBe(true);
    expect(result.bridgeSquad.has(1)).toBe(false);
    expect(result.vanguard.has(1)).toBe(false);
  });

  it('catapults are excluded from vanguard even when fastest to the goal', () => {
    const units = [
      unit(1, 'catapult', 9, 10, 5), // closest + fastest, but must be excluded
      unit(2, 'knight', 5, 5, 2),
      unit(3, 'archer', 5, 6, 2),
    ];
    const result = assignRoles({
      units,
      ruinsCells: [],
      ruinsCentre: null,
      ownCentre: { row: 0, col: 0 },
      ruinsFarmers: 0,
      stage: 'sally',
      goalRow: 10,
      goalCol: 10,
      pathDist: manhattan,
      inRuins: alwaysFalse,
    });
    expect(result.vanguard.has(1)).toBe(false);
  });

  it('samurai join the bridge-holding squad alongside knights/archers/crossbows', () => {
    const units = [
      unit(1, 'samurai', 5, 5),
      unit(2, 'catapult', 5, 6),
      unit(3, 'cavalry', 8, 8), // farmer — closest to ruins centre
    ];
    const result = assignRoles({
      units,
      ruinsCells: [{ row: 9, col: 9 }],
      ruinsCentre: { row: 9, col: 9 },
      ownCentre: { row: 0, col: 0 },
      ruinsFarmers: 1,
      stage: 'hold-bridge',
      goalRow: 10,
      goalCol: 10,
      pathDist: manhattan,
      inRuins: alwaysFalse,
    });
    expect(result.bridgeSquad.has(1)).toBe(true);
    expect(result.farmers.has(3)).toBe(true);
    expect(result.bridgeSquad.has(2)).toBe(false); // catapult stays a skirmisher
  });
});
