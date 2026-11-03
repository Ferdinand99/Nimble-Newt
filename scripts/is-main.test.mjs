import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMain } from "./is-main.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("isMain", () => {
  it("is true for the same file", () => {
    const here = new URL("./is-main.mjs", import.meta.url);
    expect(isMain(here.href, fileURLToPath(here))).toBe(true);
  });
  it("is false for another file, no argument and a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ismain-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.mjs"), "");
    writeFileSync(join(dir, "b.mjs"), "");
    expect(isMain(pathToFileURL(join(dir, "a.mjs")).href, join(dir, "b.mjs"))).toBe(false);
    expect(isMain(pathToFileURL(join(dir, "a.mjs")).href, undefined)).toBe(false);
    expect(isMain(pathToFileURL(join(dir, "a.mjs")).href, join(dir, "missing.mjs"))).toBe(false);
  });
  it("is true when the script is started through a link", () => {
    const dir = mkdtempSync(join(tmpdir(), "ismain-"));
    dirs.push(dir);
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "s.mjs"), "");
    try {
      symlinkSync(join(dir, "real"), join(dir, "link"), "junction");
    } catch {
      return; // links not allowed here: nothing to test
    }
    const real = realpathSync(join(dir, "real", "s.mjs"));
    expect(isMain(pathToFileURL(real).href, join(dir, "link", "s.mjs"))).toBe(true);
  });
});
