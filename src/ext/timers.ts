/**
 * Timeouts that stop counting while the user is busy in a dialog the extension opened.
 * `hold()` pauses every timer in the group (including ones added meanwhile); the returned function resumes them.
 */
export class TimerGroup {
  private timers = new Set<Entry>();
  private holds = 0;

  /** Calls `fn` after `ms` of un-held time. Returns a function that cancels it. */
  add(ms: number, fn: () => void): () => void {
    const e: Entry = { left: ms, fn, handle: null, armedAt: 0 };
    this.timers.add(e);
    if (this.holds === 0) this.arm(e);
    return () => {
      if (e.handle !== null) clearTimeout(e.handle);
      this.timers.delete(e);
    };
  }

  hold(): () => void {
    if (this.holds++ === 0) {
      const now = Date.now();
      for (const e of this.timers) {
        if (e.handle !== null) clearTimeout(e.handle);
        e.handle = null;
        e.left = Math.max(0, e.left - (now - e.armedAt));
      }
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.holds === 0) for (const e of this.timers) this.arm(e);
    };
  }

  clear(): void {
    for (const e of this.timers) if (e.handle !== null) clearTimeout(e.handle);
    this.timers.clear();
  }

  private arm(e: Entry): void {
    e.armedAt = Date.now();
    e.handle = setTimeout(() => {
      this.timers.delete(e);
      e.fn();
    }, e.left);
  }
}

interface Entry {
  left: number;
  fn: () => void;
  handle: ReturnType<typeof setTimeout> | null;
  armedAt: number;
}
