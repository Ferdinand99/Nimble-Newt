import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// examples/nn02-check is installed by the owner in the real app to check the sandbox. It must never be able to send
// anything off the machine, even if the sandbox failed.
const dir = new URL("../../examples/nn02-check/", import.meta.url);
const main = readFileSync(new URL("main.js", dir), "utf8");
const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as { permissions: string[]; main: string };

describe("examples/nn02-check", () => {
  it("only ever targets 127.0.0.1", () => {
    expect(main).toMatch(/var HOST = "127\.0\.0\.1:59871";/);
    // Every URL is a scheme followed by HOST; there is no other host name or address in the script.
    const urls = [...main.matchAll(/(?:https?|wss?):\/\/[^\s"')]*/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u, u).toMatch(/^(?:https?|wss?):\/\/$/);
    for (const m of main.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) expect(m[0]).toBe("127.0.0.1");
    expect(main).not.toMatch(/localhost|0\.0\.0\.0|\.(?:com|net|org|io|dev)\b/i);
    // And each one is followed by + HOST.
    expect(main.match(/(?:https?|wss?):\/\/" \+ HOST/g)?.length).toBe(urls.length);
  });
  it("asks for nothing but showing the result", () => {
    expect(manifest.permissions).toEqual(["ui"]);
    expect(manifest.main).toBe("main.js");
  });
});
