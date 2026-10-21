// Puts the release's changelog into latest.json (`notes`), which the in-app update dialog shows.
// tauri-action leaves `notes` empty when it uploads to an existing release, so the release workflow
// runs this on the downloaded latest.json before the draft is published.
//
//   node scripts/update-notes.mjs latest.json release-body.md latest.new.json

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Returns a copy of the manifest with `notes` set from the release body (kept as is when the body is empty). */
export function withNotes(latest, body) {
  const notes = (body ?? "").replace(/\r\n/g, "\n").trim();
  if (!latest || typeof latest !== "object" || typeof latest.version !== "string") {
    throw new Error("latest.json has no version; refusing to touch it");
  }
  return notes ? { ...latest, notes } : { ...latest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , latestPath, bodyPath, outPath] = process.argv;
  if (!latestPath || !bodyPath || !outPath) {
    console.error("usage: update-notes.mjs latest.json release-body.md out.json");
    process.exit(2);
  }
  const out = withNotes(JSON.parse(readFileSync(latestPath, "utf8")), readFileSync(bodyPath, "utf8"));
  if (!out.notes) console.warn("warning: the release body is empty, so the update dialog will have no changelog");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
}
