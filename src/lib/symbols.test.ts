import { describe, expect, it } from "vitest";
import { extractSymbols, hasSymbols, MAX_SYMBOLS, type SymbolKind } from "./symbols";

/** "kind name" strings, easy to compare. */
const sym = (text: string, lang: string) => extractSymbols(text, lang).map((s) => `${s.kind} ${s.name}`);
const full = (text: string, lang: string) => extractSymbols(text, lang).map((s) => `${s.kind} ${s.name}@${s.line}:${s.level ?? "-"}`);

describe("javascript / typescript", () => {
  const js = `/* function commented() {} */
// function lineComment() {}
function realFn(a, b) {
  if (a) { return foo(bar); }
  while (b) { b--; }
  const inner = () => 1;
  function nested() {}
}
export const arrow = async (x) => { return x; };
export default function main() {}
const fnExpr = function () {};
const MAX_SIZE = 10;
const plain = 5;
class Foo extends Bar {
  constructor() { super(); }
  method(a) { if (a) { call(a); } }
  static async load() {}
  get value() { return 1; }
  handler = () => { this.x(); };
  other() {
    return this.method(1);
  }
}
const s = "function fake() {}";
const t = \`
function inTemplate() {}
\`;
module.exports.helper = function () {};
`;
  it("finds declarations and methods, not calls or control flow", () => {
    expect(sym(js, "javascript")).toEqual([
      "function realFn",
      "function arrow",
      "function main",
      "function fnExpr",
      "constant MAX_SIZE",
      "class Foo",
      "method constructor",
      "method method",
      "method load",
      "method value",
      "method handler",
      "method other",
      "function module.exports.helper",
    ]);
  });
  it("records 1-based lines and nesting level", () => {
    const f = full(js, "javascript");
    expect(f).toContain("function realFn@3:0");
    expect(f).toContain("class Foo@14:0");
    expect(f).toContain("method method@16:1");
  });
  it("does not leak a '/*' inside a string into a comment", () => {
    const src = `const glob = "src/**/*.ts";\nfunction after() {}\n`;
    expect(sym(src, "javascript")).toEqual(["function after"]);
  });
  it("handles TypeScript declarations", () => {
    const ts = `export interface Options<T> {
  name: string;
  run(x: T): void;
}
export type Id = string | number;
declare enum Color { Red, Green }
export abstract class Base<T> implements Options<T> {
  @Input() title = "";
  @HostListener("click") onClick(e: Event): void {}
  private readonly cache = new Map();
  protected abstract compute(x: number): number;
  public static create<U>(x: U): Base<U> { return new Impl(x); }
}
namespace Util.Strings { export function trim(s: string) { return s; } }
const gen = <T,>(x: T): T => x;
`;
    expect(sym(ts, "typescript")).toEqual([
      "interface Options",
      "method run",
      "type Id",
      "enum Color",
      "class Base",
      "method onClick",
      "method compute",
      "method create",
      "module Util.Strings",
      "function gen",
    ]);
  });
});

describe("python", () => {
  const py = `"""Module doc.
def not_a_function():
"""
import os

MAX_RETRIES = 3

def top(a, b=2):
    x = helper(a)
    return x

async def fetch(url):
    def inner():
        pass
    return inner

class Greeter(Base):
    '''
    class InDocstring:
    '''
    def __init__(self):
        self.x = 1

    async def hello(self):
        # def commented(self):
        return f"def fake()"

    class Meta:
        pass

if __name__ == "__main__":
    def late(): pass
`;
  it("finds defs and classes with nesting levels", () => {
    expect(full(py, "python")).toEqual([
      "constant MAX_RETRIES@6:0",
      "function top@8:0",
      "function fetch@12:0",
      "function inner@13:1",
      "class Greeter@17:0",
      "method __init__@21:1",
      "method hello@24:1",
      "class Meta@28:1",
      "function late@32:0",
    ]);
  });
});

