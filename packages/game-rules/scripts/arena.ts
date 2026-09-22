/*
 * Beam search vs greedy — plan step 7's A/B arena, played on the real
 * `createMatchSetup(seed)` / `applyAction` engine (not an ad hoc position or
 * a hand-rolled LightState mirror). Every game is fully deterministic given
 * its seed: setup, terrain, hidden pickups and both sides' every decision
 * flow from the same seeded `mulberry32` the server itself uses, so a result
 * is exactly reproducible by re-running with the same seed.
 *
 * `pnpm --filter @kc/game-rules arena` runs it via vitest (this repo's only
 * available TS runner — see ai-bench.ts in packages/web for the precedent).
 * Options are env vars for the same reason argv doesn't survive vitest:
 *
 *   pnpm --filter @kc/game-rules arena                          # default: 20 games, hard beam
 *   ARENA_GAMES=50 pnpm --filter @kc/game-rules arena            # more games
 *   ARENA_DIFFICULTY=medium pnpm --filter @kc/game-rules arena   # weaker beam preset
 *   ARENA_MAX_TURNS=80 pnpm --filter @kc/game-rules arena        # longer games before a draw
 *
 * Sides are swapped every other game so a first-move (or first-seed) bias
 * cannot masquerade as a strength difference.
 */
import { it } from 'vitest';
import {
  applyAction,
  createInitialState,
  createMatchSetup,
  endTurn,
  greedyTurn,
  planTurn,
  planTurnWithReply,
  toBeamOptions,
  toReplyOptions,
  BEAM_DIFFICULTY,
  mulberry32,
} from '../src/index.js';

function parseArgs() {
  const get = (name, fallback) => process.env[`ARENA_${name.toUpperCase()}`] ?? fallback;
  return {
    games: Number(get('games', '20')),
    difficulty: get('difficulty', 'hard'),
    maxTurns: Number(get('max_turns', '60')),
    seedStart: Number(get('seed_start', '1')),
  };
}

/** Play one full game: beam (player `beamSide`) vs greedy (the other side).
 * Returns { winner, turns } — winner is 1, 2, or null (turn limit reached). */
function playOneGame(seed, beamSide, difficulty, maxTurns) {
  const setup = createMatchSetup(seed);
  let state = createInitialState({
    mode: 'pvp',
    seed,
    units: setup.units,
    castleP1Col: setup.castleP1Col,
    castleP2Col: setup.castleP2Col,
    towers: setup.towers,
    ruins: setup.ruins,
    ruins2: setup.ruins2,
    terrain: setup.terrain,
    hiddenPickups: setup.hiddenPickups,
  });
  // Two independent seeded RNG streams so the beam's internal search
  // (scratch applyAction calls while scoring candidates, any ruins loot it
  // triggers) and the actually-executed actions/greedy turns never draw
  // from the same stream — sharing one would make the executed loot rolls
  // depend on exactly how many candidate actions the search happened to
  // score first, which is an implementation detail, not something a rerun
  // should be sensitive to. Both derive from `seed` so the whole game is
  // still exactly reproducible.
  const execRng = mulberry32(seed, 0);
  const searchRngSeed = seed * 2 + 1; // odd offset: never collides with execRng's seed
  const config = BEAM_DIFFICULTY[difficulty];

  let turns = 0;
  while (state.winner === null && turns < maxTurns) {
    const mover = state.currentPlayer;
    if (mover === beamSide) {
      const beamOptions = config.reply
        ? { ...toReplyOptions(config), rngSeed: searchRngSeed }
        : { ...toBeamOptions(config), rngSeed: searchRngSeed };
      const actions = config.reply
        ? planTurnWithReply(state, mover, beamOptions)
        : planTurn(state, mover, beamOptions);
      for (const action of actions) {
        const result = applyAction(state, action, execRng);
        if (result.ok) state = result.value;
        if (state.winner !== null) break;
      }
    } else {
      state = greedyTurn(state, mover, execRng);
    }
    if (state.winner !== null) break;
    state = endTurn(state);
    turns += 1;
  }

  return { winner: state.winner, turns };
}

function pct(n, total) {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

function runArena() {
  const args = parseArgs();
  console.log(`\nArena — beam (${args.difficulty}) vs greedy`);
  console.log(`games=${args.games} maxTurns=${args.maxTurns} seedStart=${args.seedStart}\n`);

  let beamWins = 0;
  let greedyWins = 0;
  let draws = 0;
  const lengths = [];
  const t0 = Date.now();

  for (let g = 0; g < args.games; g += 1) {
    const seed = args.seedStart + g;
    const beamSide = g % 2 === 0 ? 1 : 2; // swap sides every other game
    const result = playOneGame(seed, beamSide, args.difficulty, args.maxTurns);

    if (result.winner === null) draws += 1;
    else if (result.winner === beamSide) beamWins += 1;
    else greedyWins += 1;
    lengths.push(result.turns);

    process.stdout.write(
      `\rgame ${g + 1}/${args.games}  beam ${beamWins} — ${greedyWins} greedy (${draws} draws)`,
    );
  }

  const decisive = beamWins + greedyWins;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const avgLen = lengths.length ? (lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1) : '0';

  console.log('\n');
  console.log(`beam:   ${beamWins} wins (${pct(beamWins, decisive)} of decisive games)`);
  console.log(`greedy: ${greedyWins} wins (${pct(greedyWins, decisive)} of decisive games)`);
  console.log(`draws:  ${draws} (hit ${args.maxTurns}-turn limit)`);
  console.log(`avg game length: ${avgLen} turns`);
  console.log(`elapsed: ${elapsed}s\n`);
}

// vitest is this repo's only available TS/JS runner with no extra tooling —
// wrap the arena in a single `it()` so `pnpm --filter @kc/game-rules arena`
// (vitest run --config vitest.arena.config.ts) can execute it directly.
it('runs the beam-vs-greedy arena', () => {
  runArena();
}, 600_000);
