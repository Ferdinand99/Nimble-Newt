import { describe, expect, it } from "vitest";
import { toolBlockedOnLarge } from "./largeTools";

describe("toolBlockedOnLarge", () => {
  it("blocks every text tool on a large file tab", () => {
    for (const id of ["tools.jsonFormat", "tools.base64Encode", "tools.hash", "tools.insertUuid", "tools.insertTimestamp", "tools.timestamp"]) {
      expect(toolBlockedOnLarge(id, true), id).toBe(true);
    }
  });
  it("lets the panel and file checksums work, because they don't touch the tab's text", () => {
    expect(toolBlockedOnLarge("tools.panel", true)).toBe(false);
    expect(toolBlockedOnLarge("tools.hashFile", true)).toBe(false);
  });
  it("never blocks on normal tabs", () => {
    expect(toolBlockedOnLarge("tools.jsonFormat", false)).toBe(false);
  });
});