describe("rust", () => {
  const rs = `//! crate docs
/* fn commented() {} */
pub mod util {
    pub fn helper() -> u8 { 0 }
}
const LIMIT: usize = 10;
static mut COUNTER: u32 = 0;
pub struct Point<T> { x: T, y: T }
struct Unit;
pub(crate) enum Shape { Circle(f64), Square(f64) }
pub trait Draw {
    fn draw(&self);
    fn size(&self) -> u32 { 0 }
}
impl<T: Copy> Point<T> {
    pub const fn new(x: T, y: T) -> Self { Point { x, y } }
    pub async fn load(&self) {}
}
impl Draw for Point<i32> {
    fn draw(&self) { println!("{}", '{'); }
}
pub unsafe extern "C" fn ffi() {}
fn main() {
    let c = '}';
    fn local() {}
    if x { call(); }
}
type Alias = Vec<u8>;
macro_rules! square { ($x:expr) => { $x * $x }; }
fn lifetimes<'a>(x: &'a str) -> &'a str { x }
`;
  it("finds items, nesting and ignores braces in char literals", () => {
    expect(full(rs, "rust")).toEqual([
      "module util@3:0",
      "function helper@4:1",
      "constant LIMIT@6:0",
      "constant COUNTER@7:0",
      "struct Point@8:0",
      "struct Unit@9:0",
      "enum Shape@10:0",
      "trait Draw@11:0",
      "method draw@12:1",
      "method size@13:1",
      "class impl<T: Copy> Point<T>@15:0",
      "method new@16:1",
      "method load@17:1",
      "class impl Draw for Point<i32>@19:0",
      "method draw@20:1",
      "function ffi@22:0",
      "function main@23:0",
      "type Alias@28:0",
      "function square@29:0",
      "function lifetimes@30:0",
    ]);
  });
});

describe("go", () => {
  const go = `package main

import "fmt"

const Version = "1.0"

type Server struct {
	Name string
}

type Handler interface {
	Serve() error
}

type ID int

func NewServer(name string) *Server {
	if name == "" {
		return nil
	}
	fmt.Println(foo(name))
	return &Server{Name: name}
}

func (s *Server) Start() error { return nil }
func (Server) Stop() {}
func Map[T any](xs []T) []T { return xs }
var raw = \`
func fake() {}
\`
`;
  it("finds funcs, methods and types", () => {
    expect(sym(go, "go")).toEqual([
      "constant Version",
      "struct Server",
      "interface Handler",
      "type ID",
      "function NewServer",
      "method Server.Start",
      "method Server.Stop",
      "function Map",
    ]);
  });
});

describe("c and c++", () => {
  const c = `#include <stdio.h>
#define MAX(a, b) ((a) > (b) ? (a) : (b))

/* int commented(void) { return 0; } */
typedef struct Node {
    int value;
    struct Node *next;
} Node;

static int helper(int a);

int main(int argc, char **argv) {
    if (argc > 1) {
        printf("%d\\n", helper(argc));
    }
    while (running()) { step(); }
    return 0;
}

static void
linux_style(int x)
{
    foo(x);
}

struct node *make_node(void) { return 0; }
`;
  it("finds C function definitions only", () => {
    expect(sym(c, "c")).toEqual(["struct Node", "function main", "function linux_style", "function make_node"]);
  });
  const cpp = `namespace app {
namespace detail {
int hidden() { return 1; }
}

template <typename T>
class Stack {
public:
    Stack() {}
    ~Stack() {}
    void push(const T& v) { items.push_back(v); }
    T pop();
private:
    std::vector<T> items;
};

enum class Color { Red, Green };
struct Fwd;
class Widget : public Base {
    int size() const { return n; }
};
}  // namespace app

void Widget::paint(int x) {
    draw(x);
}
Stack::Stack() : n(0) {}
extern "C" {
void c_api(int x) {}
}
int operator+(const A& a, const A& b) { return 0; }
`;
  it("finds classes, namespaces and members", () => {
    expect(sym(cpp, "cpp")).toEqual([
      "module app",
      "module detail",
      "function hidden",
      "class Stack",
      "method Stack",
      "method ~Stack",
      "method push",
      "enum Color",
      "class Widget",
      "method size",
      "function Widget::paint",
      "function Stack::Stack",
      "function c_api",
      "function operator+",
    ]);
  });
  it("ignores calls and control flow", () => {
    const src = `int f(int a) {\n  if (a) { return g(a); }\n  for (;;) {}\n  switch (a) { case 1: break; }\n}\n`;
    expect(sym(src, "c")).toEqual(["function f"]);
  });
});

