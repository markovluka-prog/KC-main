/**
 * Server-side tactical search for /api/ai-move.
 *
 * WHY THIS EXISTS
 * The route asks an LLM (Ollama → OpenRouter) for a turn plan. When neither is
 * reachable — the common case for a self-hosted deployment with no model and no
 * API key — it used to fall back to "every unit performs its first available
 * action", which is close to random play. This module is that fallback done
 * properly: a real MCTS over the position the client sent.
 *
 * WHAT IT CAN AND CANNOT SEE
 * The request carries units and, per unit, the exact list of legal actions the
 * client enumerated. It does NOT carry the map: no castle columns, towers,
 * ruins or terrain. So this search deliberately optimises MATERIAL AND TACTICS
 * (kills, trades, threat avoidance, staying near the fight) and cannot reason
 * about castle capture — the actual win condition. It is a strong stand-in for
 * a missing LLM, not a replacement for the client-side engine in packages/web,
 * which does have the full board and searches castle races properly.
 *
 * Actions are never invented: the search only ever chooses from the
 * `availableActions` the client supplied, and returns those exact objects, so
 * whatever comes back is legal by construction.
 */
const PW_ALPHA = 0.45;
const PW_K = 1.5;
const MAX_BREADTH = 12;
const ROLLOUT_DEPTH = 6;
/** Per-batch clock granularity: small enough never to overshoot meaningfully. */
const BATCH_TARGET_MS = 4;
function now() {
    return Date.now();
}
// ── State construction ──────────────────────────────────────────────────────
function buildState(input) {
    const units = [];
    input.myUnits.forEach((u, i) => {
        units.push({
            id: u.id,
            side: 0,
            hp: u.hp,
            armor: u.armor,
            damage: u.damage,
            row: u.row,
            col: u.col,
            origin: i,
            // A unit with no legal action cannot contribute to a plan.
            acted: u.availableActions.length === 0 || u.movesLeft <= 0,
        });
    });
    for (const e of input.enemyUnits) {
        units.push({
            id: e.id,
            side: 1,
            hp: e.hp,
            armor: e.armor,
            damage: e.damage,
            row: e.row,
            col: e.col,
            origin: -1,
            acted: false,
        });
    }
    return {
        units,
        damageBuff: input.damageBuff ?? 0,
        shieldTurns: input.shieldTurns ?? 0,
    };
}
function cloneState(s) {
    return {
        units: s.units.map((u) => ({ ...u })),
        damageBuff: s.damageBuff,
        shieldTurns: s.shieldTurns,
    };
}
function chebyshev(r1, c1, r2, c2) {
    return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
}
/** Damage `attacker` deals to `target`, mirroring the client's combat rule:
 *  damage - armor, with our buff/shield applied to the relevant side. */
function damageOf(state, attacker, target) {
    let dmg = attacker.damage;
    if (attacker.side === 0 && state.damageBuff > 0)
        dmg += 2;
    dmg -= target.armor;
    if (target.side === 0 && state.shieldTurns > 0)
        dmg -= 2;
    return Math.max(0, dmg);
}
// ── Applying an action ──────────────────────────────────────────────────────
/** Apply one of OUR enumerated actions. Returns a new state. */
function applyAction(state, unitId, action) {
    const ns = cloneState(state);
    const unit = ns.units.find((u) => u.id === unitId && u.hp > 0);
    if (!unit)
        return ns;
    if (action.type === 'attack' && action.targetRow !== undefined && action.targetCol !== undefined) {
        const target = ns.units.find((u) => u.hp > 0 &&
            u.side !== unit.side &&
            u.row === action.targetRow &&
            u.col === action.targetCol);
        if (target) {
            target.hp -= damageOf(ns, unit, target);
            if (target.hp <= 0)
                ns.units = ns.units.filter((u) => u !== target);
        }
        // Attackers that jump (cavalry) land on the supplied square.
        if (action.landingRow !== undefined && action.landingCol !== undefined) {
            unit.row = action.landingRow;
            unit.col = action.landingCol;
        }
    }
    else if (action.type === 'move' && action.row !== undefined && action.col !== undefined) {
        unit.row = action.row;
        unit.col = action.col;
    }
    // spell / craft / ruins have no positional model here; they simply consume
    // the unit's turn. Scoring handles whether they are worth taking.
    unit.acted = true;
    return ns;
}
// ── Evaluation ──────────────────────────────────────────────────────────────
/** Static evaluation from side 0's perspective, in "material points". */
function evaluate(state) {
    let score = 0;
    const mine = [];
    const theirs = [];
    for (const u of state.units) {
        if (u.hp <= 0)
            continue;
        (u.side === 0 ? mine : theirs).push(u);
        const worth = 1000 + u.hp * 120 + u.damage * 60 + u.armor * 40;
        score += u.side === 0 ? worth : -worth;
    }
    if (mine.length === 0)
        return -1e6;
    if (theirs.length === 0)
        return 1e6;
    // Engagement: reward being able to reach the enemy, and punish standing where
    // an enemy can hit us for free. Without map knowledge this is the main source
    // of positional signal.
    for (const m of mine) {
        let nearest = Infinity;
        for (const t of theirs)
            nearest = Math.min(nearest, chebyshev(m.row, m.col, t.row, t.col));
        if (nearest !== Infinity)
            score -= nearest * 8;
    }
    for (const t of theirs) {
        for (const m of mine) {
            if (chebyshev(t.row, t.col, m.row, m.col) <= 1) {
                const incoming = Math.max(0, t.damage - m.armor - (state.shieldTurns > 0 ? 2 : 0));
                // Standing next to something that can kill us is much worse than
                // standing next to something that merely chips us.
                score -= incoming >= m.hp ? 700 : incoming * 40;
            }
        }
    }
    return score;
}
/** Squash the material evaluation into (-1, 1) so it is commensurate with the
 *  ±1 terminal rewards the rollouts return. */
