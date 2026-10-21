# Notepad++ parity: status

Branch: `feature/notepad-parity` (one branch, no PR yet). This file is the hand-over note between sessions:
what is done, what remains, and where to continue. Measurements are from the Linux/Xvfb sandbox
(`scripts/measure.sh`); the Windows and macOS numbers come from the CI job summaries.

## Baseline (before this branch, release build, Linux/Xvfb)

| | |
|---|---|
| Binary | 8.73 MB |
| JS + CSS in `dist/` | 1.09 MB raw / 375 KB gzip |
| Entry chunk | 466 KB raw / 150 KB gzip |
| Start-up, empty profile | about 2.1 s |
| Start-up, existing profile | about 0.61 s |

## After phase 4 (same method)

| | Baseline | Now |
|---|---|---|
| Binary | 8.73 MB | 10.76 MB (+2.0 MB: 26 languages embedded for the native menu, encodings, diff, hashes, zip, large files) |
| JS + CSS in `dist/` | 1.09 MB raw / 375 KB gzip | 2.43 MB raw / 793 KB gzip (mostly lazy chunks: 96 languages, 25 locales, tools, compare, extensions) |
| Entry chunk | 466 KB raw / 150 KB gzip | 543 KB raw / 175 KB gzip |
| Start-up, empty profile | about 2.1 s | about 2.0 s |
| Start-up, existing profile | about 0.61 s | about 0.64 s |

## Done

- Phase 0: `latest.json` notes, `Cargo.lock` handling, language guessed from content.
- Phase 1: about 100 languages (lazy) and custom languages, macros, bookmarks, five highlight colours, column editing with number sequences, line operations, word completion (setting, lazy), function list.
- Phase 2: 35 legacy code pages with detection, follow file, large-file reader in Rust (indexed, chunked) with a read-only virtual-scrolling viewer, search and go to line.
- Phase 3: compare (live, apply per hunk; Rust diff for large inputs), split view of the same file, minimap, tools panel (JSON/XML, Base64/URL/HTML/hex, checksums, timestamps, UUIDs), folder as workspace.
- Phase 4: sandboxed extensions (design in `docs/extensions.md`; Rust manager in `crates/core/src/extensions.rs`; JS host in `src/ext/`; Extensions sheet; three built-in examples) and 26 interface languages with right-to-left support and a coverage test.

## Known limits

- Split view mirrors the active tab; two different tabs side by side use the compare view.
- The large-file viewer is read-only; UTF-16 files are not supported there.
- Compare above about 2 M characters shows a hunk list instead of a side-by-side editor.
- Extension shortcuts are only proposed (never bound automatically); no catalogue; no panels or access to other files.
- Built-in extension texts are in English and Norwegian only; other languages see English.
- The 24 new translations are machine-written and unreviewed by native speakers.
- Start-up is about 0.64 s in the Linux sandbox, not under 300 ms; Windows/macOS numbers are in the CI summaries.
- Not tested on a real Windows or macOS machine, only through CI.

## Next steps

1. Native-speaker review of the translations; extend extension texts to more languages.
2. Extension panels and a read-only `workspace.read` permission (see the open questions in `docs/extensions.md`).
3. Editing in the large-file viewer; UTF-16 there.
4. Reduce the entry chunk (move the English table and rarely used editor extensions behind lazy imports).
