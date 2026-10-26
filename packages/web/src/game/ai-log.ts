/**
 * Flight recorder for the bot: every turn the search plans, the position it saw
 * and the actions it chose are kept (last 80 turns, in memory only). The game-
 * over screen has a button that downloads them as JSON, so a lost game can be
 * replayed and the bot's actual mistakes found instead of guessed at.
 */
import type { GameState, ServerAction } from '@kc/game-rules';

interface AiLogEntry {
  turn: number;
  player: number;
  level: string;
  state: GameState;
  actions: ServerAction[];
}

const MAX_ENTRIES = 80;
const entries: AiLogEntry[] = [];

export function recordAiTurn(state: GameState, player: number, level: string, actions: ServerAction[]): void {
  try {
    entries.push({ turn: state.turnNumber, player, level, state: JSON.parse(JSON.stringify(state)), actions });
    if (entries.length > MAX_ENTRIES) entries.shift();
  } catch {
    /* logging must never break a turn */
  }
}

export function clearAiLog(): void {
  entries.length = 0;
}

export function aiLogSize(): number {
  return entries.length;
}

/** Save the recorded turns as a JSON file (a browser download). */
export function downloadAiLog(): boolean {
  if (entries.length === 0) return false;
  const blob = new Blob([JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries }, null, 1)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kc-ai-log-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}