describe("c#", () => {
  const cs = `using System;
namespace Demo.App
{
    [Serializable]
    public class Service : IService
    {
        private readonly int _n = Compute();
        public Service(int n) { _n = n; }
        ~Service() {}
        [HttpGet("x")] public async Task<int> RunAsync(string s) {
            if (s == null) { return Foo(s); }
            return 1;
        }
        public int Twice(int x) => x * 2;
        public string Name { get; set; }
        protected abstract void Do();
    }
    public interface IService
    {
        void Run();
        int Count();
    }
    public enum Mode { A, B }
    public record Point(int X, int Y);
    internal struct Vec { public float X; }
}
`;
  it("finds namespaces, types and members", () => {
    expect(sym(cs, "csharp")).toEqual([
      "module Demo.App",
      "class Service",
      "method Service",
      "method ~Service",
      "method RunAsync",
      "method Twice",
      "method Do",
      "interface IService",
      "method Run",
      "method Count",
      "enum Mode",
      "class Point",
      "struct Vec",
    ]);
  });
});

describe("java / kotlin / swift / php / ruby / lua", () => {
  it("java", () => {
    const java = `package com.x;
/** class Doc {} */
@Entity
public class User extends Base {
    private int id = compute();
    @Override
    public String toString() { return "x"; }
    public User(int id) { this.id = id; }
    static <T> List<T> of(T... xs) { return null; }
    void run() {
        for (int i = 0; i < 3; i++) { foo(i); }
        new Thread(() -> bar()).start();
    }
}
interface Shape {
    double area();
}
enum Level { LOW, HIGH }
`;
    expect(sym(java, "java")).toEqual(["class User", "method toString", "method User", "method of", "method run", "interface Shape", "method area", "enum Level"]);
  });
  it("kotlin", () => {
    const kt = `package a
const val LIMIT = 3
data class P(val x: Int)
interface Shape {
    fun area(): Double
}
object Registry {
    fun register(x: Int) {}
}
class Foo {
    companion object {
        fun make() = Foo()
    }
    private suspend fun load(): Unit { call() }
}
fun String.shout(): String = uppercase()
fun <T> List<T>.second(): T = this[1]
`;
    expect(sym(kt, "kotlin")).toEqual(["constant LIMIT", "class P", "interface Shape", "method area", "class Registry", "method register", "class Foo", "method make", "method load", "function shout", "function second"]);
  });
  it("swift", () => {
    const sw = `import UIKit
protocol Drawable {
    func draw()
}
struct Point { var x = 0
  mutating func move(by d: Int) { x += d } }
public final class View: UIView {
    override init(frame: CGRect) { super.init(frame: frame) }
    @objc private func tapped() { handle() }
    static func == (a: View, b: View) -> Bool { true }
}
extension View {
    func extra() {}
}
func free() { if true { call() } }
typealias Id = Int
`;
    expect(sym(sw, "swift")).toEqual(["interface Drawable", "method draw", "struct Point", "method move", "class View", "method init", "method tapped", "method ==", "class extension View", "method extra", "function free", "type Id"]);
  });
  it("php", () => {
    const php = `<?php
namespace App\\Http;
const TOP = 1;
function helper($a) { return strlen($a); }
abstract class Ctl extends Base {
    const LIMIT = 5;
    public function __construct() {}
    public static function make(): self { return new self(); }
    private function x() { foo(); }
}
interface I {}
trait T {
    function t() {}
}
$f = function () { return 1; };
`;
    expect(sym(php, "php")).toEqual(["module App\\Http", "constant TOP", "function helper", "class Ctl", "constant LIMIT", "method __construct", "method make", "method x", "interface I", "trait T", "method t"]);
  });
  it("ruby", () => {
    const rb = `module Shop
  class Cart < Base
    def add(item)
      items << item
    end

    def self.build
      new
    end

    private

    def total?
      items.sum
    end
  end
end
=begin
def hidden
=end
def top_level; end
`;
    expect(full(rb, "ruby")).toEqual(["module Shop@1:0", "class Cart@2:1", "method add@3:2", "method self.build@7:2", "method total?@13:2", "function top_level@21:0"]);
  });
  it("lua", () => {
    const lua = `local M = {}
--[[ function commented() end ]]
function M.open(path) end
function M:close() end
local function helper() end
M.run = function(x) return x end
return M
`;
    expect(sym(lua, "lua")).toEqual(["function M.open", "method M:close", "function helper", "function M.run"]);
  });
});

