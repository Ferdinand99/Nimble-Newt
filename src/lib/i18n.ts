import en from "../locales/en.json";

type Dict = Record<string, string>;

/** Interface languages: code, name in its own language, right-to-left. English ships in the entry chunk; the rest load on demand. */
export const LOCALES = [
  { code: "en", name: "English", rtl: false },
  { code: "ar", name: "العربية", rtl: true },
  { code: "cs", name: "Čeština", rtl: false },
  { code: "da", name: "Dansk", rtl: false },
  { code: "de", name: "Deutsch", rtl: false },
  { code: "es", name: "Español", rtl: false },
  { code: "fa", name: "فارسی", rtl: true },
  { code: "fi", name: "Suomi", rtl: false },
  { code: "fr", name: "Français", rtl: false },
  { code: "he", name: "עברית", rtl: true },
  { code: "hu", name: "Magyar", rtl: false },
  { code: "it", name: "Italiano", rtl: false },
  { code: "ja", name: "日本語", rtl: false },
  { code: "ko", name: "한국어", rtl: false },
  { code: "nb", name: "Norsk bokmål", rtl: false },
  { code: "nl", name: "Nederlands", rtl: false },
  { code: "pl", name: "Polski", rtl: false },
  { code: "pt-BR", name: "Português (Brasil)", rtl: false },
  { code: "pt-PT", name: "Português (Portugal)", rtl: false },
  { code: "ro", name: "Română", rtl: false },
  { code: "ru", name: "Русский", rtl: false },
  { code: "sv", name: "Svenska", rtl: false },
  { code: "tr", name: "Türkçe", rtl: false },
  { code: "uk", name: "Українська", rtl: false },
  { code: "zh-CN", name: "简体中文", rtl: false },
  { code: "zh-TW", name: "繁體中文", rtl: false },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];
export type LocalePref = "auto" | LocaleCode;
export const LOCALE_CODES: string[] = LOCALES.map((l) => l.code);

const loaders = import.meta.glob<{ default: Dict }>(["../locales/*.json", "!../locales/en.json"]);
const tables: Record<string, Dict> = { en: en as Dict };
let current = "en";

/** Maps a system language tag such as "pt-PT", "zh-Hant-TW" or "no" to a shipped locale. */
export function matchLocale(tag: string): string {
  const l = tag.toLowerCase().replace(/_/g, "-");
  const exact = LOCALE_CODES.find((c) => c.toLowerCase() === l);
  if (exact) return exact;
  const base = l.split("-")[0];
  if (base === "no" || base === "nn") return "nb";
  if (base === "zh") return /hant|-tw|-hk|-mo/.test(l) ? "zh-TW" : "zh-CN";
  if (base === "pt") return "pt-BR";
  return LOCALE_CODES.find((c) => c.toLowerCase() === base) ?? "en";
}

/** Resolves a preference (or the system language) to one of the shipped locales. */
export function resolveLocale(pref: string, system = navigator.language): string {
  return matchLocale(pref === "auto" ? system : pref);
}

/** Loads a locale's strings (English fills any gap). */
export async function loadLocale(code: string): Promise<void> {
  if (tables[code]) return;
  const load = loaders[`../locales/${code}.json`];
  if (!load) return;
  tables[code] = { ...(en as Dict), ...(await load()).default };
}

export async function setLocale(pref: LocalePref): Promise<string> {
  const code = resolveLocale(pref);
  await loadLocale(code);
  current = tables[code] ? code : "en";
  const root = document.documentElement;
  root.lang = current;
  root.dir = LOCALES.find((l) => l.code === current)?.rtl ? "rtl" : "ltr";
  return current;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = tables[current][key] ?? tables.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
