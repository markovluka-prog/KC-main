// Canvas colour palette, extracted from main.ts (Phase 2 refactor, Increment 3).
// Kept as literals for now; Increment 10 (design tokens) will let these read
// from CSS custom properties so the canvas and DOM share one source of truth.

export const COLORS = {
  bg: '#1a1410',
  grid: '#3c3228',
  groundA: '#557832',
  groundB: '#4e7030',
  move: 'rgba(65, 190, 70, 0.35)',
  attack: 'rgba(210, 65, 65, 0.35)',
  attackL: 'rgba(230, 120, 50, 0.40)', // L-attack highlight
  selected: '#e8c35b',
  p1: '#59a3ff',
  p2: '#e35757',
  // Two meanings used to share the same red/orange range and read as one
  // tangled cloud of highlights: "I can hit this" vs "this can hit me".
  // Now split on hue so they never compete for attention on the same square:
  //   RED    = offense — squares/units YOU can attack this turn.
  //   BLUE   = danger  — squares an enemy could attack FROM right now
  //            (the threat overlay), independent of whose turn it is.
  threatFill: 'rgba(70, 140, 230, 0.20)',
  threatStroke: 'rgba(120, 175, 255, 0.55)',
} as const;
