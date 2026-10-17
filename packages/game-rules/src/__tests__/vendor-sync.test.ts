import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The Supabase Edge Functions run a VENDORED copy of these rules
 * (supabase/functions/_shared/game-rules, made by scripts/vendor-game-rules.sh).
 * When it drifts, online matches are judged by different rules than the
 * client plays — the copy once lagged ~850 lines behind. Fail fast instead.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const DST = fileURLToPath(new URL('../../../../supabase/functions/_shared/game-rules', import.meta.url));

describe('vendored server copy of the rules', () => {
  it.skipIf(!existsSync(DST))('matches packages/game-rules/src (run scripts/vendor-game-rules.sh)', () => {
    for (const f of readdirSync(DST).filter((n) => n.endsWith('.ts'))) {
      const expected =
        `// AUTO-VENDORED from packages/game-rules/src/${f} — DO NOT EDIT BY HAND.\n` +
        '// Edit the source and re-run scripts/vendor-game-rules.sh.\n' +
        readFileSync(join(SRC, f), 'utf8').replace(/(from '\.\/[a-zA-Z0-9_-]+)\.js'/g, "$1.ts'");
      expect(readFileSync(join(DST, f), 'utf8'), `${f} is out of date`).toBe(expected);
    }
  });
});