function normalise(raw) {
    return Math.tanh(raw / 4000);
}
// ── Action scoring (the rollout / expansion policy) ─────────────────────────
/** Heuristic value of one of our enumerated actions in `state`. Drives both the
 *  greedy rollouts and the order in which the tree expands candidates. */
function scoreAction(state, unit, action) {
    if (action.type === 'attack' && action.targetRow !== undefined) {
        const target = state.units.find((u) => u.hp > 0 &&
            u.side !== unit.side &&
            u.row === action.targetRow &&
            u.col === action.targetCol);
        if (!target)
            return -Infinity; // target already dead in this line
        const dmg = damageOf(state, unit, target);
        if (dmg >= target.hp) {
            // A kill is worth the whole unit, and killing a dangerous one is better.
            return 20000 + target.damage * 400 + target.hp * 100;
        }
        return 4000 + dmg * 500 - (dmg === 0 ? 5000 : 0);
    }
    if (action.type === 'move' && action.row !== undefined && action.col !== undefined) {
        const enemies = state.units.filter((u) => u.hp > 0 && u.side !== unit.side);
        if (enemies.length === 0)
            return 0;
        let before = Infinity;
        let after = Infinity;
        for (const e of enemies) {
            before = Math.min(before, chebyshev(unit.row, unit.col, e.row, e.col));
            after = Math.min(after, chebyshev(action.row, action.col, e.row, e.col));
        }
        // Close the distance, but do not walk into a square where something kills us.
        let score = (before - after) * 300;
        for (const e of enemies) {
            if (chebyshev(action.row, action.col, e.row, e.col) <= 1) {
                const incoming = Math.max(0, e.damage - unit.armor - (state.shieldTurns > 0 ? 2 : 0));
                if (incoming >= unit.hp)
                    score -= 6000;
                else
                    score -= incoming * 60;
            }
        }
        return score;
    }
    // spell / craft / ruins: mildly positive so they get tried when nothing else
    // is productive, but never preferred over a real tactical action.
    if (action.type === 'spell')
        return 1500;
    if (action.type === 'craft')
        return 900;
    if (action.type === 'ruins')
        return 300;
    return 0;
}
/** The opponent's reply policy. We do not receive their legal actions, so their
 *  turn is modelled as: each unit attacks an adjacent target if it can,
 *  otherwise steps one square toward the nearest of our units. */
