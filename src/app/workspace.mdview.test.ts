// @vitest-environment jsdom
// Each tab remembers its Markdown view, and the session keeps it across a restart.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoredTab, SessionMeta } from "../lib/api";

const sessionSave = vi.fn(async (_meta: SessionMeta) => {});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: async () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ...real,
    api: {
      sessionSave: (meta: SessionMeta) => sessionSave(meta),
      bufferWrite: vi.fn(async () => {}),
      bufferDelete: vi.fn(async () => {}),
      openFile: vi.fn(async () => {
        throw new Error("no files in this test");
      }),
      fileMeta: vi.fn(async () => ({ size: 0, large: false })),
    },
  };
});

// jsdom has no layout; CodeMirror measures text ranges, so give it empty ones.
Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const { Workspace } = await import("./workspace");

const tab = (id: string, title: string, language: string, mdView: string | null | undefined): RestoredTab => ({
  id, path: null, title, encoding: "UTF-8", eol: "LF", language, dirty: true,
  selectionAnchor: 0, selectionHead: 0, scrollTop: 0, scrollLeft: 0, savedMtimeMs: null,
  bookmarks: [], mdView, buffer: `# ${title}`,
});

describe("Markdown view per tab", () => {
  let ws: InstanceType<typeof Workspace>;
  beforeEach(() => {
    sessionSave.mockClear();
    // The workspace looks its editor host up by id (the large-file viewer hides it).
    const host = document.createElement("div");
    host.id = "editor";
    document.body.replaceChildren(host);
    ws = new Workspace();
    ws.mount(host);
  });

  it("restores each tab's view from the session, unknown values as edit", async () => {
    await ws.restore([tab("a", "a.md", "markdown", "read"), tab("b", "b.md", "markdown", "bogus"), tab("c", "c.md", "markdown", undefined), tab("d", "d.md", "markdown", "split")], "a");
    expect(ws.docs.map((d) => d.mdView)).toEqual(["read", "edit", "edit", "split"]);
  });

  it("keeps the view of each tab while switching, and writes it to the session", async () => {
    await ws.restore([tab("a", "a.md", "markdown", null), tab("b", "b.md", "markdown", null), tab("t", "t.txt", "plaintext", null)], "a");
    const [a, b, t] = ws.docs;
    const seen: string[] = [];
    ws.on((k) => k === "view" && seen.push(ws.active!.id));
    ws.setMdView(a, "read");
    await ws.activate("b");
    ws.setMdView(b, "split");
    await ws.activate("t");
    await ws.activate("a");
    expect([a.mdView, b.mdView, t.mdView]).toEqual(["read", "split", "edit"]);
    // Only a change on the active tab re-lays out the window.
    expect(seen).toEqual(["a", "b"]);
    await ws.flush();
    const meta = sessionSave.mock.calls.at(-1)![0];
    expect(meta.tabs.map((x) => [x.id, x.mdView ?? null])).toEqual([["a", "read"], ["b", "split"], ["t", null]]);
  });

  it("does nothing when the view does not change", async () => {
    await ws.restore([tab("a", "a.md", "markdown", "read")], "a");
    const seen: string[] = [];
    ws.on((k) => seen.push(k));
    ws.setMdView(ws.docs[0], "read");
    expect(seen).toEqual([]);
  });
});
