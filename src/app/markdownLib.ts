// The heavy part of the Markdown view, loaded on first use: markdown-it (in a worker), DOMPurify and the
// code highlighter. Rendered Markdown reaches the page only through `sanitizeMarkdown`.

import { applyRuns, highlightRuns, type Run } from "../editor/codeHighlight";
import { renderChunks, type Chunk } from "../lib/markdown";
import { sanitizeMarkdown } from "../lib/mdSanitize";

export { sanitizeMarkdown };
export type { Chunk };

// ---- parsing off the main thread -----------------------------------------------------------------------------

type Reply = { id: number; chunks?: Chunk[]; error?: string };
let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<number, { src: string; resolve: (c: Chunk[]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./markdownWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return (worker = null);
  }
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.chunks) w.resolve(e.data.chunks);
    else w.reject(new Error(e.data.error ?? "render failed"));
  };
  // A webview that cannot start the worker: render on the main thread from now on.
  worker.onerror = (e) => {
    e.preventDefault();
    worker?.terminate();
    worker = null;
    for (const [id, w] of waiting) {
      waiting.delete(id);
      try {
        w.resolve(renderChunks(w.src));
      } catch (err) {
        w.reject(err as Error);
      }
    }
  };
  return worker;
}

/** Parses and renders `src` into chunks of (unsanitised) HTML, in a worker when the webview allows it. */
export function renderChunksAsync(src: string): Promise<Chunk[]> {
  const w = getWorker();
  if (!w) return Promise.resolve().then(() => renderChunks(src));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { src, resolve, reject });
    w.postMessage({ id, src });
  });
}

// ---- code highlighting --------------------------------------------------------------------------------------

/** Highlighted code blocks by language and text, so typing elsewhere does not colour them again. */
const runsCache = new Map<string, Run[] | null>();
let cachedChars = 0;
const CACHE_CHARS = 2_000_000;
/** Code coloured per render at most; the rest stays plain. */
const RENDER_CHARS = 500_000;

function remember(key: string, runs: Run[] | null): void {
  runsCache.set(key, runs);
  cachedChars += key.length;
  for (const k of runsCache.keys()) {
    if (cachedChars <= CACHE_CHARS) break;
    runsCache.delete(k);
    cachedChars -= k.length;
  }
}

export const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Colours the code blocks under `roots` with the editor's grammars and theme, a few at a time so that
 * the window stays responsive. Stops when `alive()` turns false (a newer render).
 */
export async function highlightBlocks(roots: Element[], alive: () => boolean): Promise<void> {
  let budget = RENDER_CHARS;
  let sliceStart = performance.now();
  for (const root of roots) {
    for (const code of root.querySelectorAll<HTMLElement>("pre > code[data-lang]")) {
      if (!alive()) return;
      const text = code.textContent ?? "";
      budget -= text.length;
      if (budget < 0) return;
      const key = `${code.dataset.lang}\u0000${text}`;
      let runs = runsCache.get(key);
      if (runs === undefined) {
        runs = await highlightRuns(text, code.dataset.lang ?? "");
        remember(key, runs);
      }
      if (runs && alive() && code.isConnected) applyRuns(code, runs);
      if (performance.now() - sliceStart > 12) {
        await pause();
        sliceStart = performance.now();
      }
    }
  }
}
