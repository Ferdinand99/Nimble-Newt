// End-to-end check of the extension sandbox (NN-02, NN-05), in Chromium and WebKit: the engines behind WebView2
// (Windows) and WKWebView (macOS). Run with `npm run test:sandbox`; see e2e/README.md.
//
// It loads the real sandbox document (what the app stages) in a sandboxed iframe with an opaque origin, served with the
// real CSP header, and lets hostile extension code try to reach a sink on 127.0.0.1. The sink must see nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test as base, type Page } from "@playwright/test";
import { BUILTIN } from "../src/ext/builtin";
import { Extension, HEADER_CSP, startServers, startSink, type OpenOptions, type Servers, type Sink } from "./harness";

const payload = (name: string, sinkPort = 0) => readFileSync(fileURLToPath(new URL(`./payloads/${name}`, import.meta.url)), "utf8").replaceAll("__SINK_PORT__", String(sinkPort));

const test = base.extend<{ sink: Sink }, { servers: Servers }>({
  servers: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const s = await startServers();
      await use(s);
      await s.close();
    },
    { scope: "worker" },
  ],
  sink: async ({}, use) => { // eslint-disable-line no-empty-pattern
    const s = await startSink();
    await use(s);
    await s.close();
  },
});

interface Attempt {
  name: string;
  outcome: string;
  detail: string;
}

async function runAttack(page: Page, servers: Servers, sink: Sink, opts: Partial<OpenOptions> = {}): Promise<{ results: Attempt[]; ext: Extension }> {
  const ext = await Extension.open(page, servers, { code: payload("attack.js", sink.port), permissions: ["editor.read", "ui", "storage"], ...opts });
  await expect.poll(() => ext.editor.storage.has("attack"), { timeout: 90_000, message: "the attack never finished" }).toBe(true);
  // Give anything that is still in flight (a late connection, a beacon) time to show up at the sink.
  await page.waitForTimeout(700);
  const results = JSON.parse(ext.editor.storage.get("attack")!) as Attempt[];
  if (process.env.NN_E2E_VERBOSE) console.log(results.map((r) => `${r.outcome.padEnd(9)} ${r.name}: ${r.detail}`).join("\n"));
  return { results, ext };
}

const WEBRTC_AND_DOM = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate", "window", "document", "parent"];

