/** The long operations the backend runs on a large file; each has its own cancellation flag by id. */
export type LargeOpKind = "search" | "count";

/**
 * Hands out operation ids and remembers the newest operation of each kind, so starting a search
 * cancels only the previous search (never a count) and a late answer of a superseded one is ignored.
 */
export class LargeOps {
  private seq = 0;
  private current: Record<LargeOpKind, number | null> = { search: null, count: null };

  /** Starts an operation: its id, and the id of the older one of the same kind to cancel (if any). */
  start(kind: LargeOpKind): { op: number; stale: number | null } {
    const stale = this.current[kind];
    const op = ++this.seq;
    this.current[kind] = op;
    return { op, stale };
  }

  /** True while `op` is the newest of its kind. */
  isCurrent(kind: LargeOpKind, op: number): boolean {
    return this.current[kind] === op;
  }

  /** Marks `op` as finished. Returns whether it was the newest of its kind. */
  finish(kind: LargeOpKind, op: number): boolean {
    if (this.current[kind] !== op) return false;
    this.current[kind] = null;
    return true;
  }

  /** The id of the running operation of `kind`, to cancel it. */
  running(kind: LargeOpKind): number | null {
    return this.current[kind];
  }
}
