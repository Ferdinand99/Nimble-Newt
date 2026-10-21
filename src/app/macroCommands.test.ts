import { describe, expect, it } from "vitest";
import { COMMAND_DEFS, MACRO_COMMANDS, MACRO_NOT_RECORDED } from "./commandDefs";

describe("which commands macros record", () => {
  it("leaves out commands that ask the user a question (they would prompt on every pass)", () => {
    for (const id of ["lineop.splitAt", "lineop.prefix", "lineop.suffix"]) {
      expect(COMMAND_DEFS.some((c) => c.id === id), id).toBe(true);
      expect(MACRO_COMMANDS.has(id), id).toBe(false);
    }
  });
  it("tells the user about every command that is run while recording but left out", () => {
    expect([...MACRO_NOT_RECORDED].sort()).toEqual(["lineop.prefix", "lineop.splitAt", "lineop.suffix"]);
    for (const id of MACRO_NOT_RECORDED) expect(MACRO_COMMANDS.has(id), id).toBe(false);
  });
  it("records Find Next and Find Previous", () => {
    expect(MACRO_COMMANDS.has("edit.findNext")).toBe(true);
    expect(MACRO_COMMANDS.has("edit.findPrev")).toBe(true);
  });
});
