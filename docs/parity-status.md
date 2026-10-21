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

## Phase 0: fixes

- [x] `latest.json` notes: the publish job copies the release body into `notes` (`scripts/update-notes.mjs`, tested).
- [x] `Cargo.lock`: removed from release-please `extra-files`; a `lockfile` job refreshes it on the release PR branch.
- [x] Language guessed from the content for tabs without a file name (`src/lib/guess.ts`, 30 tests).

## Phase 1: editing and languages

- [x] About 100 languages, lazy-loaded; custom languages in JSON/TOML (import/export, validated in Rust).
- [x] Macros (record, play, N times, to end of file, named macros).
- [x] Bookmarks (gutter, navigate, copy/cut/delete bookmarked or unmarked lines, bookmark matches of Find), stored in the session.
- [x] Highlight all occurrences in five colours.
- [ ] Column editing with number sequences: dialog done, to be wired and tested end to end.
- [ ] Line operations (sort, dedupe, trim, case, join/split) wired to commands and menus.
- [ ] Word completion wired and switchable in settings.
- [ ] Function list (outline) panel.

## Phase 2: encodings and large files

- [x] 35 legacy code pages (ISO-8859-x, Windows-125x, KOI8, Shift_JIS, EUC-JP/KR, GBK/GB18030, Big5, ISO-2022-JP) with better detection.
- [x] Follow file (`tail -f`) for normal tabs.
- [ ] Large-file reader in Rust (chunked, indexed) and a read-only virtual-scrolling viewer with search and go to line.

## Phase 3: compare and tools

- [ ] Compare two files/tabs.
- [ ] Split view and minimap.
- [ ] Tools panel (JSON/XML format and minify, Base64/URL/HTML, hashes, timestamps, UUID).
- [ ] Folder as workspace.

## Phase 4: extensions and UI languages

- [ ] Extension design note and a first API with example extensions.
- [ ] 26 UI languages with a 100 % coverage test.