function opponentTurn(state) {
    const cur = cloneState(state);
    const actors = cur.units.filter((u) => u.side === 1 && u.hp > 0).map((u) => u.id);
    for (const id of actors) {
        const unit = cur.units.find((u) => u.id === id && u.hp > 0);
        if (!unit)
            continue;
        const targets = cur.units.filter((u) => u.side === 0 && u.hp > 0);
        if (targets.length === 0)
            break;
        // Prefer a kill, then the most damage.
        let best = null;
        let bestScore = -Infinity;
        for (const t of targets) {
            if (chebyshev(unit.row, unit.col, t.row, t.col) > 1)
                continue;
            const dmg = damageOf(cur, unit, t);
            const s = dmg >= t.hp ? 100000 + t.damage : dmg * 100;
            if (s > bestScore) {
                bestScore = s;
                best = t;
            }
        }
        if (best) {
            best.hp -= damageOf(cur, unit, best);
            if (best.hp <= 0)
                cur.units = cur.units.filter((u) => u !== best);
            continue;
        }
        // Step toward the nearest of ours.
        let nearest = null;
        let nd = Infinity;
        for (const t of targets) {
            const d = chebyshev(unit.row, unit.col, t.row, t.col);
            if (d < nd) {
                nd = d;
                nearest = t;
            }
        }
        if (nearest) {
            unit.row += Math.sign(nearest.row - unit.row);
            unit.col += Math.sign(nearest.col - unit.col);
        }
    }
    return cur;
}
/** Play out OUR turn greedily, optionally forcing the first action. */
function greedyTurn(state, input, first) {
    let cur = cloneState(state);
    const plan = [];
    if (first) {
        const src = input.myUnits[first.unitIndex];
        const unit = cur.units.find((u) => u.id === src.id && u.hp > 0 && !u.acted);
        if (unit) {
            cur = applyAction(cur, src.id, first.action);
            plan.push({ unitId: src.id, action: first.action });
        }
    }
    // At most one action per unit — the client activates each unit once per turn.
    for (let guard = 0; guard < input.myUnits.length + 1; guard += 1) {
        let bestUnitIndex = -1;
        let bestAction = null;
        let bestScore = 0; // require a positive score to bother acting
        for (let i = 0; i < input.myUnits.length; i += 1) {
            const src = input.myUnits[i];
            const unit = cur.units.find((u) => u.id === src.id && u.hp > 0 && !u.acted);
            if (!unit)
                continue;
            for (const action of src.availableActions) {
                const s = scoreAction(cur, unit, action);
                if (s > bestScore) {
                    bestScore = s;
                    bestAction = action;
                    bestUnitIndex = i;
                }
            }
        }
        if (!bestAction || bestUnitIndex < 0)
            break;
        const src = input.myUnits[bestUnitIndex];
        cur = applyAction(cur, src.id, bestAction);
        plan.push({ unitId: src.id, action: bestAction });
    }
    return { plan, endState: cur };
}
// ── Rollout ─────────────────────────────────────────────────────────────────
function rollout(state, startSide, input) {
    let cur = cloneState(state);
    let side = startSide;
    const reward = (win, d) => (win ? 1 : -1) * Math.pow(0.97, d);
    for (let d = 0; d < ROLLOUT_DEPTH; d += 1) {
        const mine = cur.units.filter((u) => u.side === 0 && u.hp > 0).length;
        const theirs = cur.units.filter((u) => u.side === 1 && u.hp > 0).length;
        if (mine === 0)
            return reward(false, d);
        if (theirs === 0)
            return reward(true, d);
        if (side === 0) {
            // Our units are fresh at the start of each of our turns.
            cur.units.forEach((u) => {
                if (u.side === 0)
                    u.acted = false;
            });
            cur = greedyTurn(cur, input, null).endState;
        }
        else {
            cur = opponentTurn(cur);
            if (cur.damageBuff > 0)
                cur.damageBuff -= 1;
            if (cur.shieldTurns > 0)
                cur.shieldTurns -= 1;
        }
        side = side === 0 ? 1 : 0;
    }
    const mine = cur.units.filter((u) => u.side === 0 && u.hp > 0).length;
    const theirs = cur.units.filter((u) => u.side === 1 && u.hp > 0).length;
    if (mine === 0)
        return -1;
    if (theirs === 0)
        return 1;
    return normalise(evaluate(cur));
}
// ── Tree ────────────────────────────────────────────────────────────────────
function makeNode(state, side, parent, parentPlan) {
    const mine = state.units.filter((u) => u.side === 0 && u.hp > 0).length;
    const theirs = state.units.filter((u) => u.side === 1 && u.hp > 0).length;
    const terminal = mine === 0 || theirs === 0;
    const terminalValue = mine === 0 ? -1 : theirs === 0 ? 1 : 0;
    return {
        state,
        side,
        parent,
        parentPlan,
        children: [],
        visits: 0,
        totalValue: 0,
        value: terminal ? terminalValue : 0,
        terminal,
        terminalValue,
        solved: terminal,
        solvedValue: terminalValue,
        starters: null,
        starterIndex: 0,
        greedyTried: false,
        seen: new Set(),
    };
}
function planSignature(plan) {
    return plan
        .map((p) => `${p.unitId}:${p.action.type}:${p.action.row ?? -1},${p.action.col ?? -1}:${p.action.targetRow ?? -1},${p.action.targetCol ?? -1}`)
        .join(';');
}
function allowedChildren(node) {
    return Math.max(1, Math.min(MAX_BREADTH, Math.floor(PW_K * Math.pow(Math.max(node.visits, 1), PW_ALPHA))));
}
function exhausted(node) {
    if (node.starters === null)
        return false;
    if (!node.greedyTried)
        return false;
    return node.starterIndex >= node.starters.length;
}
/** Minimax-aware value: averaging at the opponent's node would assume they
 *  reply at random and would hide forced refutations. */
