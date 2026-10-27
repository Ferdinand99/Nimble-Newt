# Security review, October 2026

Date: 27 October 2026. Covers Nimble Newt up to the 0.2.2 release.

## Method and limits

This was a read-only code review done by an AI reviewer. It was not an external audit and it was not done by a
professional security firm. The reviewer read the code and rated each finding; NN-01 was verified in the code. The
fixes were written with tests and merged after review. Nothing was run as a pen test: there was no dynamic testing of
the app or the extension sandbox, and no fuzzing. The test suites ran in Docker (`cargo fmt`, `clippy`, `cargo test`,
and the TypeScript typecheck, lint and tests).

Treat this as one careful review, not as a guarantee.

## Scope

`main` at `0f6a668`: the Rust core (file I/O, search, sessions, extension storage), the Tauri shell and its
capabilities, the extension sandbox and installer, the updater, and the CI and release workflows. No High finding was
reported.

Found solid: minimal Tauri capabilities (no shell, filesystem, HTTP or opener access from the webview), a strict
content security policy, the extension sandbox design, zip and directory extraction (zip-slip, symlinks, modes,
sizes), large-file handling, linear-time regex, and update signature checking over https.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| NN-01 | Medium | Predictable temporary file name in atomic saves; a planted symlink made a save overwrite another file | Fixed in #27 |
| NN-02 | Medium | Extensions can send data out through WebRTC from the sandbox iframe | Open. Known gap, documented; a sandbox redesign is planned |
| NN-03 | Low | Replace in folder wrote lossily decoded files and had no modification-time check | Fixed in #27 |
| NN-04 | Low | Folder search was quadratic on long lines | Fixed in #27 |
| NN-05 | Low | Extension timeouts depend on host timers; storage rate; `ui.*` calls outside commands | Open. Owner decision pending |
| NN-06 | Low | Update version not covered by the signature; actions pinned by tag; signing key exposed to the build action | Partly fixed in #27 (actions pinned to commit SHAs). Open: the rest |
| NN-07 | Info | `extract_zip` panic, install check, FIFOs, plaintext session buffers, `h()` helper trap, test hooks in release builds, optional signing | Partly fixed in #27 (the panic and non-regular files). The other notes are open |

### What was changed (#27)

- **NN-01.** Atomic saves use a random temporary name created with `create_new`, which fails on anything already
  there, links included. Permissions of an existing target are copied onto the open handle. The same helper backs
  replace in files, the session store and extension storage.
- **NN-03.** Replace in folder skips files that decode lossily (reported to the user) and refuses files changed since
  the preview.
- **NN-04.** Search finds each line's end once, cuts previews to 200 characters and lists at most 1000 matches per
  file. Replace still touches every match in a selected file, including matches beyond the 1000 shown.
- **NN-06 (part).** Every action in `.github/workflows` is pinned to a full commit SHA.
- **NN-07 (part).** `extract_zip` returns an error instead of panicking when an archive holds `top` and
  `top/manifest.json`. Opening, comparing, hashing and the large-file viewer refuse anything that is not a regular
  file (FIFOs, devices, directories).

## Accepted and open items

- **NN-02, WebRTC exfiltration, open.** The content security policy does not govern `RTCPeerConnection` and the
  webview cannot switch WebRTC off, so an extension granted `editor.read` could try to send text out. The bootstrap
  removes the constructors as defence in depth, but a script can recover them from a fresh child frame. This is
  described in [extensions.md](extensions.md). A redesign of the sandbox is planned. Until then, install only
  extensions you trust.
- **NN-05, extension limits, open.** The timeout of extension command handlers depends on host timers, the rate limit
  on extension storage writes (`storage.set`) is loose, and `ui.*` calls are allowed outside commands. Awaiting an
  owner decision.
- **NN-06, remainder, open.** The update version is not part of the signed data, and the signing key reaches the
  build action as a repository secret. The recommendation is to run the signing job in a GitHub environment named
  `release` with required reviewers and move the key secrets there; it is not applied because adding the environment
  without moving the secrets would break signing.
- **NN-07, remainder, open.** The extension install check compares the manifest only, session buffers are plaintext on
  disk, one helper in the UI code is easy to misuse, some test hooks are present in release builds, and code
  signing is optional (see [signing](signing.md)). Informational.

## Not covered

- Dynamic behaviour: the extension sandbox was reviewed by reading the design and code, not attacked with a running
  build, and no network capture was made.
- Platform differences in WebView2 and WKWebView beyond what the documentation states.
- Dependency audits and the release pipeline beyond the workflow files.
- Translations.

## Notes for users

Fixes are in 0.2.2. See the [releases page](https://github.com/Ferdinand99/Nimble-Newt/releases) and
[updates](updates.md).

- Replace in folder now skips files that are not valid in their detected encoding and tells you which ones; it also
  refuses files that changed after the preview, so run the search again.
- Opening a FIFO, device or directory as a file is refused.
- Extensions: see the WebRTC note above before installing any extension with the `editor.read` permission.
