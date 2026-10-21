import en from "../locales/en.json";
import nb from "../locales/nb.json";

export type LocalePref = "auto" | "en" | "nb";
type Dict = Record<string, string>;

const tables: Record<string, Dict> = { en: en as Dict, nb: { ...(en as Dict), ...(nb as Dict) } };
let current = "en";

/** Resolves a preference (or the system language) to one of the shipped locales. */
export function resolveLocale(pref: LocalePref, system = navigator.language): string {
  const l = pref === "auto" ? system.toLowerCase() : pref;
  return /^(nb|no|nn)/.test(l) ? "nb" : "en";
}

export function setLocale(pref: LocalePref): string {
  current = resolveLocale(pref);
  document.documentElement.lang = current;
  return current;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = tables[current][key] ?? tables.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
