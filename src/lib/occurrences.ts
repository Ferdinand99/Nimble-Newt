const WORD = /[\p{L}\p{N}_]/u;

/** Start offsets of every non-overlapping occurrence of `needle` in `hay`. */
export function findOccurrences(hay: string, needle: string, opts: { matchCase: boolean; wholeWord: boolean }, limit = 5000): number[] {
  if (!needle) return [];
  const h = opts.matchCase ? hay : hay.toLowerCase();
  const n = opts.matchCase ? needle : needle.toLowerCase();
  // Lower-casing can change the length for a few scripts; fall back to exact matching then.
  if (h.length !== hay.length) return findOccurrences(hay, needle, { ...opts, matchCase: true }, limit);
  const out: number[] = [];
  let i = h.indexOf(n);
  while (i >= 0 && out.length < limit) {
    const before = i > 0 ? hay[i - 1] : "";
    const after = i + n.length < hay.length ? hay[i + n.length] : "";
    if (!opts.wholeWord || (!(before && WORD.test(before)) && !(after && WORD.test(after)))) out.push(i);
    i = h.indexOf(n, i + n.length);
  }
  return out;
}

export function isWordLike(s: string): boolean {
  return s.length > 0 && [...s].every((c) => WORD.test(c));
}