test.describe("the sandbox keeps extension code from sending anything out", () => {
  test("the header the app serves is the policy the test relies on", () => {
    expect(HEADER_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; worker-src blob:");
  });

  test("every way out fails, and nothing reaches the sink", async ({ page, servers, sink }) => {
    const { results, ext } = await runAttack(page, servers, sink);
    const by = (name: string) => results.find((r) => r.name === name);

    // The vectors the review asked about. Each must have been tried, and none may have worked.
    for (const name of ["fetch", "fetch no-cors", "fetch keepalive", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "import()", "nested Worker (blob)"]) {
      const r = by(name);
      expect(r, `${name} was tried`).toBeDefined();
      expect(["blocked", "n/a"], `${name}: ${r?.detail}`).toContain(r?.outcome);
    }
    // import() is the one that cannot be removed from the worker, so the policy itself must refuse it.
    expect(by("import()")?.outcome).toBe("blocked");
    expect(results.filter((r) => r.outcome === "LEAK" || r.outcome === "DEFINED"), "no attempt worked").toEqual([]);

    // The network APIs are gone from the extension's point of view, and nothing is left on the prototype chains.
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker", "navigator.sendBeacon"]) {
      expect(by(`lockdown typeof ${name}`)?.outcome, name).toBe("undefined");
    }
    expect(by("lockdown prototype chain holds no original")?.outcome).toBe("undefined");

    // There is no WebRTC and no DOM in a worker.
    for (const name of WEBRTC_AND_DOM) expect(by(`typeof ${name}`)?.outcome, name).toBe("undefined");
    expect(by("new RTCPeerConnection()")?.outcome).toBe("blocked");

    // The strongest evidence: not one connection, request, upgrade or packet arrived.
    expect(sink.hits).toEqual([]);
    // And the app window heard nothing through a BroadcastChannel (the sandbox has an opaque origin).
    expect(await ext.broadcastReceived()).toEqual([]);
  });

  test("the policy alone holds: with the lockdown left out, every way out still fails and a worker made by the extension is confined", async ({ page, servers, sink }) => {
    const { results, ext } = await runAttack(page, servers, sink, { lockdown: false });
    const by = (name: string) => results.find((r) => r.name === name);

    // Here the APIs exist, so each must have been actively refused.
    for (const name of ["fetch", "fetch no-cors", "fetch keepalive", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "import()", "new Worker(http url)", "new Worker(data: url)"]) {
      expect(by(name)?.outcome, `${name}: ${by(name)?.detail}`).toBe("blocked");
    }
    // A worker the extension creates itself can exist, but it inherits the policy and has no WebRTC.
    expect(by("nested Worker (blob)")?.outcome, by("nested Worker (blob)")?.detail).toBe("confined");
    expect(by("nested Worker: typeof RTCPeerConnection")?.outcome).toBe("undefined");
    expect(["blocked", "n/a"]).toContain(by("WebTransport")?.outcome);
    // The lockdown did not run, which proves that the part above is the policy's doing.
    expect(by("lockdown typeof fetch")?.outcome).toBe("DEFINED");

    const leaks = results.filter((r) => !r.name.startsWith("lockdown") && (r.outcome === "LEAK" || r.outcome === "DEFINED"));
    expect(leaks, "no attempt worked").toEqual([]);
    for (const name of WEBRTC_AND_DOM) expect(by(`typeof ${name}`)?.outcome, name).toBe("undefined");
    expect(sink.hits).toEqual([]);
    expect(await ext.broadcastReceived()).toEqual([]);
  });

  test("control: the same attack gets out when the policy is loosened (and the lockdown left out), so the sink would have seen it", async ({ page, servers, sink }) => {
    const loose = "default-src * 'unsafe-inline'; script-src * 'unsafe-inline'; connect-src *; worker-src blob:";
    const { results } = await runAttack(page, servers, sink, { csp: loose, lockdown: false });
    expect(results.filter((r) => r.outcome === "LEAK").length, JSON.stringify(results)).toBeGreaterThan(2);
    expect(sink.hits.length).toBeGreaterThan(2);
  });

  // The document is governed by the header and by the meta tag together, so either one without "worker-src blob:"
  // stops the worker. This is why buildSrcdoc repeats the policy.
  for (const [what, opts] of [
    ["the header", { csp: "default-src 'none'; script-src 'unsafe-inline'" }],
    ["the meta tag", { metaCsp: "default-src 'none'; script-src 'unsafe-inline'" }],
  ] as const) {
    test(`a policy without worker-src blob: in ${what} stops the worker`, async ({ page, servers }) => {
      const ext = await Extension.open(page, servers, { code: "", permissions: [], ...opts });
      expect(await ext.waitFor({ event: "worker-failed" }, 10_000)).not.toBeNull();
    });
  }
});

test.describe("the extension for the manual check", () => {
  // examples/nn02-check is what the owner installs in the real app. Here it only proves that it still runs in the
  // worker and reports green; the sink checks above are what prove that nothing gets out.
  test("examples/nn02-check reports that everything is blocked", async ({ page, servers }) => {
    const code = readFileSync(fileURLToPath(new URL("../examples/nn02-check/main.js", import.meta.url)), "utf8");
    const ext = await Extension.open(page, servers, { code, permissions: ["ui"] });
    await ext.ready();
    await expect.poll(() => ext.registered.has("check"), { timeout: 10_000 }).toBe(true);
    expect(await ext.run("check", { locale: "en" }, 60_000)).toEqual({ ok: true });
    expect(ext.editor.messages).toHaveLength(1);
    expect(ext.editor.messages[0].kind, ext.editor.messages[0].text).toBe("success");
    expect(ext.editor.messages[0].text).toMatch(/^NN-02 check: all blocked\. Runs in a worker, no WebRTC/);
  });
});

