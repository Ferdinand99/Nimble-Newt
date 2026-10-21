import { describe, expect, it } from "vitest";
import { detectFromShebang, detectLanguage, getLanguage, LANGUAGES } from "./languages";

describe("language detection", () => {
  it("maps the required languages from file extensions", () => {
    const cases: Record<string, string> = {
      "a.txt": "plaintext", "README.md": "markdown", "x.json": "json", "ci.yml": "yaml", "Cargo.toml": "toml",
      "i.xml": "xml", "p.html": "html", "s.css": "css", "a.js": "javascript", "a.ts": "typescript", "a.tsx": "typescript",
      "a.py": "python", "main.rs": "rust", "main.go": "go", "a.c": "c", "a.hpp": "cpp", "A.cs": "csharp", "A.java": "java",
      "q.sql": "sql", "run.sh": "shell", "x.ps1": "powershell", "a.ini": "ini", "app.log": "log",
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
  });
  it("has unique ids and a safe fallback", () => {
    expect(new Set(LANGUAGES.map((l) => l.id)).size).toBe(LANGUAGES.length);
    expect(getLanguage("nope").id).toBe("plaintext");
  });
});