function refreshValue(node) {
    if (node.solved) {
        node.value = node.solvedValue;
        return;
    }
    if (node.visits === 0) {
        node.value = 0;
        return;
    }
    const avg = node.totalValue / node.visits;
    const moverIsUs = node.side === 0;
    let best = moverIsUs ? -Infinity : Infinity;
    let seen = 0;
    for (const c of node.children) {
        if (c.visits === 0)
            continue;
        const v = c.solved ? c.solvedValue : c.value;
        if (moverIsUs ? v > best : v < best)
            best = v;
        seen += 1;
    }
    if (seen === 0) {
        node.value = avg;
        return;
    }
    const w = Math.min(1, node.visits / (node.visits + 24));
    node.value = (1 - w) * avg + w * best;
}
function updateSolved(node) {
    if (node.solved || node.children.length === 0)
        return;
    const moverIsUs = node.side === 0;
    for (const c of node.children) {
        if (!c.solved)
            continue;
        if (moverIsUs ? c.solvedValue > 0 : c.solvedValue < 0) {
            node.solved = true;
            node.solvedValue = c.solvedValue;
            return;
        }
    }
    if (!exhausted(node))
        return;
    if (node.children.length < allowedChildren(node))
        return;
    let all = true;
    let worst = moverIsUs ? -Infinity : Infinity;
    for (const c of node.children) {
        if (!c.solved) {
            all = false;
            break;
        }
        worst = moverIsUs ? Math.max(worst, c.solvedValue) : Math.min(worst, c.solvedValue);
    }
    if (all && Number.isFinite(worst)) {
        node.solved = true;
        node.solvedValue = worst;
    }
}
function bestChild(node, exploration) {
    const moverIsUs = node.side === 0;
    const logN = Math.log(Math.max(1, node.visits));
    let best = null;
    let bestScore = -Infinity;
    for (const c of node.children) {
        if (c.visits === 0)
            return c;
        if (c.solved && (moverIsUs ? c.solvedValue > 0 : c.solvedValue < 0))
            return c;
        const v = c.solved ? c.solvedValue : c.value;
        const exploit = moverIsUs ? v : -v;
        const uct = exploit + exploration * Math.sqrt(logN / c.visits);
        if (uct > bestScore) {
            bestScore = uct;
            best = c;
        }
    }
    return best;
}
function select(root, exploration) {
    let node = root;
    for (;;) {
        if (node.terminal)
            return node;
        if (node.children.length < allowedChildren(node) && !exhausted(node))
            return node;
        if (node.children.length === 0)
            return node;
        const next = bestChild(node, exploration);
        if (!next)
            return node;
        node = next;
    }
}
function computeStarters(state, input) {
    const out = [];
    input.myUnits.forEach((src, i) => {
        const unit = state.units.find((u) => u.id === src.id && u.hp > 0 && !u.acted);
        if (!unit)
            return;
        const scored = src.availableActions
            .map((action) => ({ unitIndex: i, action, score: scoreAction(state, unit, action) }))
            .filter((s) => Number.isFinite(s.score))
            .sort((a, b) => b.score - a.score)
            .slice(0, 3); // top-3 per unit keeps candidates diverse
        out.push(...scored);
    });
    return out.sort((a, b) => b.score - a.score);
}
/** Add exactly one child, generating its plan lazily. */
function expand(node, input) {
    // Only OUR side branches on enumerated actions; the opponent's reply is a
    // single deterministic policy, so their node has exactly one child.
    if (node.side === 1) {
        if (node.children.length > 0)
            return node.children[0];
        let next = opponentTurn(node.state);
        if (next.damageBuff > 0)
            next.damageBuff -= 1;
        if (next.shieldTurns > 0)
            next.shieldTurns -= 1;
        next = cloneState(next);
        next.units.forEach((u) => {
            if (u.side === 0)
                u.acted = false;
        });
        const child = makeNode(next, 0, node, []);
        node.children.push(child);
        node.greedyTried = true;
        node.starters = [];
        return child;
    }
    if (node.starters === null)
        node.starters = computeStarters(node.state, input);
    for (;;) {
        let plan;
        let endState;
        if (!node.greedyTried) {
            node.greedyTried = true;
            const g = greedyTurn(node.state, input, null);
            plan = g.plan;
            endState = g.endState;
        }
        else if (node.starterIndex < node.starters.length) {
            const s = node.starters[node.starterIndex];
            node.starterIndex += 1;
            const g = greedyTurn(node.state, input, { unitIndex: s.unitIndex, action: s.action });
            plan = g.plan;
            endState = g.endState;
        }
        else {
            return null;
        }
        if (plan.length === 0)
            continue;
        const sig = planSignature(plan);
        if (node.seen.has(sig))
            continue;
        node.seen.add(sig);
        const child = makeNode(endState, 1, node, plan);
        node.children.push(child);
        return child;
    }
}
function backprop(node, value) {
    let cur = node;
    while (cur !== null) {
        cur.visits += 1;
        cur.totalValue += value;
        if (cur.parent)
            updateSolved(cur.parent);
        refreshValue(cur);
        cur = cur.parent;
    }
}
// ── Public entry point ──────────────────────────────────────────────────────
/**
 * Search the position and return a turn plan built exclusively from the
 * client-supplied `availableActions`. Always returns a legal plan; falls back to
 * the greedy turn if the budget was too small to build a tree.
 */
