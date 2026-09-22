const MUTE_STORAGE_KEY = 'kc_muted';

export class MusicPlayer {
  private readonly hall: HTMLAudioElement;
  private readonly battle: HTMLAudioElement;
  private active: HTMLAudioElement | null = null;
  private muted: boolean;

  constructor(hall: HTMLAudioElement, battle: HTMLAudioElement) {
    this.hall = hall;
    this.battle = battle;

    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(MUTE_STORAGE_KEY);
    } catch {
      // localStorage may throw in private-browsing modes; treat as unmuted.
    }
    this.muted = stored === '1';

    for (const a of [this.hall, this.battle]) {
      a.volume = 0.1;
      a.muted = this.muted;
    }

    const unlock = () => {
      if (this.active && this.active.paused && !this.muted) {
        this.active.play().catch(() => {
          // Autoplay still blocked — silently ignore.
        });
      }
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock);
    document.addEventListener('touchstart', unlock);
    document.addEventListener('keydown', unlock);
  }

  playHall(): void {
    this.switchTo(this.hall, this.battle);
  }

  playBattle(): void {
    this.switchTo(this.battle, this.hall);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    for (const a of [this.hall, this.battle]) a.muted = this.muted;
    if (!this.muted && this.active) {
      this.active.play().catch(() => {
        // ignore replay failures
      });
    }
    try {
      window.localStorage.setItem(MUTE_STORAGE_KEY, this.muted ? '1' : '0');
    } catch {
      // localStorage quota/private mode — best effort only.
    }
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  private switchTo(on: HTMLAudioElement, off: HTMLAudioElement): void {
    if (this.active === on) return;
    this.active = on;
    off.pause();
    off.currentTime = 0;
    if (!this.muted) {
      on.play().catch(() => {
        // First play before user gesture is blocked by browser policy;
        // the `unlock` listeners installed in the constructor handle it.
      });
    }
  }
}
