// End-to-end check of the Markdown view in Chromium and WebKit (the engines behind WebView2 and WKWebView).
//
// The real front end is built with Vite and served with the app's real content security policy (read from
// src-tauri/tauri.conf.json). The Tauri backend is stood in by a small `invoke` that serves three files and records
// every call, so the test sees exactly what the view asks the backend for. It covers the three views, the switch in
// the status bar, the shortcuts, the view each tab remembers, and the safety rules: no script runs, no remote image
// loads before "Show images", links never navigate the window.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base, type Page } from "@playwright/test";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const APP_CSP = (JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")) as { app: { security: { csp: string } } }).app.security.csp;

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const README = [
  "# Hello Newt",
  "",
  "Some *text* with a [web link](https://example.com/page), a [sibling](other.md) and a [bad one](javascript:alert(1)).",
  "",
  "<script>window.__pwned = 1</script>",
  "",
  '<img src="x.png" onerror="window.__pwned = 2" alt="handler">',
  "",
  '<a href="javascript:window.__pwned = 3">raw</a>',
  "",
  "![local ok](img/ok.png)",
  "",
  "![sneaky](../../secret.png)",
  "",
  "![remote cat](https://images.example.com/cat.png)",
  "",
  "- [x] done",
  "- [ ] todo",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```js",
  "const answer = 42;",
  "```",
  "",
  ...Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} to make the document long enough to scroll.\n`),
].join("\n");

/** About 1 MB of typical Markdown: headings, lists, links, code. */
const BIG_BLOCK = "## Section\n\nSome *text* with `code`, a [link](https://example.com) and **bold** words to fill the line.\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n";
const BIG = `# Big\n\n${BIG_BLOCK.repeat(Math.ceil(1_000_000 / BIG_BLOCK.length))}`;

const FILES: Record<string, string> = {
  "/work/docs/readme.md": README,
  "/work/docs/other.md": "# Other file\n\nJust text.\n",
  "/work/docs/notes.txt": "plain notes\n",
  "/work/docs/big.md": BIG,
};

/** Runs in the page before the app: a stand-in for Tauri's IPC. */
function tauriStub({ files, png }: { files: Record<string, string>; png: string }): void {
  type Call = { cmd: string; args: Record<string, unknown> };
  const w = window as unknown as Record<string, unknown> & { __nn: { calls: Call[] } };
  const calls: Call[] = [];
  w.__nn = { calls };
  let next = 1;
  const tab = (id: string, path: string) => ({
    id, path, title: path.split("/").pop(), encoding: "UTF-8", eol: "LF", language: null, dirty: false,
    selectionAnchor: 0, selectionHead: 0, scrollTop: 0, scrollLeft: 0, savedMtimeMs: 1, bookmarks: [], buffer: null,
  });
  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    session_load: () => ({ tabs: [tab("readme", "/work/docs/readme.md"), tab("other", "/work/docs/other.md"), tab("notes", "/work/docs/notes.txt"), tab("big", "/work/docs/big.md")], active: "readme" }),
    take_pending_paths: () => [],
    list_encodings: () => [{ label: "UTF-8", group: "Unicode" }],
    file_meta: (a) => ({ size: files[a.path as string]?.length ?? 0, large: false }),
    open_file: (a) => {
      const text = files[a.path as string];
      if (text === undefined) throw "not found";
      return { path: a.path, text, encoding: "UTF-8", eol: "LF", lossy: false, mtimeMs: 1, size: text.length };
    },
    file_mtimes: (a) => (a.paths as string[]).map(() => 1),
    ext_list: () => ({ extensions: [], problems: [] }),
    app_ready: () => false,
    md_local_image: (a) => {
      if (a.src === "img/ok.png" && a.docPath === "/work/docs/readme.md") return png;
      throw "only images in the document's folder are shown";
    },
    md_remote_image: () => png,
    "plugin:event|listen": () => next++,
  };
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    invoke: (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      const h = handlers[cmd];
      try {
        return Promise.resolve(h ? h(args) : null);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    transformCallback: (cb: unknown) => {
      const id = next++;
      w[`_${id}`] = cb;
      return id;
    },
    convertFileSrc: (p: string) => p,
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain" };

interface App {
  url: string;
}

const test = base.extend<{ app: App }, { built: { dir: string; server: Server; url: string } }>({
  built: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), "nn-md-e2e-"));
      await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "error", build: { outDir: dir, emptyOutDir: true } });
      const server = createServer((req, res) => {
        const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
        const file = join(dir, path === "/" || path === "\\" ? "index.html" : path);
        try {
          const body = readFileSync(file);
          res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Content-Security-Policy": APP_CSP, "Cache-Control": "no-store" }).end(body);
        } catch {
          res.writeHead(404, { "Content-Security-Policy": APP_CSP }).end();
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      await use({ dir, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
    { scope: "worker", timeout: 240_000 },
  ],
  app: async ({ page, built }, use) => {
    await page.addInitScript(tauriStub, { files: FILES, png: PNG });
    await page.goto(built.url);
    await expect(page.locator(".cm-content")).toContainText("Hello Newt", { timeout: 30_000 });
    await use({ url: built.url });
  },
});

// One browser build per worker; the tests of one browser share it.
test.describe.configure({ mode: "serial" });

const preview = (page: Page) => page.locator(".md-preview");
const body = (page: Page) => page.locator(".md-body");
const seg = (page: Page, name: string) => page.locator(".status-seg button", { hasText: name });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __nn: { calls: { cmd: string; args: Record<string, unknown> }[] } }).__nn.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);
const mod = async (page: Page) => ((await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent))) ? "Meta" : "Control");
const editorText = (page: Page) => page.locator(".cm-content").evaluate((e) => e.textContent ?? "");
const openTab = (page: Page, path: string) => page.locator(`.tab[title="${path}"]`).click();

