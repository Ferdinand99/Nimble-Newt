// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, type Permission } from "./protocol";

const stage = vi.hoisted(() => vi.fn<(html: string) => Promise<string>>());
const release = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>());
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (id: string, scheme: string) => `${scheme}://localhost/${id}` }));
vi.mock("../lib/api", () => ({ api: { sandboxStage: stage, sandboxRelease: release } }));

import { Sandbox } from "./sandbox";

/** Starts a sandbox against a fake document server and plays the part of the iframe. */
async function boot(granted: Permission[] = [], handle: (m: string, p: Record<string, unknown>) => Promise<unknown> = async () => null) {
  const onDead = vi.fn();
  const sb = new Sandbox("ext.test", "EXT_CODE();", granted, handle, onDead);
  const started = sb.start();
  const started_ = started.then(
    () => null,
    (e: Error) => e,
  );
  await vi.advanceTimersByTimeAsync(0);
  const frame = document.querySelector("iframe") as HTMLIFrameElement | null;
  const win = frame?.contentWindow ?? null;
  const posted = win ? vi.spyOn(win, "postMessage").mockImplementation(() => {}) : null;
  /** The iframe sends the app a message. */
  const fromFrame = async (data: unknown, source: unknown = win) => {
    window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { sb, onDead, started, started_, frame, posted, fromFrame };
}

describe("Sandbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stage.mockReset().mockResolvedValue("doc1");
    release.mockReset().mockResolvedValue();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("serves a sandboxed document that starts the extension in a worker, and is ready once the worker says so", async () => {
    const { sb, frame, fromFrame, started } = await boot();
    expect(stage).toHaveBeenCalledOnce();
    const html = stage.mock.calls[0][0];
    expect(html).toContain("worker-src blob:");
    expect(html).toContain("EXT_CODE();"); // inside NN_WORKER_SOURCE, after the worker bootstrap
    expect(html).toContain("nimble");
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame!.getAttribute("src")).toBe("nnext://localhost/doc1");
    expect(sb.running).toBe(true);
    await fromFrame({ event: "ready" });
    await expect(started).resolves.toBeUndefined();
  });

  it("only listens to its own iframe", async () => {
    const { started_, fromFrame, sb } = await boot();
    await fromFrame({ event: "ready" }, window);
    await fromFrame({ event: "worker-failed", message: "x" }, null);
    expect(sb.running).toBe(true);
    vi.advanceTimersByTime(LIMITS.startTimeoutMs);
    expect((await started_)?.message).toMatch(/did not start/);
  });

  it("fails the start, destroys the iframe and reports it when the worker cannot be created or parsed", async () => {
    const { sb, onDead, started_, fromFrame } = await boot();
    await fromFrame({ event: "worker-failed", message: "SyntaxError: bad" });
    expect((await started_)?.message).toBe("SyntaxError: bad");
    expect(sb.running).toBe(false);
    expect(document.querySelector("iframe")).toBeNull();
    expect(onDead).toHaveBeenCalledWith("start-failed");
    expect(release).toHaveBeenCalledWith("doc1");
  });

  it("gives up when the worker never reports ready", async () => {
    const { started_, onDead } = await boot();
    await vi.advanceTimersByTimeAsync(LIMITS.startTimeoutMs);
    expect((await started_)?.message).toMatch(/did not start/);
    expect(onDead).toHaveBeenCalledWith("start-timeout");
  });

  it("runs a command, and settles it with the reply", async () => {
    const { sb, posted, fromFrame } = await boot();
    await fromFrame({ event: "ready" });
    const done = sb.run("go", { locale: "en" });
    expect(posted).toHaveBeenCalledWith({ id: 1, method: "command.run", params: { command: "go", context: { locale: "en" } } }, "*");
    await fromFrame({ id: 1, result: null });
    await expect(done).resolves.toBeUndefined();
  });

  it("kills the extension when the iframe reports that it terminated the worker", async () => {
    const { sb, onDead, frame, posted, fromFrame } = await boot();
    await fromFrame({ event: "ready" });
    const done = sb.run("spin");
    const rejected = done.then(
      () => null,
      (e: Error) => e,
    );
    expect(posted).toHaveBeenCalled();
    await fromFrame({ event: "timeout", id: 1 });
    expect((await rejected)?.message).toMatch(/took too long/);
    expect(onDead).toHaveBeenCalledExactlyOnceWith("command-timeout");
    expect(sb.running).toBe(false);
    expect(frame!.isConnected).toBe(false);
    expect(release).toHaveBeenCalledWith("doc1");
  });

  it("ignores a timeout report for a command that is not running", async () => {
    const { sb, onDead, fromFrame } = await boot();
    await fromFrame({ event: "ready" });
    await fromFrame({ event: "timeout", id: 99 });
    await fromFrame({ event: "timeout" });
    expect(sb.running).toBe(true);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("keeps its own, longer clock as a backstop in case the iframe never reports", async () => {
    const { sb, onDead, fromFrame } = await boot();
    await fromFrame({ event: "ready" });
    const rejected = sb.run("spin").then(
      () => null,
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(LIMITS.commandTimeoutMs + LIMITS.commandBackstopMs - 1);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await rejected)?.message).toMatch(/took too long/);
    expect(onDead).toHaveBeenCalledWith("command-timeout");
    expect(LIMITS.commandBackstopMs).toBeGreaterThan(0);
  });

  it("holds the clock in the iframe and here, until released (once)", async () => {
    const { sb, onDead, posted, fromFrame } = await boot();
    await fromFrame({ event: "ready" });
    const done = sb.run("ask");
    const release_ = sb.hold();
    expect(posted).toHaveBeenLastCalledWith({ control: "hold" }, "*");
    await vi.advanceTimersByTimeAsync(10 * LIMITS.commandTimeoutMs);
    expect(onDead).not.toHaveBeenCalled();
    release_();
    release_();
    expect(posted!.mock.calls.filter((c) => (c[0] as { control?: string }).control === "release")).toHaveLength(1);
    await fromFrame({ id: 1, result: null });
    await expect(done).resolves.toBeUndefined();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("answers a call from the extension only if it passes the checks, and refuses one without the permission", async () => {
    const handle = vi.fn(async () => "the text");
    const { posted, fromFrame } = await boot(["editor.read"], handle);
    await fromFrame({ event: "ready" });
    await fromFrame({ id: 5, method: "editor.getText", params: {} });
    expect(handle).toHaveBeenCalledWith("editor.getText", {});
    expect(posted).toHaveBeenLastCalledWith({ id: 5, result: "the text" }, "*");
    await fromFrame({ id: 6, method: "editor.replaceAll", params: { text: "x" } });
    expect(posted).toHaveBeenLastCalledWith({ id: 6, error: expect.stringContaining("editor.write") }, "*");
    await fromFrame({ id: 7, method: "fs.read", params: {} });
    expect(posted).toHaveBeenLastCalledWith({ id: 7, error: expect.stringContaining("unknown method") }, "*");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("registers commands the extension announces", async () => {
    const { sb, fromFrame } = await boot();
    await fromFrame({ event: "ready" });
    expect(sb.hasCommand("go")).toBe(false);
    await fromFrame({ id: 1, method: "commands.register", params: { id: "go" } });
    expect(sb.hasCommand("go")).toBe(true);
  });
});
