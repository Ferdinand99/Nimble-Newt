import { describe, expect, it } from "vitest";
import { guessLanguage } from "./guess";

const cases: [string, string, string][] = [
  ["json", "json object", '{\n  "name": "demo",\n  "items": [1, 2, 3]\n}'],
  ["json", "json array", '[{"a": 1}, {"a": 2}]'],
  ["html", "html doc", "<!DOCTYPE html>\n<html><body><p>Hi</p></body></html>"],
  ["html", "html fragment", '<div class="box">\n  <p>Hello</p>\n</div>'],
  ["xml", "xml prolog", '<?xml version="1.0"?>\n<root><item id="1"/></root>'],
  ["xml", "svg", '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'],
  ["diff", "git diff", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"],
  ["javascript", "js", "const x = 1;\nfunction add(a, b) {\n  return a + b;\n}\nconsole.log(add(x, 2));"],
  ["javascript", "js arrow + require", "const fs = require('fs');\nconst f = (a) => a * 2;"],
  ["typescript", "ts", "interface User {\n  id: number;\n  name: string;\n}\nconst u: User = { id: 1, name: 'a' };"],
  ["python", "python", "import os\n\ndef main():\n    print(os.getcwd())\n\nif __name__ == '__main__':\n    main()"],
  ["rust", "rust", "use std::fs;\n\nfn main() {\n    let mut s = String::new();\n    println!(\"{}\", s);\n}"],
  ["go", "go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tx := 1\n\tfmt.Println(x)\n}'],
  ["csharp", "c#", "using System;\n\nnamespace App {\n  class P { static void Main() { Console.WriteLine(1); } }\n}"],
  ["java", "java", 'import java.util.List;\npublic class A {\n  public static void main(String[] a) { System.out.println("x"); }\n}'],
  ["cpp", "c++", '#include <iostream>\nint main() {\n  std::cout << "hi" << std::endl;\n}'],
  ["c", "c", '#include <stdio.h>\nint main(void) {\n  printf("hi\\n");\n  return 0;\n}'],
  ["sql", "sql select", "SELECT id, name FROM users WHERE id = 1 ORDER BY name;"],
  ["sql", "sql ddl", "CREATE TABLE t (id INT PRIMARY KEY, name TEXT);"],
  ["shell", "shebang", "#!/bin/bash\necho hello"],
  ["python", "shebang python", "#!/usr/bin/env python3\nprint(1)"],
  ["powershell", "powershell", "param($Name)\nGet-ChildItem | Write-Host $Name"],
  ["css", "css", "body {\n  margin: 0;\n  padding: 0;\n}\n.box { color: red; }"],
  ["yaml", "yaml", "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest"],
  ["toml", "toml", '[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"'],
  ["ini", "ini", "; settings\n[general]\nname=demo\nlevel=3"],
  ["markdown", "markdown", "# Title\n\nSome **bold** text and a [link](http://x.y).\n\n- one\n- two"],
  ["log", "log", "2026-01-01 12:00:00 INFO started\n2026-01-01 12:00:01 ERROR failed"],
];

describe("guessLanguage", () => {
  for (const [id, name, text] of cases) {
    it(`${name} -> ${id}`, () => expect(guessLanguage(text)).toBe(id));
  }
  it("returns null for ordinary prose and tiny input", () => {
    expect(guessLanguage("Meeting notes\nbuy milk and call Anna tomorrow")).toBeNull();
    expect(guessLanguage("hi")).toBeNull();
    expect(guessLanguage("")).toBeNull();
  });
  it("does not call plain numbers or words JSON", () => {
    expect(guessLanguage("[not json at all")).toBeNull();
  });
});