test.describe("timeout (NN-05)", () => {
  test("terminate() stops a command that never returns, and the app is told", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, { code: payload("spin.js"), permissions: [], times: { commandTimeoutMs: 400 } });
    await ext.ready();
    const started = Date.now();
    const outcome = await ext.run("spin");
    const took = Date.now() - started;
    expect(outcome).toEqual({ timeout: true });
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(5000);
    // The loop is really dead: no more signs of life, however long we wait.
    const beats = await ext.count("error", "beat");
    expect(beats).toBeGreaterThan(5);
    await page.waitForTimeout(600);
    expect(await ext.count("error", "beat")).toBe(beats);
  });

  test("a command that finishes in time is not touched", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, { code: payload("spin.js"), permissions: [], times: { commandTimeoutMs: 1500 } });
    await ext.ready();
    expect(await ext.run("quick")).toEqual({ ok: true });
    expect(await ext.run("slow")).toEqual({ ok: true });
    await page.waitForTimeout(1800);
    expect((await ext.messages()).some((m) => m.event === "timeout")).toBe(false);
  });

  test("a slow command is stopped without a hold, and left alone while the app holds the clock (the heartbeat does not mind either)", async ({ page, servers }) => {
    const slow = await Extension.open(page, servers, { code: payload("spin.js"), permissions: [], times: { commandTimeoutMs: 400 } });
    await slow.ready();
    expect(await slow.run("slow")).toEqual({ timeout: true });

    // A fast heartbeat: a worker that waits for the app is idle, so it answers and is not taken for stuck.
    const held = await page.context().newPage();
    const ext = await Extension.open(held, servers, { code: payload("spin.js"), permissions: [], times: { commandTimeoutMs: 400, heartbeatMs: 100, unresponsiveMs: 500 } });
    await ext.ready();
    await ext.send({ control: "hold" });
    expect(await ext.run("slow")).toEqual({ ok: true });
    await held.waitForTimeout(1500);
    await ext.send({ control: "release" });
    await held.waitForTimeout(900);
    const events = (await ext.messages()).map((m) => m.event);
    expect(events).not.toContain("timeout");
    expect(events).not.toContain("unresponsive");
  });

  test("a script that does not parse is reported at once", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, { code: "this is not javascript (", permissions: [] });
    const failed = await ext.waitFor({ event: "worker-failed" }, 10_000);
    expect(failed).not.toBeNull();
    expect(String(failed?.message)).not.toBe("");
  });
});

test.describe("a hostile script cannot hide from the timeout (NN-05)", () => {
  // The extension shares the worker's global, so it can read the command's id, answer early and loop, or loop at the top
  // level. The command clock cannot see that; the heartbeat can.
  const quick = { heartbeatMs: 200, unresponsiveMs: 800 };

  /** The worker must be terminated and the app told, exactly once, and the loop must really be dead. */
  async function expectTerminated(ext: Extension, page: Page) {
    const told = await ext.waitFor({ event: "unresponsive" }, 15_000);
    expect(told, "the app was told").not.toBeNull();
    const beats = await ext.count("error", "beat");
    expect(beats, "it really was spinning").toBeGreaterThan(5);
    await page.waitForTimeout(700);
    expect(await ext.count("error", "beat"), "and it is dead").toBe(beats);
    expect(await ext.count("unresponsive")).toBe(1);
  }

  test("answers its command early, then loops for ever", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, { code: payload("evade.js"), permissions: [], times: quick });
    await ext.ready();
    await expect.poll(() => ext.registered.has("evade")).toBe(true);
    // The early answer clears the iframe's command clock: the command is "done" as far as the app can tell.
    expect(await ext.run("evade")).toEqual({ ok: true });
    await expectTerminated(ext, page);
  });

  test("loops at the top level after the bootstrap has reported ready", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, { code: payload("toplevel.js"), permissions: [], times: quick });
    await ext.ready();
    await expectTerminated(ext, page);
  });

  test("finishes a command normally and leaves a loop behind", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, { code: payload("evade.js"), permissions: [], times: quick });
    await ext.ready();
    await expect.poll(() => ext.registered.has("late")).toBe(true);
    expect(await ext.run("late")).toEqual({ ok: true });
    await expectTerminated(ext, page);
  });

  test("a step that blocks the worker for less than the limit is fine", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, { code: payload("evade.js"), permissions: [], times: { heartbeatMs: 200, unresponsiveMs: 3000 } });
    await ext.ready();
    await expect.poll(() => ext.registered.has("block")).toBe(true);
    expect(await ext.run("block")).toEqual({ ok: true }); // 1.2 s of nothing else
    await page.waitForTimeout(1500);
    expect(await ext.run("block")).toEqual({ ok: true });
    expect((await ext.messages()).some((m) => m.event === "unresponsive" || m.event === "timeout")).toBe(false);
  });
});

