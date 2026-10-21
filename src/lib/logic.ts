// Pure helpers: no DOM, no Tauri. Everything here is unit-tested.

export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  const out = items.slice();
  if (from < 0 || from >= out.length) return out;
  const clamped = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(clamped, 0, item);
  return out;
}

/** Index a dragged item should land at, given the horizontal midpoints of the other items. */
export function dropIndex(midpoints: readonly number[], x: number): number {
  let i = 0;
  while (i < midpoints.length && x > midpoints[i]) i++;
  return i;
}

export type Indent = { useTabs: boolean; size: number };

/** Guesses indentation from file contents; `null` when there is not enough evidence. */
export function detectIndent(text: string, sample = 2000): Indent | null {
  let tabs = 0;
  let spaces = 0;
  const diffs = new Map<number, number>();
  let prev = 0;
  let seen = 0;
  for (const line of text.split("\n", sample)) {
    if (!line.trim()) continue;
    seen++;
    if (line.startsWith("\t")) {
      tabs++;
      continue;
    }
    const m = /^ +/.exec(line);
    const width = m ? m[0].length : 0;
    if (width > 0) {
      spaces++;
      const d = Math.abs(width - prev);
      if (d >= 2 && d <= 8) diffs.set(d, (diffs.get(d) ?? 0) + 1);
    }
    prev = width;
  }
  if (seen === 0 || tabs + spaces < 2) return null;
  if (tabs > spaces) return { useTabs: true, size: 4 };
  let best = 0;
  let bestN = 0;
  for (const [d, n] of diffs) {
    if (n > bestN || (n === bestN && d < best)) {
      best = d;
      bestN = n;
    }
  }
  return best ? { useTabs: false, size: best } : null;
}

export function nextUntitledName(existing: readonly string[], base: string): string {
  const used = new Set(existing);
  for (let n = 1; ; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name)) return name;
  }
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/** Subsequence fuzzy match. Higher is better, `null` means no match. `positions` index into `text`. */
export function fuzzyScore(query: string, text: string): { score: number; positions: number[] } | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let ti = 0;
  let score = 0;
  let last = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    positions.push(found);
    score += 1;
    if (found === last + 1) score += 3;
    if (found === 0 || /[\s/\\._-]/.test(t[found - 1])) score += 4;
    last = found;
    ti = found + 1;
  }
  score -= Math.min(5, Math.floor(text.length / 20));
  return { score, positions };
}

export function fuzzyFilter<T>(items: readonly T[], query: string, label: (t: T) => string): { item: T; positions: number[] }[] {
  const scored: { item: T; positions: number[]; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const r = fuzzyScore(query, label(item));
    if (r) scored.push({ item, positions: r.positions, score: r.score, i });
  });
  if (query) scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored;
}

/** "CmdOrCtrl+Shift+P" -> "⌘⇧P" on macOS, "Ctrl+Shift+P" elsewhere. */
export function formatShortcut(accel: string, mac: boolean): string {
  const parts = accel.split("+");
  const key = parts.pop() ?? "";
  const out = parts.map((p) => {
    const l = p.toLowerCase();
    if (l === "cmdorctrl") return mac ? "⌘" : "Ctrl";
    if (l === "ctrl") return mac ? "⌃" : "Ctrl";
    if (l === "alt") return mac ? "⌥" : "Alt";
    if (l === "shift") return mac ? "⇧" : "Shift";
    return p;
  });
  const k = key.length === 1 ? key.toUpperCase() : key;
  return mac ? out.join("") + k : [...out, k].join("+");
}

export type LineCol = { line: number; col: number };
export type ColumnRange = { line: number; from: number; to: number };

/**
 * Rectangular selection between two line/column corners. Columns are clamped to each line's
 * length, so short lines still get a cursor.
 */
export function columnSelectRanges(lineCount: number, lineLength: (line: number) => number, anchor: LineCol, head: LineCol): ColumnRange[] {
  const l0 = Math.max(0, Math.min(anchor.line, head.line));
  const l1 = Math.min(lineCount - 1, Math.max(anchor.line, head.line));
  const out: ColumnRange[] = [];
  for (let l = l0; l <= l1; l++) {
    const len = lineLength(l);
    out.push({ line: l, from: Math.min(anchor.col, len), to: Math.min(head.col, len) });
  }
  return out;
}

/** Most-recently-used list: newest first, no duplicates, bounded. */
export function pushRecent(list: readonly string[], path: string, max = 30): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
