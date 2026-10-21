import { api, type Encoding, type Eol } from "./api";
import { type LocalePref } from "./i18n";
import { clamp } from "./logic";

export interface Settings {
  theme: "system" | "light" | "dark";
  locale: LocalePref;
  fontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  showWhitespace: boolean;
  wordCompletion: boolean;
  defaultEncoding: Encoding;
  defaultEol: Eol;
  restoreSession: boolean;
  autoUpdate: boolean;
}

export const DEFAULTS: Settings = {
  theme: "system",
  locale: "auto",
  fontSize: 14,
  tabSize: 4,
  insertSpaces: true,
  wordWrap: false,
  showWhitespace: false,
  wordCompletion: true,
  defaultEncoding: "UTF-8",
  defaultEol: /Windows/.test(navigator.userAgent) ? "CRLF" : "LF",
  restoreSession: true,
  autoUpdate: true,
};

export const FONT_MIN = 8;
export const FONT_MAX = 40;

/** Accepts whatever was stored (older versions, hand edits) and returns a valid Settings. */
export function normalize(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : d);
  return {
    theme: pick(r.theme, ["system", "light", "dark"], DEFAULTS.theme),
    locale: pick(r.locale, ["auto", "en", "nb"], DEFAULTS.locale),
    fontSize: num(r.fontSize, DEFAULTS.fontSize, FONT_MIN, FONT_MAX),
    tabSize: num(r.tabSize, DEFAULTS.tabSize, 1, 16),
    insertSpaces: bool(r.insertSpaces, DEFAULTS.insertSpaces),
    wordWrap: bool(r.wordWrap, DEFAULTS.wordWrap),
    showWhitespace: bool(r.showWhitespace, DEFAULTS.showWhitespace),
    wordCompletion: bool(r.wordCompletion, DEFAULTS.wordCompletion),
    defaultEncoding: typeof r.defaultEncoding === "string" && /^[A-Za-z0-9_. :-]{2,32}$/.test(r.defaultEncoding) ? r.defaultEncoding : DEFAULTS.defaultEncoding,
    defaultEol: pick(r.defaultEol, ["LF", "CRLF", "CR"], DEFAULTS.defaultEol),
    restoreSession: bool(r.restoreSession, DEFAULTS.restoreSession),
    autoUpdate: bool(r.autoUpdate, DEFAULTS.autoUpdate),
  };
}

type Listener = (s: Settings, changed: (keyof Settings)[]) => void;

class Store {
  value: Settings = { ...DEFAULTS };
  private listeners = new Set<Listener>();

  async load(): Promise<void> {
    try {
      const raw = await api.docRead("settings");
      this.value = normalize(raw ? JSON.parse(raw) : null);
    } catch {
      this.value = { ...DEFAULTS };
    }
  }

  onChange(fn: Listener): void {
    this.listeners.add(fn);
  }

  set(patch: Partial<Settings>): void {
    const next = normalize({ ...this.value, ...patch });
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => next[k] !== this.value[k]);
    if (!changed.length) return;
    this.value = next;
    void api.docWrite("settings", JSON.stringify(next)).catch(() => {});
    for (const l of this.listeners) l(next, changed);
  }
}

export const settings = new Store();

export function applyTheme(theme: Settings["theme"]): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}
