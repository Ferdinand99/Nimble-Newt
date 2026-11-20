// Parses and renders Markdown off the main thread, so that typing in a large document never waits for
// markdown-it. The result is unsanitised HTML: the view sanitises it (DOMPurify needs the DOM).

import { renderChunks } from "../lib/markdown";

const scope = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; src: string }>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = (e) => {
  const { id, src } = e.data;
  try {
    scope.postMessage({ id, chunks: renderChunks(src) });
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
