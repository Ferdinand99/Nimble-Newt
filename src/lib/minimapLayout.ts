// Geometry for the document map (minimap). Pure so it can be tested.

export interface Layout {
  /** Pixels per drawn line. */
  rowHeight: number;
  /** Every `step`-th line is drawn (1 = all). */
  step: number;
  /** Number of rows actually drawn. */
  rows: number;
  /** Pixels the drawn lines occupy in total. */
  contentHeight: number;
}

/** Fits `lineCount` lines into `height` pixels: 2 px per line when they fit, otherwise fewer lines are sampled. */
export function layout(lineCount: number, height: number, maxRow = 2): Layout {
  if (lineCount <= 0 || height <= 0) return { rowHeight: maxRow, step: 1, rows: 0, contentHeight: 0 };
  if (lineCount * maxRow <= height) return { rowHeight: maxRow, step: 1, rows: lineCount, contentHeight: lineCount * maxRow };
  const rows = Math.max(1, Math.floor(height / 1));
  const step = Math.ceil(lineCount / rows);
  const drawn = Math.ceil(lineCount / step);
  return { rowHeight: 1, step, rows: drawn, contentHeight: drawn };
}

/** Runs of non-blank characters in a line as [startColumn, endColumn) pairs, with long lines capped at `maxCols`. */
export function lineRuns(text: string, maxCols = 90): [number, number][] {
  const runs: [number, number][] = [];
  const end = Math.min(text.length, maxCols);
  let i = 0;
  while (i < end) {
    while (i < end && (text[i] === " " || text[i] === "\t")) i += text[i] === "\t" ? 1 : 1;
    if (i >= end) break;
    const start = i;
    while (i < end && text[i] !== " " && text[i] !== "\t") i++;
    runs.push([start, i]);
  }
  return runs;
}

/** Viewport rectangle in minimap pixels, for the scroll position of the editor. */
export function viewportRect(scrollTop: number, clientHeight: number, scrollHeight: number, lay: Layout): { top: number; height: number } {
  if (scrollHeight <= 0) return { top: 0, height: lay.contentHeight };
  const k = lay.contentHeight / scrollHeight;
  return { top: scrollTop * k, height: Math.max(6, clientHeight * k) };
}

/** The editor scrollTop that puts the minimap position `y` (pixels) in the middle of the viewport. */
export function scrollTopForY(y: number, clientHeight: number, scrollHeight: number, lay: Layout): number {
  if (lay.contentHeight <= 0) return 0;
  const target = (y / lay.contentHeight) * scrollHeight - clientHeight / 2;
  return Math.max(0, Math.min(scrollHeight - clientHeight, target));
}
