import * as cm from "@codemirror/commands";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, type Command, type KeyBinding } from "@codemirror/view";
import { compactSteps, type MacroRunner, type MacroStep } from "../lib/macro";

/** Records what the user does in the editor so it can be replayed as a macro. */
class Recorder {
  recording = false;
  playing = false;
  private steps: MacroStep[] = [];
  private listeners = new Set<() => void>();

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }
  private notify(): void {
    for (const l of this.listeners) l();
  }
  start(): void {
    this.steps = [];
    this.recording = true;
    this.notify();
  }
  /** Ends recording and returns the steps (empty when nothing was recorded). */
  stop(): MacroStep[] {
    this.recording = false;
    const out = compactSteps(this.steps);
    this.steps = [];
    this.notify();
    return out;
  }
  cancel(): void {
    this.recording = false;
    this.steps = [];
    this.notify();
  }
  get count(): number {
    return this.steps.length;
  }
  push(step: MacroStep): void {
    if (this.recording && !this.playing) {
      this.steps.push(step);
      this.notify();
    }
  }
}

export const recorder = new Recorder();

// Editor commands by name, for recording (function -> name) and playback (name -> function).
const byName = new Map<string, Command>();
const nameOf = new Map<Command, string>();
for (const [name, fn] of Object.entries(cm)) {
  if (typeof fn === "function" && /^(cursor|select|delete|insert|indent|move|copy|split|transpose|toggle|simplify|add|undo|redo)/.test(name)) {
    byName.set(name, fn as Command);
    nameOf.set(fn as Command, name);
  }
}

/** Makes a custom editor command available to macros under `name`. */
export function registerMacroCommand(name: string, cmd: Command): Command {
  byName.set(name, cmd);
  nameOf.set(cmd, name);
  return cmd;
}

export function macroCommand(name: string): Command | undefined {
  return byName.get(name);
}

const wrapped = new WeakMap<Command, Command>();
function wrapCommand(fn: Command): Command {
  const name = nameOf.get(fn);
  if (!name) return fn;
  let w = wrapped.get(fn);
  if (!w) {
    w = (view) => {
      const ok = fn(view);
      if (ok) recorder.push({ t: "cm", c: name });
      return ok;
    };
    wrapped.set(fn, w);
  }
  return w;
}

/** Wraps the `run`/`shift` commands of a keymap so that they are recorded while a macro is being recorded. */
export function recordable(bindings: readonly KeyBinding[]): KeyBinding[] {
  return bindings.map((b) => ({ ...b, run: b.run && wrapCommand(b.run), shift: b.shift && wrapCommand(b.shift) }));
}

/** Records typed and pasted text. Runs before other input handlers so auto-closed brackets are seen too. */
export const recordingExtension: Extension = Prec.highest([
  EditorView.inputHandler.of((_view, _from, _to, text) => {
    if (recorder.recording && text) recorder.push({ t: "text", s: text });
    return false;
  }),
  EditorView.domEventHandlers({
    paste(event) {
      if (recorder.recording) {
        const text = event.clipboardData?.getData("text/plain");
        if (text) recorder.push({ t: "text", s: text });
      }
      return false;
    },
  }),
]);

export function viewRunner(view: EditorView, runApp: (id: string) => boolean): MacroRunner {
  return {
    exec(step) {
      if (step.t === "text") {
        view.dispatch({ ...view.state.replaceSelection(step.s), scrollIntoView: true, userEvent: "input.type" });
        return true;
      }
      if (step.t === "cm") {
        byName.get(step.c)?.(view);
        return true;
      }
      return runApp(step.c);
    },
    position: () => view.state.selection.main.head,
    atEnd: () => view.state.selection.main.head >= view.state.doc.length,
  };
}

export { EditorSelection };