export function searchTurnPlan(input) {
    const actionable = input.myUnits.filter((u) => u.availableActions.length > 0);
    if (actionable.length === 0)
        return [];
    const root = makeNode(buildState(input), 0, null, []);
    const deadline = now() + Math.max(1, input.timeBudgetMs);
    let iterCost = 2; // ms, rolling estimate used to size batches
    while (now() < deadline && !root.solved) {
        const batch = Math.max(1, Math.min(64, Math.round(BATCH_TARGET_MS / iterCost)));
        const t0 = now();
        let ran = 0;
        for (let i = 0; i < batch; i += 1) {
            if (root.solved)
                break;
            const leaf = select(root, input.exploration);
            let evalNode = leaf;
            if (!leaf.terminal) {
                const expanded = expand(leaf, input);
                if (expanded)
                    evalNode = expanded;
            }
            const value = evalNode.terminal
                ? evalNode.terminalValue
                : rollout(evalNode.state, evalNode.side, input);
            backprop(evalNode, value);
            ran += 1;
        }
        const elapsed = now() - t0;
        if (ran > 0)
            iterCost = iterCost * 0.7 + Math.max(0.05, elapsed / ran) * 0.3;
    }
    if (root.children.length === 0) {
        // Budget too small to expand anything — take the greedy turn.
        return greedyTurn(root.state, input, null).plan;
    }
    const proven = root.children.find((c) => c.solved && c.solvedValue > 0);
    if (proven)
        return proven.parentPlan;
    const pool = root.children.filter((c) => c.visits > 0);
    const usable = pool.length > 0 ? pool : root.children;
    if (input.selectionTemp <= 0 || usable.length === 1) {
        return usable.reduce((a, b) => (a.visits > b.visits ? a : b)).parentPlan;
    }
    // Difficulty noise: sample among plans by visits^(1/T) so a weaker setting is
    // unpredictable without ever choosing a plan it believes is bad.
    const weights = usable.map((c) => Math.pow(Math.max(c.visits, 1), 1 / input.selectionTemp));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(total) || total <= 0) {
        return usable.reduce((a, b) => (a.visits > b.visits ? a : b)).parentPlan;
    }
    let r = Math.random() * total;
    for (let i = 0; i < usable.length; i += 1) {
        r -= weights[i];
        if (r <= 0)
            return usable[i].parentPlan;
    }
    return usable[usable.length - 1].parentPlan;
}
/** Per-difficulty search settings, mirroring the client's philosophy: strength
 *  comes from search budget and decisiveness, never from deliberate blunders. */
export function searchSettingsFor(difficulty) {
    switch (difficulty) {
        case 'easy':
            return { timeBudgetMs: 120, exploration: 2.2, selectionTemp: 1.2 };
        case 'hard':
            return { timeBudgetMs: 900, exploration: 1.1, selectionTemp: 0 };
        default:
            return { timeBudgetMs: 400, exploration: 1.6, selectionTemp: 0.4 };
    }
}