test.describe("forged messages from the extension", () => {
  test("do nothing: the iframe drops them, and the clocks still run", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, { code: payload("evade.js"), permissions: [], times: { commandTimeoutMs: 600 } });
    await ext.ready();
    await expect.poll(() => ext.registered.has("forge") && ext.registered.has("spin")).toBe(true);

    // { event: "timeout" } for an unknown id and for a running one, { event: "worker-failed" } after ready,
    // { event: "unresponsive" }, { control: "hold" } and { control: "release" } and a pong: all sent by the extension.
    expect(await ext.run("forge")).toEqual({ ok: true });
    const seen = (await ext.messages()).filter((m) => typeof m.event === "string");
    const events = new Set(seen.map((m) => m.event));
    for (const forged of ["timeout", "worker-failed", "unresponsive"]) expect(events.has(forged), `${forged} did not get through`).toBe(false);
    expect((await ext.messages()).some((m) => "control" in m), "no control message got through").toBe(false);
    // What may be passed on (an error text, a second ready) is harmless to the app.
    expect([...events].every((e) => e === "ready" || e === "error")).toBe(true);

    // A forged hold did not pause the command clock: a command that never returns is still stopped.
    const started = Date.now();
    expect(await ext.run("spin")).toEqual({ timeout: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

test.describe("the built-in extensions still work through the worker", () => {
  const builtin = (id: string) => BUILTIN.find((b) => b.manifest.id === id)!;
  const open = async (page: Page, servers: Servers, id: string, editor: Partial<Extension["editor"]>) => {
    const b = builtin(id);
    const ext = await Extension.open(page, servers, { code: b.code, permissions: b.manifest.permissions, editor });
    await ext.ready();
    // The scripts register their commands right after they start.
    await expect.poll(() => ext.registered.size, { timeout: 10_000 }).toBe(b.manifest.commands.length);
    return ext;
  };

  test("Word Count", async ({ page, servers }) => {
    const ext = await open(page, servers, "app.wordcount", { doc: "one two three four\n" });
    expect(await ext.run("count")).toEqual({ ok: true });
    expect(ext.editor.messages).toEqual([{ text: "4 words, 19 characters, 2 lines", kind: "info" }]);
    ext.editor.selection = "x y";
    expect(await ext.run("count", { locale: "nb" })).toEqual({ ok: true });
    expect(ext.editor.messages.at(-1)?.text).toBe("2 ord, 3 tegn, 1 linjer (markeringen)");
  });

  test("Markdown Helpers", async ({ page, servers }) => {
    const ext = await open(page, servers, "app.markdown", { selection: "hi" });
    for (const [command, expected] of [
      ["bold", "**hi**"],
      ["italic", "*hi*"],
      ["code", "`hi`"],
      ["link", "[hi](https://example.com)"],
    ] as const) {
      expect(await ext.run(command), command).toEqual({ ok: true });
      expect(ext.editor.edits.at(-1), command).toEqual({ method: "editor.replaceSelection", text: expected });
    }
    ext.editor.selection = "a\nb";
    expect(await ext.run("quote")).toEqual({ ok: true });
    expect(ext.editor.edits.at(-1)?.text).toBe("> a\n> b");
    ext.editor.selection = "**hi**";
    expect(await ext.run("bold")).toEqual({ ok: true });
    expect(ext.editor.edits.at(-1)?.text).toBe("hi");
  });

  test("Text Cleaner", async ({ page, servers }) => {
    const ext = await open(page, servers, "app.textcleaner", { selection: "Blåbær Syltetøy!" });
    expect(await ext.run("slugify")).toEqual({ ok: true });
    expect(ext.editor.edits.at(-1)).toEqual({ method: "editor.replaceSelection", text: "blabaer-syltetoy" });
    ext.editor.selection = "“hi” ‘x’ – …";
    expect(await ext.run("straighten")).toEqual({ ok: true });
    expect(ext.editor.edits.at(-1)?.text).toBe("\"hi\" 'x' - ...");
    ext.editor.selection = "";
    ext.editor.doc = "a   b  \nc\t\td ";
    expect(await ext.run("collapse")).toEqual({ ok: true });
    expect(ext.editor.edits.at(-1)).toEqual({ method: "editor.replaceAll", text: "a b\nc d" });
  });

  test("an extension without a permission is refused by the app, as before", async ({ page, servers }) => {
    const ext = await Extension.open(page, servers, {
      code: `nimble.commands.register("peek", async function () { await nimble.editor.getText(); });`,
      permissions: [],
      editor: { doc: "secret" },
    });
    await ext.ready();
    await expect.poll(() => ext.registered.has("peek")).toBe(true);
    const outcome = await ext.run("peek");
    expect(outcome).toMatchObject({ error: expect.stringContaining("editor.read") });
  });
});
