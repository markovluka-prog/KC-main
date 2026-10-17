#!/usr/bin/env bash
# Copy @kc/game-rules into supabase/functions/_shared/game-rules for the Deno
# Edge Functions. Follows relative imports from the entry files the functions
# use, rewrites `./x.js` → `./x.ts` (Deno resolves real file names) and stamps
# each file as generated. Run after any change to packages/game-rules/src.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/game-rules/src"
DST="$ROOT/supabase/functions/_shared/game-rules"
ENTRIES=(apply.ts setup.ts state.ts types.ts rng.ts)

declare -A seen=()
queue=("${ENTRIES[@]}")
while ((${#queue[@]})); do
  f="${queue[0]}"; queue=("${queue[@]:1}")
  [[ -n "${seen[$f]:-}" ]] && continue
  seen[$f]=1
  [[ -f "$SRC/$f" ]] || { echo "missing $SRC/$f" >&2; exit 1; }
  while read -r dep; do
    queue+=("${dep%.js}.ts")
  done < <(grep -oE "from '\./[a-zA-Z0-9_-]+\.js'" "$SRC/$f" | sed -E "s/from '\.\/(.*)'/\1/")
done

rm -f "$DST"/*.ts
mkdir -p "$DST"
for f in "${!seen[@]}"; do
  {
    echo "// AUTO-VENDORED from packages/game-rules/src/$f — DO NOT EDIT BY HAND."
    echo "// Edit the source and re-run scripts/vendor-game-rules.sh."
    sed -E "s#(from '\./[a-zA-Z0-9_-]+)\.js'#\1.ts'#g" "$SRC/$f"
  } > "$DST/$f"
done
echo "vendored ${#seen[@]} files → ${DST#$ROOT/}: $(printf '%s ' "${!seen[@]}" | tr ' ' '\n' | sort | tr '\n' ' ')"
