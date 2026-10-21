import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { detectFromShebang, detectLanguage, getLanguage, isUserLanguage, LANGUAGES, registerUserLanguages, unregisterUserLanguage, type LanguageDef } from "./languages";

describe("language detection", () => {
  it("maps the required languages from file extensions", () => {
    const cases: Record<string, string> = {
      "a.txt": "plaintext", "README.md": "markdown", "x.json": "json", "ci.yml": "yaml", "Cargo.toml": "toml",
      "i.xml": "xml", "p.html": "html", "s.css": "css", "a.js": "javascript", "a.ts": "typescript", "a.tsx": "typescript",
      "a.py": "python", "main.rs": "rust", "main.go": "go", "a.c": "c", "a.hpp": "cpp", "A.cs": "csharp", "A.java": "java",
      "q.sql": "sql", "run.sh": "shell", "x.ps1": "powershell", "a.ini": "ini", "app.log": "log",
      "a.php": "php", "a.rb": "ruby", "Gemfile": "ruby", "a.pl": "perl", "a.lua": "lua", "a.swift": "swift", "a.kt": "kotlin",
      "a.scala": "scala", "a.dart": "dart", "a.R": "r", "a.jl": "julia", "a.hs": "haskell", "a.ml": "ocaml", "a.fs": "fsharp",
      "a.erl": "erlang", "a.clj": "clojure", "a.lisp": "lisp", "a.scm": "scheme", "a.groovy": "groovy", "a.coffee": "coffeescript",
      "a.m": "objectivec", "a.f90": "fortran", "a.pas": "pascal", "a.vb": "vb", "a.vbs": "vbscript", "Dockerfile": "dockerfile",
      "nginx.conf": "nginx", "CMakeLists.txt": "cmake", "Makefile": "makefile", "a.proto": "protobuf", "a.tex": "latex",
      "a.asm": "assembly", "a.v": "verilog", "a.vhd": "vhdl", "a.tcl": "tcl", "a.matlab": "matlab", "a.scss": "scss",
      "a.less": "less", "a.sass": "sass", "App.vue": "vue", "a.graphql": "graphql", "run.bat": "batch", "run.CMD": "batch",
      "a.csv": "csv", "a.tsv": "tsv", ".gitignore": "gitignore", ".env": "dotenv", "tsconfig.json": "jsonc", "a.jsonc": "jsonc",
      "a.liquid": "liquid", "a.wat": "wast", "a.ttl": "turtle", "a.d": "d", "a.cr": "crystal",
    };
    for (const [file, id] of Object.entries(cases)) expect(detectLanguage(file).id, file).toBe(id);
  });
  it("handles paths, case, dotfiles and unknowns", () => {
    expect(detectLanguage("C:\\src\\Main.RS").id).toBe("rust");
    expect(detectLanguage("/home/u/.bashrc").id).toBe("shell");
    expect(detectLanguage("Cargo.lock").id).toBe("toml");
    expect(detectLanguage("noext").id).toBe("plaintext");
    expect(detectLanguage(null).id).toBe("plaintext");
  });
  it("uses shebangs", () => {
    expect(detectFromShebang("#!/usr/bin/env python3")?.id).toBe("python");
    expect(detectFromShebang("#!/bin/bash")?.id).toBe("shell");
    expect(detectFromShebang("hello")).toBeNull();
    expect(detectFromShebang("#!/usr/bin/env ruby")?.id).toBe("ruby");
    expect(detectFromShebang("#!/usr/bin/perl -w")?.id).toBe("perl");
    expect(detectFromShebang("#!/usr/bin/php")?.id).toBe("php");
    expect(detectFromShebang("#!/usr/bin/env lua")?.id).toBe("lua");
  });
  it("has unique ids and a safe fallback", () => {
    expect(new Set(LANGUAGES.map((l) => l.id)).size).toBe(LANGUAGES.length);
    expect(getLanguage("nope").id).toBe("plaintext");
  });
  it("has at least 60 languages, unique ids and no accidental extension clashes", () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(60);
    const seen = new Map<string, string>();
    for (const l of LANGUAGES) {
      for (const e of l.extensions) {
        expect(e, e).toBe(e.toLowerCase());
        expect(seen.get(e), `extension ${e} used by ${seen.get(e)} and ${l.id}`).toBeUndefined();
        seen.set(e, l.id);
      }
    }
  });
  it("initialises every language lazily", async () => {
    for (const l of LANGUAGES) {
      const ext = await l.load();
      expect(() => EditorState.create({ doc: "a = 1\n", extensions: [ext] }), l.id).not.toThrow();
    }
  });
});

describe("user language registry", () => {
  const def = (id: string, extensions: string[]): LanguageDef => ({ id, name: id, extensions, load: async () => [] });
  it("registers, takes precedence and unregisters", () => {
    const before = LANGUAGES.length;
    registerUserLanguages([def("user-x", ["rs", "xyz"]), def("rust", ["nope"])]);
    expect(LANGUAGES.length).toBe(before + 1);
    expect(isUserLanguage("user-x")).toBe(true);
    expect(getLanguage("user-x").id).toBe("user-x");
    expect(detectLanguage("a.xyz").id).toBe("user-x");
    expect(detectLanguage("a.rs").id).toBe("user-x");
    expect(getLanguage("rust").extensions).toEqual(["rs"]);
    registerUserLanguages([def("user-x", ["xyz"])]);
    expect(LANGUAGES.length).toBe(before + 1);
    expect(detectLanguage("a.rs").id).toBe("rust");
    unregisterUserLanguage("user-x");
    unregisterUserLanguage("rust");
    expect(LANGUAGES.length).toBe(before);
    expect(detectLanguage("a.xyz").id).toBe("plaintext");
    expect(getLanguage("rust").id).toBe("rust");
  });
});
