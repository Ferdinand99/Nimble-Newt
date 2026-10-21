import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";

export interface LanguageDef {
  id: string;
  name: string;
  extensions: string[];
  filenames?: string[];
  /** Line comment token used by "Toggle comment" when the grammar does not provide one. */
  comment?: { line?: string; block?: [string, string] };
  load: () => Promise<Extension>;
}

const legacy = async (mode: Promise<Record<string, unknown>>, key: string): Promise<Extension> => {
  const m = await mode;
  return StreamLanguage.define(m[key] as Parameters<typeof StreamLanguage.define>[0]);
};

export const LANGUAGES: LanguageDef[] = [
  { id: "plaintext", name: "Plain Text", extensions: ["txt", "text"], load: async () => [] },
  { id: "markdown", name: "Markdown", extensions: ["md", "markdown", "mdx"], comment: { block: ["<!--", "-->"] }, load: async () => (await import("@codemirror/lang-markdown")).markdown() },
  { id: "json", name: "JSON", extensions: ["json", "jsonc", "json5", "geojson", "webmanifest"], filenames: [".babelrc", ".eslintrc"], load: async () => (await import("@codemirror/lang-json")).json() },
  { id: "yaml", name: "YAML", extensions: ["yaml", "yml"], comment: { line: "#" }, load: async () => (await import("@codemirror/lang-yaml")).yaml() },
  { id: "toml", name: "TOML", extensions: ["toml"], filenames: ["Cargo.lock", "Pipfile"], comment: { line: "#" }, load: () => legacy(import("@codemirror/legacy-modes/mode/toml"), "toml") },
  { id: "xml", name: "XML", extensions: ["xml", "svg", "plist", "xaml", "csproj", "xsd", "xsl", "rss", "atom"], comment: { block: ["<!--", "-->"] }, load: async () => (await import("@codemirror/lang-xml")).xml() },
  { id: "html", name: "HTML", extensions: ["html", "htm", "xhtml", "vue", "svelte"], comment: { block: ["<!--", "-->"] }, load: async () => (await import("@codemirror/lang-html")).html() },
  { id: "css", name: "CSS", extensions: ["css", "scss", "less", "pcss"], comment: { block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-css")).css() },
  { id: "javascript", name: "JavaScript", extensions: ["js", "mjs", "cjs", "jsx"], comment: { line: "//", block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }) },
  { id: "typescript", name: "TypeScript", extensions: ["ts", "mts", "cts", "tsx"], comment: { line: "//", block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }) },
  { id: "python", name: "Python", extensions: ["py", "pyw", "pyi"], comment: { line: "#" }, load: async () => (await import("@codemirror/lang-python")).python() },
  { id: "rust", name: "Rust", extensions: ["rs"], comment: { line: "//", block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-rust")).rust() },
  { id: "go", name: "Go", extensions: ["go"], filenames: ["go.mod", "go.sum"], comment: { line: "//", block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-go")).go() },
  { id: "c", name: "C", extensions: ["c", "h"], comment: { line: "//", block: ["/*", "*/"] }, load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "c") },
  { id: "cpp", name: "C++", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], comment: { line: "//", block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-cpp")).cpp() },
  { id: "csharp", name: "C#", extensions: ["cs", "csx"], comment: { line: "//", block: ["/*", "*/"] }, load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "csharp") },
  { id: "java", name: "Java", extensions: ["java"], comment: { line: "//", block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-java")).java() },
  { id: "sql", name: "SQL", extensions: ["sql", "ddl", "dml"], comment: { line: "--", block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-sql")).sql() },
  { id: "shell", name: "Shell", extensions: ["sh", "bash", "zsh", "fish", "ksh", "command"], filenames: [".bashrc", ".zshrc", ".profile", ".bash_profile", "PKGBUILD"], comment: { line: "#" }, load: () => legacy(import("@codemirror/legacy-modes/mode/shell"), "shell") },
  { id: "powershell", name: "PowerShell", extensions: ["ps1", "psm1", "psd1"], comment: { line: "#", block: ["<#", "#>"] }, load: () => legacy(import("@codemirror/legacy-modes/mode/powershell"), "powerShell") },
  { id: "ini", name: "INI", extensions: ["ini", "cfg", "conf", "properties", "desktop", "editorconfig", "gitconfig"], filenames: [".editorconfig", ".gitconfig"], comment: { line: ";" }, load: () => legacy(import("@codemirror/legacy-modes/mode/properties"), "properties") },
  { id: "log", name: "Log", extensions: ["log"], load: async () => (await import("./logLanguage")).logLanguage },
  { id: "diff", name: "Diff", extensions: ["diff", "patch"], load: () => legacy(import("@codemirror/legacy-modes/mode/diff"), "diff") },
];

const byId = new Map(LANGUAGES.map((l) => [l.id, l]));
const byExt = new Map<string, LanguageDef>();
const byFile = new Map<string, LanguageDef>();
for (const l of LANGUAGES) {
  for (const e of l.extensions) byExt.set(e, l);
  for (const f of l.filenames ?? []) byFile.set(f.toLowerCase(), l);
}

export function getLanguage(id: string | null | undefined): LanguageDef {
  return (id && byId.get(id)) || byId.get("plaintext")!;
}

/** Picks a language from a file name; unknown files are plain text. */
export function detectLanguage(fileName: string | null): LanguageDef {
  if (!fileName) return getLanguage("plaintext");
  const base = fileName.split(/[\\/]/).pop()!.toLowerCase();
  const byName = byFile.get(base);
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  if (dot >= 0) {
    const ext = byExt.get(base.slice(dot + 1));
    if (ext) return ext;
  }
  return getLanguage("plaintext");
}

/** A shebang line decides when the name does not (e.g. scripts without extension). */
export function detectFromShebang(firstLine: string): LanguageDef | null {
  if (!firstLine.startsWith("#!")) return null;
  if (/\b(ba|z|k|da)?sh\b/.test(firstLine)) return getLanguage("shell");
  if (/python/.test(firstLine)) return getLanguage("python");
  if (/\b(node|deno|bun)\b/.test(firstLine)) return getLanguage("javascript");
  if (/pwsh|powershell/.test(firstLine)) return getLanguage("powershell");
  return null;
}
