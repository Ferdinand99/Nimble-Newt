// The heavy part of the Markdown view, loaded on first use: markdown-it (in a worker), DOMPurify and the
// code highlighter. Rendered Markdown reaches the page only through `sanitizeMarkdown`.

import { applyRuns, highlightRuns, type Run } from "../editor/codeHighlight";
import { renderChunks, type Chunk } from "../lib/markdown";
import { sanitizeMarkdown } from "../lib/mdSanitize";

export { sanitizeMarkdown };
export type { Chunk };

// ---- parsing off the main thread -----------------------------------------------------------------------------

type Reply = { id: number; chunks?: Chunk[]; error?: string };
type Job = { src: string; resolve: (c: Chunk[]) => void; reject: (e: Error) => void };

/** A parse that runs longer than this is stopped: the worker is ended and made again for the next one. */
export const WATCHDOG_MS = 5000;

/** `undefined`: not started yet; `null`: the webview cannot run it, parse on the main thread. */
let worker: Worker | null | undefined;
let nextId = 0;
/** The parse the worker is busy with, and the newest one waiting; older waiting ones are dropped. */
let busy: (Job & { id: number; timer: number }) | null = null;
let queued: Job | null = null;

/** Thrown for a request that a newer one replaced before it started. */
export class Superseded extends Error {}

function onReply(e: MessageEvent<Reply>): void {
  if (!busy || e.data.id !== busy.id) return;
  const job = busy;
  busy = null;
  clearTimeout(job.timer);
  if (e.data.chunks) job.resolve(e.data.chunks);
  else job.reject(new Error(e.data.error ?? "render failed"));
  pump();
}

function onWatchdog(): void {
  if (!busy) return;
  const job = busy;
  busy = null;
  worker?.terminate();
  worker = undefined;
  job.reject(new Error("the document took too long to render"));
  pump();
}

/** A webview that cannot start the worker: render on the main thread from now on. */
function onFailure(e: Event): void {
  e.preventDefault();
  worker?.terminate();
  worker = null;
  if (busy) clearTimeout(busy.timer);
  for (const job of [busy, queued]) {
    if (!job) continue;
    try {
      job.resolve(renderChunks(job.src));
    } catch (err) {
      job.reject(err as Error);
    }
  }
  busy = null;
  queued = null;
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./markdownWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return (worker = null);
  }
  worker.onmessage = onReply;
  worker.onerror = onFailure;
  return worker;
}

function pump(): void {
  if (busy || !queued) return;
  const w = getWorker();
  const job = queued;
  queued = null;
  if (!w) {
    try {
      job.resolve(renderChunks(job.src));
    } catch (err) {
      job.reject(err as Error);
    }
    return;
  }
  const id = ++nextId;
  busy = { ...job, id, timer: window.setTimeout(onWatchdog, WATCHDOG_MS) };
  w.postMessage({ id, src: job.src });
}

/**
 * Parses and renders `src` into chunks of (unsanitised) HTML, in a worker when the webview allows it.
 * Only the newest request waits while the worker is busy; an older waiting one fails with `Superseded`.
 */
export function renderChunksAsync(src: string): Promise<Chunk[]> {
  return new Promise((resolve, reject) => {
    queued?.reject(new Superseded("a newer render replaced this one"));
    queued = { src, resolve, reject };
    pump();
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
