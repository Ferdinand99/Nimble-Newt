// Persistence and validation of user-defined languages. Validation happens in Rust (nimble-core);
// the list lives in the app-data doc store under the name "userlangs".

import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { registerUserLanguages, unregisterUserLanguage } from "./languages";
import { normalizeDefinition, toLanguageDef, USER_PREFIX, type UserLanguageDefinition } from "./userLanguage";

export type DefinitionFormat = "json" | "toml";

const DOC = "userlangs";
let cache: UserLanguageDefinition[] | null = null;

export const formatFromPath = (path: string): DefinitionFormat => (path.toLowerCase().endsWith(".toml") ? "toml" : "json");

/** Validates text with the Rust parser and returns the normalised definition. Rejects with a readable message. */
export async function parseDefinition(text: string, format: DefinitionFormat): Promise<UserLanguageDefinition> {
  const json = await invoke<string>("parse_language_definition", { text, format });
  return normalizeDefinition(JSON.parse(json));
}

export const serializeDefinition = (def: UserLanguageDefinition, format: DefinitionFormat): Promise<string> =>
  invoke<string>("serialize_language_definition", { json: JSON.stringify(def), format });

export const languageTemplate = (): Promise<string> => invoke<string>("language_template");

/** The starter template in the requested format. */
export async function templateAs(format: DefinitionFormat): Promise<string> {
  const toml = await languageTemplate();
  if (format === "toml") return toml;
  return serializeDefinition(await parseDefinition(toml, "toml"), "json");
}

async function persist(list: UserLanguageDefinition[]): Promise<void> {
  cache = list;
  await api.docWrite(DOC, JSON.stringify({ version: 1, languages: list }));
}

/** Reads the stored list, dropping entries the validator rejects. Does not register anything. */
export async function loadDefinitions(): Promise<UserLanguageDefinition[]> {
  if (cache) return cache;
  const out: UserLanguageDefinition[] = [];
  try {
    const raw = await api.docRead(DOC);
    const parsed = raw ? (JSON.parse(raw) as { languages?: unknown }) : null;
    const entries = Array.isArray(parsed?.languages) ? parsed.languages : [];
    for (const e of entries) {
      try {
        const def = await parseDefinition(JSON.stringify(e), "json");
        if (!out.some((d) => d.id === def.id)) out.push(def);
      } catch {
        /* broken entry: ignore */
      }
    }
  } catch {
    /* unreadable store: start empty */
  }
  cache = out;
  return out;
}

/** Loads the stored languages and registers them with the language registry. Call once at startup. */
export async function loadUserLanguages(): Promise<UserLanguageDefinition[]> {
  const defs = await loadDefinitions();
  registerUserLanguages(defs.map(toLanguageDef));
  return defs;
}

/** Validates, stores (replacing an entry with the same id) and registers a definition. */
export async function importDefinition(text: string, format: DefinitionFormat): Promise<UserLanguageDefinition> {
  const def = await parseDefinition(text, format);
  const list = (await loadDefinitions()).filter((d) => d.id !== def.id);
  list.push(def);
  await persist(list);
  registerUserLanguages([toLanguageDef(def)]);
  return def;
}

export async function removeDefinition(id: string): Promise<void> {
  await persist((await loadDefinitions()).filter((d) => d.id !== id));
  unregisterUserLanguage(USER_PREFIX + id);
}
