import { describe, expect, it } from "vitest";
import { compactSteps, parseMacros, playMacro, upsertMacro, type MacroRunner, type MacroStep } from "./macro";

/** A fake editor: a cursor moving over `lines` lines; "down" advances, "fail" fails. */
function fake(lines: number, log: string[] = []): MacroRunner & { pos: number; log: string[] } {
  const r = {
    pos: 0,
    log,
    exec(step: MacroStep) {
      log.push(step.t === "text" ? `text:${step.s}` : `${step.t}:${step.c}`);
      if (step.t === "cm" && step.c === "down") {
        if (r.pos >= lines - 1) return true; // at the last line the command is a no-op that succeeds
        r.pos++;
      }
      if (step.t === "cmd" && step.c === "fail") return false;
      return true;
    },
    position: () => r.pos,
    atEnd: () => r.pos >= lines - 1,
  };
  return r;
}

const down: MacroStep = { t: "cm", c: "down" };

describe("playMacro", () => {
  it("plays N times", async () => {
    const r = fake(100);
    const res = await playMacro({ steps: [{ t: "text", s: "x" }, down] }, r, { times: 5 });
    expect(res).toEqual({ passes: 5, stopped: "done" });
    expect(r.pos).toBe(5);
    expect(r.log.filter((l) => l === "text:x")).toHaveLength(5);
  });
  it("plays zero or negative times as nothing", async () => {
    const r = fake(10);
    expect((await playMacro({ steps: [down] }, r, { times: 0 })).passes).toBe(0);
    expect((await playMacro({ steps: [down] }, r, { times: -3 })).passes).toBe(0);
  });
  it("plays until the end of the file", async () => {
    const r = fake(50);
    const res = await playMacro({ steps: [down] }, r, { untilEnd: true });
    expect(res.stopped).toBe("end");
    expect(r.pos).toBe(49);
    expect(res.passes).toBe(49);
  });
  it("stops when a pass does not move forward (no infinite loop)", async () => {
    const r = fake(50);
    const res = await playMacro({ steps: [{ t: "text", s: "a" }] }, r, { untilEnd: true });
    expect(res).toEqual({ passes: 1, stopped: "no-progress" });
  });
  it("runs the last pass and then stops when the cursor cannot advance any more", async () => {
    // 3 lines: passes at lines 0, 1 and 2; on line 2 "down" cannot move, so that pass ends where it began.
    const r = fake(3);
    const res = await playMacro({ steps: [{ t: "text", s: "x" }, down] }, r, { untilEnd: true });
    expect(res.stopped).toBe("end");
    expect(r.log.filter((l) => l === "text:x")).toHaveLength(2);
  });
  it("stops at the first failing step", async () => {
    const r = fake(50);
    const res = await playMacro({ steps: [down, { t: "cmd", c: "fail" }, down] }, r, { times: 10 });
    expect(res).toEqual({ passes: 0, stopped: "failed" });
    expect(r.pos).toBe(1);
  });
  it("can be cancelled and yields to the UI", async () => {
    const r = fake(100000);
    let yielded = 0;
    let cancel = false;
    const res = await playMacro({ steps: [down] }, r, { untilEnd: true }, {
      yieldEvery: 100,
      yieldToUi: async () => {
        yielded++;
        if (yielded === 3) cancel = true;
      },
      shouldCancel: () => cancel,
    });
    expect(res.stopped).toBe("cancelled");
    expect(res.passes).toBe(300);
  });
  it("honours the pass limit", async () => {
    const r = fake(1_000_000);
    const res = await playMacro({ steps: [down] }, r, { untilEnd: true }, { maxPasses: 10 });
    expect(res).toEqual({ passes: 10, stopped: "limit" });
  });
});

describe("macro storage", () => {
  it("merges neighbouring text steps", () => {
    expect(compactSteps([{ t: "text", s: "he" }, { t: "text", s: "llo" }, down, { t: "text", s: "!" }])).toEqual([
      { t: "text", s: "hello" },
      down,
      { t: "text", s: "!" },
    ]);
  });
  it("drops malformed macros and steps", () => {
    const parsed = parseMacros({
      macros: [
        { name: "ok", steps: [{ t: "text", s: "a" }, { t: "bogus" }, { t: "cm", c: "down" }, 7] },
        { name: "", steps: [{ t: "text", s: "a" }] },
        { name: "empty", steps: [] },
        { steps: [] },
        null,
      ],
    });
    expect(parsed).toEqual([{ name: "ok", steps: [{ t: "text", s: "a" }, { t: "cm", c: "down" }] }]);
    expect(parseMacros(null)).toEqual([]);
    expect(parseMacros({ macros: "x" })).toEqual([]);
  });
  it("replaces a macro of the same name regardless of case", () => {
    const a = upsertMacro([], { name: "Fix", steps: [{ t: "text", s: "1" }] });
    const b = upsertMacro(a, { name: "fix", steps: [{ t: "text", s: "2" }] });
    expect(b).toEqual([{ name: "fix", steps: [{ t: "text", s: "2" }] }]);
  });
});

describe("playMacro with commands that can fail", () => {
  /** Find Next fails once the cursor is on the last line; every step may also be asynchronous. */
  function finder(lines: number): MacroRunner & { pos: number } {
    const r = {
      pos: 0,
      async exec(step: MacroStep) {
        await Promise.resolve();
        if (step.t === "cmd" && step.c === "findNext") {
          if (r.pos >= lines - 1) return false;
          r.pos++;
        }
        return true;
      },
      position: () => r.pos,
      atEnd: () => false,
    };
    return r;
  }
  const findNext: MacroStep = { t: "cmd", c: "findNext" };

  it("awaits asynchronous steps and stops N times when a step reports failure", async () => {
    const r = finder(3);
    expect(await playMacro({ steps: [findNext] }, r, { times: 10 })).toEqual({ passes: 2, stopped: "failed" });
    expect(r.pos).toBe(2);
  });
  it("ends play-to-the-end quietly when the failing step could not move forward", async () => {
    const r = finder(4);
    expect(await playMacro({ steps: [findNext] }, r, { untilEnd: true })).toEqual({ passes: 3, stopped: "no-progress" });
  });
  it("a step that fails after the cursor moved is still a failure", async () => {
    const r = finder(10);
    const steps: MacroStep[] = [findNext, { t: "cmd", c: "broken" }];
    const run = { ...r, exec: async (s: MacroStep) => (s.t === "cmd" && s.c === "broken" ? false : r.exec(s)), position: () => r.pos, atEnd: () => false };
    expect(await playMacro({ steps }, run, { untilEnd: true })).toEqual({ passes: 0, stopped: "failed" });
  });
});