describe("markup and data languages", () => {
  it("markdown headings ignore fenced code and front matter", () => {
    const md = `---
title: x
# not a heading
---
# Title
Intro

\`\`\`bash
# comment, not heading
\`\`\`

## Section ##
text
### Sub section
#hashtag
Setext
======
~~~
# no
~~~
Other
-----

- item
---
`;
    expect(full(md, "markdown")).toEqual(["heading Title@5:1", "heading Section@12:2", "heading Sub section@14:3", "heading Setext@16:1", "heading Other@21:2"]);
  });
  it("sql", () => {
    const sql = `-- create table fake (a int);
/* CREATE VIEW hidden AS SELECT 1; */
CREATE TABLE IF NOT EXISTS users (id int);
create or replace view v_active as select 1;
CREATE OR ALTER PROCEDURE dbo.DoIt AS BEGIN SELECT 1 END
CREATE UNIQUE INDEX idx ON users(id);
select * from users;
`;
    expect(sym(sql, "sql")).toEqual(["table users", "table v_active", "function dbo.DoIt", "variable idx"]);
  });
  it("shell and powershell", () => {
    expect(sym(`#!/bin/bash\n# foo() {\nfoo() {\n  echo hi\n}\nfunction bar {\n  :\n}\nfunction baz() { :; }\nif [ -f x ]; then run(); fi\n`, "shell")).toEqual(["function foo", "function bar", "function baz"]);
    expect(sym(`<#\nfunction Hidden {}\n#>\nfunction Get-Thing {\n}\nclass Foo {}\n`, "powershell")).toEqual(["function Get-Thing", "class Foo"]);
  });
  it("css and scss", () => {
    const css = `/* .hidden { } */
:root { --a: 1; }
.btn, .link {
  color: red;
  &:hover { color: blue; }
}
@media (max-width: 600px) {
  .btn { color: green; }
}
@keyframes spin { from { a: b } to { a: c } }
`;
    expect(full(css, "css")).toEqual([
      "selector :root@2:0",
      "selector .btn, .link@3:0",
      "section @media (max-width: 600px)@7:0",
      "selector .btn@8:1",
      "selector @keyframes spin@10:0",
    ]);
    expect(sym(`$gap: 4px;\n@mixin center { display: flex; }\n@function rem($px) { @return 1; }\n%ph { a: b; }\n`, "scss")).toEqual(["variable $gap", "function center", "function rem", "selector %ph"]);
  });
  it("yaml, toml and ini", () => {
    expect(sym(`# c\nversion: 3\nservices:\n  web:\n    image: x\n"quoted key": 1\n- item\nlist: |\n  text: here\n`, "yaml")).toEqual(["variable version", "section services", "variable quoted key", "section list"]);
    expect(full(`[package]\nname = "x"\n[dependencies.serde]\n[[bin]]\n`, "toml")).toEqual(["table package@1:0", "table dependencies.serde@3:1", "table bin@4:0"]);
    expect(sym(`; c\n[core]\nname=x\n[ user ]\n`, "ini")).toEqual(["section core", "section user"]);
  });
  it("html", () => {
    const html = `<!-- <h1>hidden</h1> -->
<h1>Page <em>title</em></h1>
<div id="app"><section id='intro'>
<h2 class="x">Intro &amp; more</h2>
</section></div>
`;
    expect(full(html, "html")).toEqual(["heading Page title@2:1", "selector #app@3:0", "selector #intro@3:0", "heading Intro &amp; more@4:2"]);
  });
  it("latex", () => {
    const tex = `\\documentclass{article}\n% \\section{hidden}\n\\section{Intro}\n\\subsection*{Details}\n\\newcommand{\\foo}{x}\n`;
    expect(full(tex, "latex")).toEqual(["section Intro@3:1", "section Details@4:2", "function foo@5:0"]);
  });
  it("dockerfile and makefile", () => {
    expect(sym(`FROM node:20 AS build\nRUN x\nFROM nginx\nCOPY --from=build a b\n`, "dockerfile")).toEqual(["section build", "section nginx"]);
    const mk = `CC := gcc\nCFLAGS = -O2\n.PHONY: all clean\nall: main.o util.o\n\t$(CC) -o app $^\n%.o: %.c\n\t$(CC) -c $<\nclean:\n\trm -f *.o\nifeq ($(OS),x)\nendif\n`;
    expect(sym(mk, "makefile")).toEqual(["section all", "section %.o", "section clean"]);
  });
  it("diff", () => {
    expect(sym(`diff --git a/x.ts b/x.ts\nindex 1..2\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n`, "diff")).toEqual(["section x.ts", "section y"]);
    expect(sym(`--- a/p.c\n+++ b/p.c\n@@\n`, "diff")).toEqual(["section p.c"]);
  });
});

