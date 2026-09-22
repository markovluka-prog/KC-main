/**
 * Storage adapter for the save layer. Lives in a separate file so the main
 * @kc/game-rules barrel stays free of `globalThis.localStorage` access —
 * server code (Phase 3+) imports only from `@kc/game-rules`, never from
 * `@kc/game-rules/storage`. (Phase 1.5 S1.)
 */
import { SAVE_KEY } from './constants.js';
import { validateSnapshot } from './save.js';
function getStorage() {
    if (typeof globalThis === 'undefined')
        return null;
    const g = globalThis;
    return g.localStorage ?? null;
}
export function readSavedState() {
    const storage = getStorage();
    if (!storage)
        return null;
    try {
        const raw = storage.getItem(SAVE_KEY);
        if (!raw)
            return null;
        return validateSnapshot(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
export function writeSnapshot(snapshot) {
    const storage = getStorage();
    if (!storage)
        return;
    try {
        storage.setItem(SAVE_KEY, JSON.stringify(snapshot));
    }
    catch {
        // Storage limits or private-mode quotas must not crash the game.
    }
}
export function clearSave() {
    const storage = getStorage();
    if (!storage)
        return;
    try {
        storage.removeItem(SAVE_KEY);
    }
    catch {
        // ignored
    }
}
//# sourceMappingURL=save-storage.js.map