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

const SLASH = { line: "//", block: ["/*", "*/"] as [string, string] };
const HASH = { line: "#" };
const XMLC = { block: ["<!--", "-->"] as [string, string] };
const lang = (id: string, name: string, extensions: string[], load: () => Promise<Extension>, more: { filenames?: string[]; comment?: LanguageDef["comment"] } = {}): LanguageDef => ({ id, name, extensions, load, ...more });

export const LANGUAGES: LanguageDef[] = [
  { id: "plaintext", name: "Plain Text", extensions: ["txt", "text"], load: async () => [] },
  { id: "markdown", name: "Markdown", extensions: ["md", "markdown", "mdx"], comment: XMLC, load: async () => (await import("@codemirror/lang-markdown")).markdown() },
  { id: "json", name: "JSON", extensions: ["json", "geojson", "webmanifest"], filenames: [".babelrc", ".eslintrc"], load: async () => (await import("@codemirror/lang-json")).json() },
  lang("jsonc", "JSON with Comments", ["jsonc", "json5", "code-workspace"], async () => (await import("@codemirror/lang-javascript")).javascript(), { filenames: ["tsconfig.json", "jsconfig.json", "devcontainer.json"], comment: SLASH }),
  { id: "yaml", name: "YAML", extensions: ["yaml", "yml"], comment: HASH, load: async () => (await import("@codemirror/lang-yaml")).yaml() },
  { id: "toml", name: "TOML", extensions: ["toml"], filenames: ["Cargo.lock", "Pipfile"], comment: HASH, load: () => legacy(import("@codemirror/legacy-modes/mode/toml"), "toml") },
  { id: "xml", name: "XML", extensions: ["xml", "svg", "plist", "xaml", "csproj", "xsd", "xsl", "rss", "atom"], comment: XMLC, load: async () => (await import("@codemirror/lang-xml")).xml() },
  { id: "html", name: "HTML", extensions: ["html", "htm", "xhtml", "svelte"], comment: XMLC, load: async () => (await import("@codemirror/lang-html")).html() },
  { id: "css", name: "CSS", extensions: ["css", "pcss"], comment: { block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-css")).css() },
  lang("scss", "SCSS", ["scss"], async () => (await import("@codemirror/lang-sass")).sass({ indented: false }), { comment: SLASH }),
  lang("sass", "Sass", ["sass"], async () => (await import("@codemirror/lang-sass")).sass({ indented: true }), { comment: { line: "//" } }),
  lang("less", "Less", ["less"], async () => (await import("@codemirror/lang-less")).less(), { comment: SLASH }),
  lang("stylus", "Stylus", ["styl", "stylus"], () => legacy(import("@codemirror/legacy-modes/mode/stylus"), "stylus"), { comment: SLASH }),
  { id: "javascript", name: "JavaScript", extensions: ["js", "mjs", "cjs", "jsx"], comment: SLASH, load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }) },
  { id: "typescript", name: "TypeScript", extensions: ["ts", "mts", "cts", "tsx"], comment: SLASH, load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }) },
  lang("vue", "Vue", ["vue"], async () => (await import("@codemirror/lang-vue")).vue(), { comment: XMLC }),
  lang("angular", "Angular Template", [], async () => (await import("@codemirror/lang-angular")).angular(), { comment: XMLC }),
  lang("liquid", "Liquid", ["liquid"], async () => (await import("@codemirror/lang-liquid")).liquid(), { comment: XMLC }),
  lang("php", "PHP", ["php", "phtml", "php3", "php4", "php5", "phps"], async () => (await import("@codemirror/lang-php")).php(), { comment: SLASH }),
  lang("coffeescript", "CoffeeScript", ["coffee", "cson"], () => legacy(import("@codemirror/legacy-modes/mode/coffeescript"), "coffeeScript"), { filenames: ["Cakefile"], comment: HASH }),
  lang("graphql", "GraphQL", ["graphql", "gql", "graphqls"], async () => (await import("./miscLanguages")).graphqlLanguage, { comment: HASH }),
  { id: "python", name: "Python", extensions: ["py", "pyw", "pyi"], comment: HASH, load: async () => (await import("@codemirror/lang-python")).python() },
  lang("ruby", "Ruby", ["rb", "rake", "gemspec", "ru"], () => legacy(import("@codemirror/legacy-modes/mode/ruby"), "ruby"), { filenames: ["Gemfile", "Rakefile", "Podfile", "Vagrantfile", "Brewfile", "Guardfile"], comment: HASH }),
  lang("perl", "Perl", ["pl", "pm", "t", "pod"], () => legacy(import("@codemirror/legacy-modes/mode/perl"), "perl"), { comment: HASH }),
  lang("lua", "Lua", ["lua"], () => legacy(import("@codemirror/legacy-modes/mode/lua"), "lua"), { comment: { line: "--", block: ["--[[", "]]"] } }),
  lang("r", "R", ["r", "rmd"], () => legacy(import("@codemirror/legacy-modes/mode/r"), "r"), { comment: HASH }),
  lang("julia", "Julia", ["jl"], () => legacy(import("@codemirror/legacy-modes/mode/julia"), "julia"), { comment: { line: "#", block: ["#=", "=#"] } }),
  lang("matlab", "MATLAB / Octave", ["matlab", "octave"], () => legacy(import("@codemirror/legacy-modes/mode/octave"), "octave"), { comment: { line: "%" } }),
  lang("mathematica", "Wolfram Language", ["wl", "wls", "mma"], () => legacy(import("@codemirror/legacy-modes/mode/mathematica"), "mathematica"), { comment: { block: ["(*", "*)"] } }),
  { id: "rust", name: "Rust", extensions: ["rs"], comment: SLASH, load: async () => (await import("@codemirror/lang-rust")).rust() },
  { id: "go", name: "Go", extensions: ["go"], filenames: ["go.mod", "go.sum"], comment: SLASH, load: async () => (await import("@codemirror/lang-go")).go() },
  { id: "c", name: "C", extensions: ["c", "h"], comment: SLASH, load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "c") },
  { id: "cpp", name: "C++", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], comment: SLASH, load: async () => (await import("@codemirror/lang-cpp")).cpp() },
  lang("objectivec", "Objective-C", ["m", "mm"], () => legacy(import("@codemirror/legacy-modes/mode/clike"), "objectiveC"), { comment: SLASH }),
  { id: "csharp", name: "C#", extensions: ["cs", "csx"], comment: SLASH, load: () => legacy(import("@codemirror/legacy-modes/mode/clike"), "csharp") },
  { id: "java", name: "Java", extensions: ["java"], comment: SLASH, load: async () => (await import("@codemirror/lang-java")).java() },
  lang("kotlin", "Kotlin", ["kt", "kts"], () => legacy(import("@codemirror/legacy-modes/mode/clike"), "kotlin"), { comment: SLASH }),
  lang("scala", "Scala", ["scala", "sbt", "sc"], () => legacy(import("@codemirror/legacy-modes/mode/clike"), "scala"), { comment: SLASH }),
  lang("dart", "Dart", ["dart"], () => legacy(import("@codemirror/legacy-modes/mode/clike"), "dart"), { comment: SLASH }),
  lang("groovy", "Groovy", ["groovy", "gradle", "gvy"], () => legacy(import("@codemirror/legacy-modes/mode/groovy"), "groovy"), { filenames: ["Jenkinsfile"], comment: SLASH }),
  lang("swift", "Swift", ["swift"], () => legacy(import("@codemirror/legacy-modes/mode/swift"), "swift"), { comment: SLASH }),
  lang("glsl", "GLSL / Shader", ["glsl", "vert", "frag", "shader", "hlsl"], () => legacy(import("@codemirror/legacy-modes/mode/clike"), "shader"), { comment: SLASH }),
  lang("d", "D", ["d"], () => legacy(import("@codemirror/legacy-modes/mode/d"), "d"), { comment: SLASH }),
  lang("crystal", "Crystal", ["cr"], () => legacy(import("@codemirror/legacy-modes/mode/crystal"), "crystal"), { comment: HASH }),
  lang("haskell", "Haskell", ["hs", "lhs"], () => legacy(import("@codemirror/legacy-modes/mode/haskell"), "haskell"), { comment: { line: "--", block: ["{-", "-}"] } }),
  lang("elm", "Elm", ["elm"], () => legacy(import("@codemirror/legacy-modes/mode/elm"), "elm"), { comment: { line: "--", block: ["{-", "-}"] } }),
  lang("ocaml", "OCaml", ["ml", "mli", "mll", "mly"], () => legacy(import("@codemirror/legacy-modes/mode/mllike"), "oCaml"), { comment: { block: ["(*", "*)"] } }),
  lang("fsharp", "F#", ["fs", "fsx", "fsi"], () => legacy(import("@codemirror/legacy-modes/mode/mllike"), "fSharp"), { comment: { line: "//", block: ["(*", "*)"] } }),
  lang("sml", "Standard ML", ["sml", "sig"], () => legacy(import("@codemirror/legacy-modes/mode/mllike"), "sml"), { comment: { block: ["(*", "*)"] } }),
  lang("erlang", "Erlang", ["erl", "hrl"], () => legacy(import("@codemirror/legacy-modes/mode/erlang"), "erlang"), { comment: { line: "%" } }),
  lang("clojure", "Clojure", ["clj", "cljs", "cljc", "edn"], () => legacy(import("@codemirror/legacy-modes/mode/clojure"), "clojure"), { comment: { line: ";" } }),
  lang("lisp", "Common Lisp", ["lisp", "lsp", "cl", "el", "asd"], () => legacy(import("@codemirror/legacy-modes/mode/commonlisp"), "commonLisp"), { comment: { line: ";" } }),
  lang("scheme", "Scheme", ["scm", "ss", "rkt", "sld"], () => legacy(import("@codemirror/legacy-modes/mode/scheme"), "scheme"), { comment: { line: ";" } }),
  lang("forth", "Forth", ["fth", "4th", "forth"], () => legacy(import("@codemirror/legacy-modes/mode/forth"), "forth"), { comment: { line: "\\" } }),
  lang("fortran", "Fortran", ["f90", "f95", "f03", "f08", "f", "for"], () => legacy(import("@codemirror/legacy-modes/mode/fortran"), "fortran"), { comment: { line: "!" } }),
  lang("pascal", "Pascal", ["pas", "dpr", "lpr"], () => legacy(import("@codemirror/legacy-modes/mode/pascal"), "pascal"), { comment: { block: ["(*", "*)"] } }),
  lang("cobol", "COBOL", ["cob", "cbl", "cobol"], () => legacy(import("@codemirror/legacy-modes/mode/cobol"), "cobol"), { comment: { line: "*>" } }),
  lang("smalltalk", "Smalltalk", ["st"], () => legacy(import("@codemirror/legacy-modes/mode/smalltalk"), "smalltalk"), { comment: { block: ['"', '"'] } }),
  lang("vb", "Visual Basic", ["vb", "bas", "frm", "cls"], () => legacy(import("@codemirror/legacy-modes/mode/vb"), "vb"), { comment: { line: "'" } }),
  lang("vbscript", "VBScript", ["vbs", "wsf"], () => legacy(import("@codemirror/legacy-modes/mode/vbscript"), "vbScript"), { comment: { line: "'" } }),
  lang("tcl", "Tcl", ["tcl", "tk"], () => legacy(import("@codemirror/legacy-modes/mode/tcl"), "tcl"), { comment: HASH }),
  lang("verilog", "Verilog / SystemVerilog", ["v", "sv", "svh", "vh"], () => legacy(import("@codemirror/legacy-modes/mode/verilog"), "verilog"), { comment: SLASH }),
  lang("vhdl", "VHDL", ["vhd", "vhdl"], () => legacy(import("@codemirror/legacy-modes/mode/vhdl"), "vhdl"), { comment: { line: "--" } }),
  lang("assembly", "Assembly", ["asm", "s", "nasm", "inc"], () => legacy(import("@codemirror/legacy-modes/mode/gas"), "gas"), { comment: { line: "#" } }),
  lang("z80", "Z80 Assembly", ["z80", "ez80"], () => legacy(import("@codemirror/legacy-modes/mode/z80"), "z80"), { comment: { line: ";" } }),
  lang("wast", "WebAssembly Text", ["wat", "wast"], async () => (await import("@codemirror/lang-wast")).wast(), { comment: { line: ";;", block: ["(;", ";)"] } }),
  lang("sas", "SAS", ["sas"], () => legacy(import("@codemirror/legacy-modes/mode/sas"), "sas"), { comment: { block: ["/*", "*/"] } }),
  lang("protobuf", "Protocol Buffers", ["proto"], () => legacy(import("@codemirror/legacy-modes/mode/protobuf"), "protobuf"), { comment: { line: "//" } }),
  { id: "sql", name: "SQL", extensions: ["sql", "ddl", "dml"], comment: { line: "--", block: ["/*", "*/"] }, load: async () => (await import("@codemirror/lang-sql")).sql() },
  lang("cypher", "Cypher", ["cypher", "cql"], () => legacy(import("@codemirror/legacy-modes/mode/cypher"), "cypher"), { comment: { line: "//" } }),
  lang("sparql", "SPARQL", ["rq", "sparql"], () => legacy(import("@codemirror/legacy-modes/mode/sparql"), "sparql"), { comment: HASH }),
  lang("turtle", "Turtle (RDF)", ["ttl"], () => legacy(import("@codemirror/legacy-modes/mode/turtle"), "turtle"), { comment: HASH }),
  lang("latex", "LaTeX", ["tex", "sty", "ltx", "bib"], () => legacy(import("@codemirror/legacy-modes/mode/stex"), "stex"), { comment: { line: "%" } }),
  lang("troff", "Troff / man", ["roff", "troff"], () => legacy(import("@codemirror/legacy-modes/mode/troff"), "troff"), {}),
  lang("gherkin", "Gherkin", ["feature"], () => legacy(import("@codemirror/legacy-modes/mode/gherkin"), "gherkin"), { comment: HASH }),
  lang("pug", "Pug", ["pug", "jade"], () => legacy(import("@codemirror/legacy-modes/mode/pug"), "pug"), { comment: SLASH }),
  lang("jinja2", "Jinja2", ["j2", "jinja", "jinja2"], () => legacy(import("@codemirror/legacy-modes/mode/jinja2"), "jinja2"), { comment: { block: ["{#", "#}"] } }),
  lang("dtd", "DTD", ["dtd"], () => legacy(import("@codemirror/legacy-modes/mode/dtd"), "dtd"), { comment: XMLC }),
  lang("ebnf", "EBNF", ["ebnf"], () => legacy(import("@codemirror/legacy-modes/mode/ebnf"), "ebnf"), { comment: { block: ["(*", "*)"] } }),
  { id: "shell", name: "Shell", extensions: ["sh", "bash", "zsh", "fish", "ksh", "command"], filenames: [".bashrc", ".zshrc", ".profile", ".bash_profile", "PKGBUILD"], comment: HASH, load: () => legacy(import("@codemirror/legacy-modes/mode/shell"), "shell") },
  { id: "powershell", name: "PowerShell", extensions: ["ps1", "psm1", "psd1"], comment: { line: "#", block: ["<#", "#>"] }, load: () => legacy(import("@codemirror/legacy-modes/mode/powershell"), "powerShell") },
  lang("batch", "Batch", ["bat", "cmd"], async () => (await import("./batchLanguage")).batchLanguage, { comment: { line: "REM " } }),
  lang("dockerfile", "Dockerfile", ["dockerfile"], () => legacy(import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile"), { filenames: ["Dockerfile", "Containerfile"], comment: HASH }),
  lang("makefile", "Makefile", ["mk", "mak"], async () => (await import("./miscLanguages")).makefileLanguage, { filenames: ["Makefile", "makefile", "GNUmakefile"], comment: HASH }),
  lang("cmake", "CMake", ["cmake"], () => legacy(import("@codemirror/legacy-modes/mode/cmake"), "cmake"), { filenames: ["CMakeLists.txt"], comment: HASH }),
  lang("nginx", "Nginx", ["nginx"], () => legacy(import("@codemirror/legacy-modes/mode/nginx"), "nginx"), { filenames: ["nginx.conf"], comment: HASH }),
  lang("puppet", "Puppet", ["pp"], () => legacy(import("@codemirror/legacy-modes/mode/puppet"), "puppet"), { comment: HASH }),
  lang("nsis", "NSIS", ["nsi", "nsh"], () => legacy(import("@codemirror/legacy-modes/mode/nsis"), "nsis"), { comment: { line: ";" } }),
  lang("http", "HTTP", ["http", "rest"], () => legacy(import("@codemirror/legacy-modes/mode/http"), "http"), {}),
  lang("gitignore", "Ignore File", ["gitignore", "dockerignore", "npmignore"], async () => (await import("./miscLanguages")).ignoreLanguage, { filenames: [".gitignore", ".dockerignore", ".npmignore", ".gitattributes", ".ignore"], comment: HASH }),
  lang("dotenv", "Dotenv", ["env"], () => legacy(import("@codemirror/legacy-modes/mode/properties"), "properties"), { filenames: [".env", ".env.local", ".env.development", ".env.production", ".env.example", ".env.test"], comment: HASH }),
  lang("csv", "CSV", ["csv"], async () => (await import("./miscLanguages")).csv, {}),
  lang("tsv", "TSV", ["tsv", "tab"], async () => (await import("./miscLanguages")).tsv, {}),
  { id: "ini", name: "INI", extensions: ["ini", "cfg", "conf", "properties", "desktop", "editorconfig", "gitconfig"], filenames: [".editorconfig", ".gitconfig"], comment: { line: ";" }, load: () => legacy(import("@codemirror/legacy-modes/mode/properties"), "properties") },
  { id: "log", name: "Log", extensions: ["log"], load: async () => (await import("./logLanguage")).logLanguage },
  { id: "diff", name: "Diff", extensions: ["diff", "patch"], load: () => legacy(import("@codemirror/legacy-modes/mode/diff"), "diff") },
];

let byId = new Map<string, LanguageDef>();
let byExt = new Map<string, LanguageDef>();
let byFile = new Map<string, LanguageDef>();
const userIds = new Set<string>();

/** Rebuilds the lookup tables. Later entries win, so user languages (appended last) take precedence. */
function reindex(): void {
  byId = new Map(LANGUAGES.map((l) => [l.id, l]));
  byExt = new Map();
  byFile = new Map();
  for (const l of LANGUAGES) {
    for (const e of l.extensions) byExt.set(e.toLowerCase(), l);
    for (const f of l.filenames ?? []) byFile.set(f.toLowerCase(), l);
  }
}
reindex();

/** Adds (or replaces) user-defined languages at runtime. Ids of built-in languages are never overwritten. */
export function registerUserLanguages(defs: LanguageDef[]): void {
  for (const d of defs) {
    if (byId.has(d.id) && !userIds.has(d.id)) continue;
    const at = LANGUAGES.findIndex((l) => l.id === d.id);
    if (at >= 0) LANGUAGES.splice(at, 1);
    LANGUAGES.push(d);
    userIds.add(d.id);
    byId.set(d.id, d);
  }
  reindex();
}

export function unregisterUserLanguage(id: string): void {
  if (!userIds.delete(id)) return;
  const at = LANGUAGES.findIndex((l) => l.id === id);
  if (at >= 0) LANGUAGES.splice(at, 1);
  reindex();
}

export function isUserLanguage(id: string): boolean {
  return userIds.has(id);
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
  if (/\bruby\b|\birb\b/.test(firstLine)) return getLanguage("ruby");
  if (/\bperl\b/.test(firstLine)) return getLanguage("perl");
  if (/\bphp\b/.test(firstLine)) return getLanguage("php");
  if (/\blua(jit)?\d*(\.\d+)?\b/.test(firstLine)) return getLanguage("lua");
  return null;
}