test("the three views: Edit, Split and Read", async ({ page, app }) => {
  void app;
  await expect(page.locator(".status-seg")).toBeVisible();
  await expect(seg(page, "Edit")).toHaveAttribute("aria-pressed", "true");
  await expect(preview(page)).toBeHidden();

  await seg(page, "Split").click();
  await expect(preview(page)).toBeVisible();
  await expect(page.locator(".editor-col")).toHaveClass(/md-split/);
  await expect(page.locator("#editor")).toBeVisible();
  await expect(body(page).locator("h1")).toHaveText("Hello Newt");
  await expect(body(page).locator("table td")).toHaveText(["1", "2"]);
  await expect(body(page).locator("input[type=checkbox][disabled]")).toHaveCount(2);
  // Code is coloured with the editor's highlighter.
  await expect(body(page).locator("pre code span").first()).toBeVisible();

  // Live update while typing.
  await page.locator(".cm-content").click();
  const m = await mod(page);
  await page.keyboard.press(`${m}+Home`);
  await page.keyboard.type("## Live heading\n\n");
  await expect(body(page).locator("h2")).toHaveText("Live heading");

  // Scrolling the editor scrolls the view.
  await page.locator(".cm-scroller").evaluate((e) => (e.scrollTop = e.scrollHeight));
  await expect.poll(() => body(page).evaluate((e) => e.scrollTop)).toBeGreaterThan(100);

  await seg(page, "Read").click();
  await expect(page.locator(".editor-col")).toHaveClass(/md-read/);
  await expect(page.locator("#editor")).toHaveCSS("visibility", "hidden");
  await expect(preview(page)).toBeVisible();
  // Not editable: typing and editing commands change nothing.
  const before = await editorText(page);
  await page.keyboard.type("zzz");
  await page.keyboard.press(`${m}+Shift+K`);
  expect(await editorText(page)).toBe(before);

  await seg(page, "Edit").click();
  await expect(preview(page)).toBeHidden();
  await expect(page.locator("#editor")).toHaveCSS("visibility", "visible");
});

test("shortcuts: Ctrl+Shift+V toggles Read, Ctrl+K V toggles Split, only in Markdown tabs", async ({ page, app }) => {
  void app;
  const m = await mod(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${m}+Shift+V`);
  await expect(seg(page, "Read")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".editor-col")).toHaveClass(/md-read/);
  // The app ignores the same command twice within 80 ms (the native menu and the webview can both deliver a key).
  await page.waitForTimeout(150);
  await page.keyboard.press(`${m}+Shift+V`);
  await expect(seg(page, "Edit")).toHaveAttribute("aria-pressed", "true");
  await expect(preview(page)).toBeHidden();

  await page.locator(".cm-content").click();
  const before = await editorText(page);
  await page.keyboard.press(`${m}+K`);
  await page.keyboard.press("v");
  await expect(seg(page, "Split")).toHaveAttribute("aria-pressed", "true");
  await expect(preview(page)).toBeVisible();
  // The V of the chord did not reach the editor.
  expect(await editorText(page)).toBe(before);
  await page.locator(".cm-content").click();
  await page.waitForTimeout(150);
  await page.keyboard.press(`${m}+K`);
  await page.keyboard.press("v");
  await expect(seg(page, "Edit")).toHaveAttribute("aria-pressed", "true");

  // A plain text tab has no switch, and the keys go to the editor as usual.
  await openTab(page, "/work/docs/notes.txt");
  await expect(page.locator(".cm-content")).toContainText("plain notes");
  await expect(page.locator(".status-seg")).toBeHidden();
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${m}+Shift+V`);
  await expect(preview(page)).toBeHidden();
});

