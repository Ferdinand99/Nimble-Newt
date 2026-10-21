/** True when the backend refused a save because the encoding cannot represent some characters. */
export function isLossy(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { kind?: unknown }).kind === "lossy";
}

export type LossyChoice = "utf8" | "anyway" | "cancel";

/** What to do after the user answered the "characters don't fit" sheet; `null` writes nothing. */
export function lossyPlan(choice: LossyChoice): { encoding: "UTF-8" | null; allowLossy: boolean } | null {
  switch (choice) {
    case "utf8":
      return { encoding: "UTF-8", allowLossy: false };
    case "anyway":
      return { encoding: null, allowLossy: true };
    default:
      return null;
  }
}
