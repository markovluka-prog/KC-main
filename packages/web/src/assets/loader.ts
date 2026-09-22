interface AssetEntry {
  key: string;
  src: string;
  image: HTMLImageElement | null;
  loaded: boolean;
  failed: boolean;
}

export interface AssetStats {
  pending: number;
  resolved: number;
}

export class AssetStore {
  private readonly items = new Map<string, AssetEntry>();
  private pending = 0;
  private resolved = 0;
  private finishedFlag = false;
  private readonly callbacks: Array<() => void> = [];

  add(key: string, src: string): void {
    this.items.set(key, {
      key,
      src,
      image: null,
      loaded: false,
      failed: false,
    });
  }

  /**
   * Eager-loads every registered asset. PERF-001 (lazy loading) deliberately
   * deferred to Phase 7 of the master plan; current behaviour preserves the
   * legacy index.html semantics.
   */
  loadAll(): void {
    const keys = Array.from(this.items.keys());
    this.pending = keys.length;
    if (this.pending === 0) {
      this.finishedFlag = true;
      this.flushCallbacks();
      return;
    }
    for (const key of keys) {
      const item = this.items.get(key);
      if (!item) continue;
      const img = new Image();
      img.onload = () => {
        item.image = img;
        item.loaded = true;
        this.bump();
      };
      img.onerror = () => {
        item.failed = true;
        this.bump();
      };
      img.src = item.src;
    }
  }

  whenFinished(cb: () => void): void {
    if (this.finishedFlag) cb();
    else this.callbacks.push(cb);
  }

  get(key: string): HTMLImageElement | null {
    const item = this.items.get(key);
    if (!item || !item.loaded || !item.image) return null;
    return item.image;
  }

  isFinished(): boolean {
    return this.finishedFlag;
  }

  stats(): AssetStats {
    return { pending: this.pending, resolved: this.resolved };
  }

  private bump(): void {
    this.resolved += 1;
    if (this.resolved >= this.pending) {
      this.finishedFlag = true;
      this.flushCallbacks();
    }
  }

  private flushCallbacks(): void {
    while (this.callbacks.length) {
      const cb = this.callbacks.shift();
      cb?.();
    }
  }
}

/**
 * Where the Tiny Swords sprite pack lives in `packages/web/public/`.
 * The asset registration helper (populated in the KnightsAndCastlesGame
 * migration, T14) will concatenate this prefix with relative file paths.
 */
export const TINY_SWORDS_ROOT = '/tiny-swords/Tiny Swords (Free Pack)/';