describe("other languages", () => {
  it("scala", () => {
    expect(full(`object Main {\n  def run(x: Int): Int = x\n  case class P(a: Int)\n}\ntrait T {\n  def t: Unit\n}\n`, "scala")).toEqual(["class Main@1:0", "method run@2:1", "class P@3:1", "trait T@5:0", "method t@6:1"]);
  });
  it("dart", () => {
    expect(sym(`import 'a.dart';\nabstract class A {\n  void run() { call(); }\n  A(this.x);\n}\nvoid main() {\n  runApp(MyApp());\n}\nmixin M {}\n`, "dart")).toEqual(["class A", "method run", "function main", "trait M"]);
  });
  it("r and julia", () => {
    expect(sym(`# f <- function() 1\nf <- function(x) {\n  g <- function() 2\n}\nh = function() 3\nprint(x)\n`, "r")).toEqual(["function f", "function g", "function h"]);
    expect(sym(`module M\nfunction foo(x)\n  bar(x)\nend\nsq(x) = x^2\nstruct P\n  a::Int\nend\nend\n`, "julia")).toEqual(["module M", "function foo", "function sq", "struct P"]);
  });
  it("haskell, ocaml, erlang, clojure, lisp", () => {
    expect(sym(`module Main where\n-- foo :: Int\nmain :: IO ()\nmain = putStrLn "x"\ndata Tree a = Leaf | Node\nclass Show a => Pretty a where\n  pretty :: a -> String\n`, "haskell")).toEqual(["module Main", "function main", "type Tree", "class Pretty"]);
    expect(sym(`(* let hidden = 1 *)\nlet rec fact n = n\nlet value = 3\ntype t = A | B\nmodule M = struct end\n`, "ocaml")).toEqual(["function fact", "variable value", "type t", "module M"]);
    expect(sym(`-module(srv).\n-record(state, {a}).\nstart() -> ok.\nstart(X) -> X.\nloop(S) -> S.\n`, "erlang")).toEqual(["module srv", "struct state", "function start", "function start", "function loop"]);
    expect(sym(`(ns my.app)\n(defn foo [x] x)\n(defn- bar [] 1)\n(def answer 42)\n(defprotocol P (m [x]))\n`, "clojure")).toEqual(["module my.app", "function foo", "function bar", "variable answer", "interface P"]);
    expect(sym(`(defun add (a b) (+ a b))\n(defvar *x* 1)\n(defclass point () ())\n(define (sq x) x)\n`, "lisp")).toEqual(["function add", "variable *x*", "class point", "function sq"]);
  });
  it("fortran, pascal, vb, perl, objective-c, batch", () => {
    expect(sym(`program demo\nend program demo\nsubroutine calc(x)\nend subroutine\nreal function f(x)\nend function f\nmodule m\nend module m\n`, "fortran")).toEqual(["module demo", "function calc", "function f", "module m"]);
    expect(sym(`unit U;\n{ procedure hidden; }\nprocedure Foo;\nfunction TBar.Baz: Integer;\n`, "pascal")).toEqual(["module U", "function Foo", "method TBar.Baz"]);
    expect(sym(`Public Class Frm\n  Private Sub Go()\n  End Sub\n  ' Sub rem()\n  Public Function Calc() As Integer\n  End Function\nEnd Class\n`, "vb")).toEqual(["class Frm", "method Go", "method Calc"]);
    expect(sym(`package Foo::Bar;\nsub new { }\n=pod\nsub in_pod\n=cut\nsub run { }\n`, "perl")).toEqual(["module Foo::Bar", "function new", "function run"]);
    expect(sym(`@interface Foo : NSObject\n- (void)run;\n+ (instancetype)make:(int)a with:(int)b;\n@end\n@implementation Foo\n- (void)run { [self go]; }\n@end\nint main(int c) { return 0; }\n`, "objectivec")).toEqual(["class Foo", "method run", "method make:with:", "class Foo", "method run", "function main"]);
    expect(sym(`@echo off\n:: comment\n:main\ngoto end\n:end\n`, "batch")).toEqual(["function main", "function end"]);
  });
  it("nginx, protobuf, graphql, cmake, vue", () => {
    expect(full(`http {\n  server {\n    location /api {\n      proxy_pass x;\n    }\n  }\n}\n`, "nginx")).toEqual(["section http@1:0", "section server@2:1", "section location /api@3:2"]);
    expect(sym(`syntax = "proto3";\npackage a.b;\nmessage Req { string q = 1; }\nenum E { A = 0; }\nservice S {\n  rpc Get(Req) returns (Req);\n}\n`, "protobuf")).toEqual(["module a.b", "struct Req", "enum E", "interface S", "method Get"]);
    expect(sym(`# type Hidden\ntype User {\n  id: ID!\n}\nenum Role { A }\nquery GetUser { user { id } }\n`, "graphql")).toEqual(["type User", "enum Role", "function GetUser"]);
    expect(sym(`# function(x)\nfunction(helper arg)\nendfunction()\nadd_executable(app main.c)\n`, "cmake")).toEqual(["function helper", "module app"]);
    expect(full(`<template>\n  <div/>\n</template>\n<script>\nexport default {\n  name: "x",\n}\nfunction util() {}\n</script>\n<style scoped>\n</style>\n`, "vue")).toEqual(["section <template@1:0", "section <script@4:0", "function util@8:0", "section <style scoped@10:0"]);
  });
});

