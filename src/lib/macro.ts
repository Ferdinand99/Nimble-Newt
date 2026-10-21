// Macro model and playback engine. Free of DOM/CodeMirror so it can be tested with a fake runner.

/** One recorded action: typed/pasted text, an editor command (by name) or an app command (by id). */
export type MacroStep = { t: "text"; s: string } | { t: "cm"; c: string } | { t: "cmd"; c: string };

export interface Macro {
  name: string;
  steps: MacroStep[];
}

/** What the engine needs from the editor. */
export interface MacroRunner {
  /** Runs one step and resolves to whether it worked; `false` (e.g. Find Next found nothing) ends playback. */
  exec(step: MacroStep): boolean | Promise<boolean>;
  /** Cursor offset. "Play to end" keeps going only while a pass moves the cursor forward. */
  position(): number;
  /** True when the cursor is at the end of the document. */
  atEnd(): boolean;
}

export type PlayResult = {
  passes: number;
  stopped: "done" | "failed" | "end" | "no-progress" | "cancelled" | "limit";
};

export interface PlayOptions {
  maxPasses?: number;
  /** Called every `yieldEvery` passes so a long run does not freeze the window. */
  yieldToUi?: () => Promise<void>;
  yieldEvery?: number;
  shouldCancel?: () => boolean;
}

/** Merges neighbouring text steps, so typing "hello" replays as one insertion. */
export function compactSteps(steps: readonly MacroStep[]): MacroStep[] {
  const out: MacroStep[] = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (s.t === "text" && last?.t === "text") out[out.length - 1] = { t: "text", s: last.s + s.s };
    else out.push({ ...s });
  }
  return out;
}

export async function playMacro(
  macro: Pick<Macro, "steps">,
  runner: MacroRunner,
  mode: { times: number } | { untilEnd: true },
  opts: PlayOptions = {},
): Promise<PlayResult> {
  const max = opts.maxPasses ?? 1_000_000;
  const every = opts.yieldEvery ?? 200;
  const untilEnd = "untilEnd" in mode;
  const total = untilEnd ? max : Math.max(0, Math.floor(mode.times));
  let passes = 0;
  while (passes < total) {
    if (opts.shouldCancel?.()) return { passes, stopped: "cancelled" };
    if (untilEnd && runner.atEnd()) return { passes, stopped: "end" };
    const before = runner.position();
    for (const step of macro.steps) {
      if (!(await runner.exec(step))) {
        // A step that fails on the last line (Down, Find Next with no match left) is how "to the end" finishes.
        return { passes, stopped: untilEnd && runner.position() <= before ? "no-progress" : "failed" };
      }
    }
    passes++;
    // Like Notepad++, the pass that no longer moves forward (the last line) still ran, then playback stops.
    if (untilEnd && runner.position() <= before) return { passes, stopped: "no-progress" };
    if (opts.yieldToUi && passes % every === 0) await opts.yieldToUi();
  }
  return { passes, stopped: untilEnd ? "limit" : "done" };
}

const NAME_MAX = 60;

/** Validates stored macros (hand-edited or from an older version) and drops anything malformed. */
export function parseMacros(raw: unknown): Macro[] {
  const list = (raw && typeof raw === "object" && Array.isArray((raw as { macros?: unknown }).macros) ? (raw as { macros: unknown[] }).macros : []) as unknown[];
  const out: Macro[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const { name, steps } = m as { name?: unknown; steps?: unknown };
    if (typeof name !== "string" || !name.trim() || !Array.isArray(steps)) continue;
    const clean: MacroStep[] = [];
    for (const s of steps) {
      if (!s || typeof s !== "object") continue;
      const { t, c, s: text } = s as { t?: unknown; c?: unknown; s?: unknown };
      if (t === "text" && typeof text === "string") clean.push({ t, s: text });
      else if ((t === "cm" || t === "cmd") && typeof c === "string" && c.length < 80) clean.push({ t, c });
    }
    if (clean.length) out.push({ name: name.trim().slice(0, NAME_MAX), steps: compactSteps(clean) });
  }
  return out;
}

/** Adds or replaces a macro by name (case-insensitive). */
export function upsertMacro(list: readonly Macro[], macro: Macro): Macro[] {
  const key = macro.name.trim().toLowerCase();
  return [...list.filter((m) => m.name.toLowerCase() !== key), { name: macro.name.trim().slice(0, NAME_MAX), steps: compactSteps(macro.steps) }];
}