test("each tab remembers its own view, and the session stores it", async ({ page, app }) => {
  void app;
  await seg(page, "Read").click();
  await openTab(page, "/work/docs/other.md");
  await expect(page.locator(".cm-content")).toContainText("Other file");
  await expect(seg(page, "Edit")).toHaveAttribute("aria-pressed", "true");
  await expect(preview(page)).toBeHidden();
  await seg(page, "Split").click();
  await expect(body(page).locator("h1")).toHaveText("Other file");

  await openTab(page, "/work/docs/readme.md");
  await expect(seg(page, "Read")).toHaveAttribute("aria-pressed", "true");
  await expect(body(page).locator("h1")).toHaveText("Hello Newt");
  await openTab(page, "/work/docs/other.md");
  await expect(seg(page, "Split")).toHaveAttribute("aria-pressed", "true");

  await expect
    .poll(async () => {
      const saves = await calls(page, "session_save");
      const last = saves.at(-1)?.meta as { tabs: { id: string; mdView?: string | null }[] } | undefined;
      return last?.tabs.map((x) => [x.id, x.mdView ?? null]);
    })
    .toEqual([["readme", "read"], ["other", "split"], ["notes", null], ["big", null]]);
});

test("safe by default: no scripts, no remote images until allowed, links never navigate", async ({ page, app }) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(app.url) && !r.url().startsWith("data:")) outside.push(r.url());
  });
  await seg(page, "Split").click();
  const b = body(page);
  await expect(b.locator("h1")).toHaveText("Hello Newt");

  // Scripts and handlers did not run and are gone.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(b.locator("script")).toHaveCount(0);
  expect(await b.evaluate((e) => [...e.querySelectorAll("*")].some((x) => [...x.attributes].some((a) => a.name.startsWith("on"))))).toBe(false);
  await expect(b.locator("a", { hasText: "raw" })).not.toHaveAttribute("href", /.*/);

  // Local image: read through the backend, from the document's folder only.
  await expect(b.locator('img[alt="local ok"]')).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(b.locator('img[alt="sneaky"]')).not.toHaveAttribute("src", /.*/);
  await expect(b.locator('img[alt="sneaky"]')).toHaveClass(/md-img-placeholder/);
  expect((await calls(page, "md_local_image")).map((a) => a.src)).toEqual(expect.arrayContaining(["img/ok.png", "../../secret.png"]));

  // Remote image: held back until "Show images".
  const cat = b.locator('img[alt="remote cat"]');
  await expect(cat).not.toHaveAttribute("src", /.*/);
  await expect(page.locator(".md-bar")).toBeVisible();
  expect(await calls(page, "md_remote_image")).toEqual([]);
  await page.locator(".md-bar button").click();
  await expect(cat).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(await calls(page, "md_remote_image")).toEqual([{ url: "https://images.example.com/cat.png" }]);
  await expect(page.locator(".md-bar")).toBeHidden();

  // Links: the web link goes to the system browser, javascript: does nothing, a .md link opens a tab.
  await b.locator("a", { hasText: "web link" }).click();
  await expect.poll(() => calls(page, "open_external")).toEqual([{ url: "https://example.com/page" }]);
  await expect(b.locator("a", { hasText: "bad one" })).toHaveCount(0);
  await b.locator("a", { hasText: "raw" }).click();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(page.url()).toBe(app.url);
  await b.locator("a", { hasText: "sibling" }).click();
  await expect(page.locator('.tab[title="/work/docs/other.md"]')).toHaveAttribute("aria-selected", "true");
  expect(page.url()).toBe(app.url);

  expect(outside).toEqual([]);
});

test("a 1 MB document stays responsive in Split", async ({ page, app }) => {
  void app;
  await openTab(page, "/work/docs/big.md");
  await expect(page.locator(".cm-content")).toContainText("Big");
  await seg(page, "Split").click();
  await expect(body(page).locator("h1")).toHaveText("Big", { timeout: 30_000 });
  // Wait until the whole document is in (the first render fills the view in steps).
  const sections = BIG.split("## Section").length - 1;
  await expect.poll(() => body(page).locator("h2").count(), { timeout: 60_000 }).toBe(sections);

  // While typing, the page must keep answering: measure the longest gap between timer ticks.
  await page.evaluate(() => {
    const w = window as unknown as { __gap: number };
    let last = performance.now();
    w.__gap = 0;
    window.setInterval(() => {
      const now = performance.now();
      w.__gap = Math.max(w.__gap, now - last);
      last = now;
    }, 10);
  });
  await page.locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Typing into a big file", { delay: 30 });
  const typingGap = await page.evaluate(() => (window as unknown as { __gap: number }).__gap);
  await expect(page.locator(".cm-content")).toContainText("Typing into a big file");
  // The view catches up once typing stops.
  await expect(body(page).locator("p").first()).toContainText("Typing into a big file", { timeout: 30_000 });
  const total = await page.evaluate(() => (window as unknown as { __gap: number }).__gap);
  console.log(`1 MB split view: longest pause while typing ${Math.round(typingGap)} ms, including the render ${Math.round(total)} ms`);
  // No render runs while keys keep coming (the delay grows with the document), so typing never waits for it.
  expect(typingGap).toBeLessThan(1000);
});
