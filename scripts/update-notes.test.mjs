import { describe, expect, it } from "vitest";
import { withNotes } from "./update-notes.mjs";

const latest = { version: "0.2.0", notes: "", pub_date: "2026-01-01T00:00:00Z", platforms: { "windows-x86_64": { signature: "s", url: "u" } } };

describe("withNotes", () => {
  it("copies the release body into notes and keeps everything else", () => {
    const out = withNotes(latest, "## 0.2.0\r\n\r\n* Faster start\r\n");
    expect(out.notes).toBe("## 0.2.0\n\n* Faster start");
    expect(out.platforms).toEqual(latest.platforms);
    expect(out.version).toBe("0.2.0");
    expect(latest.notes).toBe("");
  });
  it("keeps existing notes when the body is empty", () => {
    expect(withNotes({ ...latest, notes: "old" }, "  \n").notes).toBe("old");
    expect(withNotes(latest, undefined).notes).toBe("");
  });
  it("refuses something that is not a manifest", () => {
    expect(() => withNotes({}, "x")).toThrow();
    expect(() => withNotes(null, "x")).toThrow();
  });
});