describe("limits and robustness", () => {
  it("returns nothing for languages without an outline", () => {
    for (const id of ["plaintext", "json", "xml", "log", "unknown"]) expect(extractSymbols("function x() {}\n# h", id)).toEqual([]);
    expect(hasSymbols("python")).toBe(true);
    expect(hasSymbols("plaintext")).toBe(false);
  });
  it("handles empty input and CRLF", () => {
    expect(extractSymbols("", "javascript")).toEqual([]);
    expect(sym("function a() {}\r\nfunction b() {}\r\n", "javascript")).toEqual(["function a", "function b"]);
    expect(sym("# One\r\n## Two\r\n", "markdown")).toEqual(["heading One", "heading Two"]);
  });
  it("skips very long lines and caps the symbol count", () => {
    const long = "function " + "x".repeat(600) + "() {}\nfunction ok() {}\n";
    expect(sym(long, "javascript")).toEqual(["function ok"]);
    const many = Array.from({ length: 8000 }, (_, i) => `function f${i}() {}`).join("\n");
    expect(extractSymbols(many, "javascript")).toHaveLength(MAX_SYMBOLS);
  });
  it("survives unbalanced braces", () => {
    expect(() => extractSymbols("}\n}\n}\nfunction a() {\n", "javascript")).not.toThrow();
    expect(sym("}\n}\nfunction a() {}\n", "javascript")).toEqual(["function a"]);
  });
  it("every reported kind is a known kind", () => {
    const kinds: SymbolKind[] = ["function", "class", "method", "struct", "enum", "interface", "trait", "module", "type", "heading", "constant", "section", "selector", "table", "variable"];
    for (const s of extractSymbols("class A:\n  def f(self): pass\nX = 1\n", "python")) expect(kinds).toContain(s.kind);
  });
});

describe("performance", () => {
  const block = (lang: string): string => {
    switch (lang) {
      case "javascript":
        return `export function fn$N(a, b) {\n  const x = a + b; // note\n  if (x > 1) { return call(x, "str"); }\n  return [1, 2, 3].map((v) => v * 2);\n}\nclass C$N {\n  m$N(x) {\n    return x;\n  }\n}\n`;
      case "python":
        return `def fn$N(a, b):\n    x = a + b  # note\n    if x > 1:\n        return call(x, "str")\n    return [v * 2 for v in (1, 2, 3)]\n\nclass C$N:\n    def m(self):\n        return 1\n\n`;
      case "cpp":
        return `int fn$N(int a, char *b) {\n  int x = a + b[0]; // note\n  if (x > 1) { return call(x, "str"); }\n  return 0;\n}\nclass C$N {\n public:\n  void m(int x) { use(x); }\n};\n`;
      default:
        return `# Heading $N\n\nSome text with words and "quotes".\n\n- item one\n- item two\n\n`;
    }
  };
  for (const lang of ["javascript", "python", "cpp", "markdown"]) {
    it(`extracts from a 2 MB ${lang} file in under 150 ms`, () => {
      const b = block(lang);
      let text = "";
      for (let i = 0; text.length < 2_000_000; i++) text += b.replaceAll("$N", String(i));
      extractSymbols(text.slice(0, 100000), lang); // warm up
      const t0 = performance.now();
      const out = extractSymbols(text, lang);
      const dt = performance.now() - t0;
      expect(out.length).toBeGreaterThan(100);
      expect(dt).toBeLessThan(150);
    });
  }
});
