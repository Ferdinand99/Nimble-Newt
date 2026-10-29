# Changelog

## [0.3.1](https://github.com/Ferdinand99/Nimble-Newt/compare/v0.3.0...v0.3.1) (2026-10-29)


### Bug Fixes

* security review backlog ([#32](https://github.com/Ferdinand99/Nimble-Newt/issues/32)) ([0a629d8](https://github.com/Ferdinand99/Nimble-Newt/commit/0a629d8d0c15fabedc30bd0b4b1338fa082eeb9c))

## [0.3.0](https://github.com/Ferdinand99/Nimble-Newt/compare/v0.2.2...v0.3.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* extension code now runs in a Web Worker, so it has no `window` or `document`. Extensions that used them stop working. The nimble v1 API is unchanged, and setTimeout, Promise and JSON stay available.

### Bug Fixes

* run extensions in a worker so they have no way out (NN-02) ([#30](https://github.com/Ferdinand99/Nimble-Newt/issues/30)) ([cd2449d](https://github.com/Ferdinand99/Nimble-Newt/commit/cd2449defa511192bedfa907fb03b173d8d5ddc5))

## [0.2.2](https://github.com/Ferdinand99/Nimble-Newt/compare/v0.2.1...v0.2.2) (2026-10-27)


### Bug Fixes

* security hardening from the October review ([#27](https://github.com/Ferdinand99/Nimble-Newt/issues/27)) ([ca6f2e9](https://github.com/Ferdinand99/Nimble-Newt/commit/ca6f2e9086f1c69eb0bf4e89791d2f6ac7a580cd))

## [0.2.1](https://github.com/Ferdinand99/Nimble-Newt/compare/v0.2.0...v0.2.1) (2026-10-24)


### Bug Fixes

* **deps:** update tokio (RUSTSEC-2026-0384), Dependabot and a weekly audit ([645b07b](https://github.com/Ferdinand99/Nimble-Newt/commit/645b07b95b5dee1d24e335bfec9548ec44339bec))

## [0.2.0](https://github.com/Ferdinand99/Nimble-Newt/compare/v0.1.0...v0.2.0) (2026-10-21)


### Features

* 26 interface languages with right-to-left support ([80fec37](https://github.com/Ferdinand99/Nimble-Newt/commit/80fec374e3fd6624da90b86362031c966bd3bcb0))
* 35 legacy code pages, follow file and a viewer for multi-gigabyte files ([80fec37](https://github.com/Ferdinand99/Nimble-Newt/commit/80fec374e3fd6624da90b86362031c966bd3bcb0))
* about 100 syntax languages, user-defined languages, macros, bookmarks, highlights, column editing, line operations, word completion and function list ([80fec37](https://github.com/Ferdinand99/Nimble-Newt/commit/80fec374e3fd6624da90b86362031c966bd3bcb0))
* compare files and tabs, split view, minimap and folder workspace ([80fec37](https://github.com/Ferdinand99/Nimble-Newt/commit/80fec374e3fd6624da90b86362031c966bd3bcb0))
* sandboxed extensions with permissions and three built-in examples ([80fec37](https://github.com/Ferdinand99/Nimble-Newt/commit/80fec374e3fd6624da90b86362031c966bd3bcb0))
* tools panel (JSON/XML, encodings, checksums, timestamps, UUIDs) ([80fec37](https://github.com/Ferdinand99/Nimble-Newt/commit/80fec374e3fd6624da90b86362031c966bd3bcb0))


### Bug Fixes

* never lose characters silently when saving in a legacy encoding ([80fec37](https://github.com/Ferdinand99/Nimble-Newt/commit/80fec374e3fd6624da90b86362031c966bd3bcb0))
* show the changelog in the update dialog ([80fec37](https://github.com/Ferdinand99/Nimble-Newt/commit/80fec374e3fd6624da90b86362031c966bd3bcb0))

## 0.1.0 (2026-10-21)


### Features

* first version of Nimble Newt ([#1](https://github.com/Ferdinand99/Nimble-Newt/issues/1)) ([69a09d0](https://github.com/Ferdinand99/Nimble-Newt/commit/69a09d09bed63e154350040eeceba12a664e7248))


### Miscellaneous Chores

* release 0.1.0 ([ffb1723](https://github.com/Ferdinand99/Nimble-Newt/commit/ffb1723fed97450d18af9dfc2a502f3e851fbdda))
