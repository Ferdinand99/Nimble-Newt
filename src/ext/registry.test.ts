import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtin";
import { isExtensionCommand, splitCommandId } from "./registry";

describe("registry", () => {
  it("splits extension command ids and rejects look-alikes", () => {
    expect(splitCommandId("ext:app.wordcount:count")).toEqual({ ext: "app.wordcount", command: "count" });
    expect(splitCommandId("ext:com.example.my-ext:doIt_2")).toEqual({ ext: "com.example.my-ext", command: "doIt_2" });
    for (const bad of ["file.save", "ext:", "ext:a:b", "ext:app.x:", "ext:app.x:1bad", "ext:app.x:a:b", "ext:../x:y"]) expect(splitCommandId(bad), bad).toBeNull();
    expect(isExtensionCommand("ext:app.wordcount:count")).toBe(true);
    expect(isExtensionCommand("edit.undo")).toBe(false);
  });
});

describe("built-in extensions", () => {
  it("follow the same rules as installed ones", () => {
    const ids = new Set<string>();
    for (const e of BUILTIN) {
      const m = e.manifest;
      expect(m.id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.commands.length).toBeGreaterThan(0);
      for (const c of m.commands) {
        expect(c.id).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
        expect(c.title.length).toBeLessThanOrEqual(60);
        expect(c.titleNb.length).toBeLessThanOrEqual(60);
        // every declared command is registered by the script
        expect(e.code).toContain(`register("${c.id}"`);
      }
      expect(() => new Function(e.code)).not.toThrow(); // syntax check only; it is not run here
    }
  });
  it("request only the permissions they use", () => {
    for (const e of BUILTIN) {
      const usesWrite = /nimble\.editor\.(replace|insert)/.test(e.code);
      const usesRead = /nimble\.editor\.get/.test(e.code);
      const usesUi = /nimble\.ui\./.test(e.code);
      expect(e.manifest.permissions.includes("editor.write")).toBe(usesWrite);
      expect(e.manifest.permissions.includes("editor.read")).toBe(usesRead);
      expect(e.manifest.permissions.includes("ui")).toBe(usesUi);
    }
  });
});
