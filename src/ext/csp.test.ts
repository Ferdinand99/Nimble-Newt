import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSrcdoc, SANDBOX_CSP } from "./protocol";

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

const parse = (csp: string): Record<string, string[]> =>
  Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );

describe("sandbox document CSP", () => {
  // The scheme handler in Rust sends it as a header, buildSrcdoc repeats it as a meta tag. A document is governed by
  // both, so the worker is only allowed if both say `worker-src blob:`.
  const rust = readFileSync(new URL("../../src-tauri/src/sandbox.rs", import.meta.url), "utf8");
  const header = /pub const CSP: &str = "([^"]*)";/.exec(rust)?.[1] ?? "";

  it("the header (Rust) and the meta tag (TypeScript) are the same policy", () => {
    expect(header).not.toBe("");
    expect(header).toBe(SANDBOX_CSP);
  });
  it("opens nothing but inline script and blob workers", () => {
    expect(parse(SANDBOX_CSP)).toEqual({
      "default-src": ["'none'"],
      "script-src": ["'unsafe-inline'"],
      "worker-src": ["blob:"],
    });
  });
  it("never opens the network, frames or images", () => {
    for (const bad of ["connect-src", "frame-src", "child-src", "img-src", "font-src", "media-src", "object-src", "style-src", "'unsafe-eval'", "'self'", "*", "http:", "https:", "data:", "ws:", "wss:"]) {
      expect(SANDBOX_CSP, bad).not.toContain(bad);
    }
  });
  it("the document carries the policy as a meta tag, before any script", () => {
    const doc = buildSrcdoc("", "");
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
  });
});
