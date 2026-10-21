import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conf = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { security: { csp: string } } };
const directives = Object.fromEntries(
  conf.app.security.csp.split(";").map((d) => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name, values];
  }),
) as Record<string, string[]>;

describe("app CSP", () => {
  it("never allows inline or eval scripts", () => {
    const scripts = [...(directives["script-src"] ?? []), ...(directives["default-src"] ?? [])];
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });
  it("lets the app frame only the extension sandbox scheme (macOS/Linux and Windows forms)", () => {
    expect(directives["frame-src"]).toEqual(["nnext:", "http://nnext.localhost", "https://nnext.localhost"]);
  });
  it("sandbox documents are loaded with src, never srcdoc (a srcdoc frame inherits the app CSP)", () => {
    const code = readFileSync(new URL("./sandbox.ts", import.meta.url), "utf8");
    expect(code).not.toMatch(/srcdoc\s*:/);
    expect([...code.matchAll(/sandbox:\s*"([^"]*)"/g)].map((m) => m[1])).toEqual(["allow-scripts"]);
  });
});
