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
| NN-02 | Medium | Extensions can send data out through WebRTC from the sandbox iframe | Fixed: extensions run in a Web Worker (ships in 0.3.0) |
| NN-03 | Low | Replace in folder wrote lossily decoded files and had no modification-time check | Fixed in #27 |
| NN-04 | Low | Folder search was quadratic on long lines | Fixed in #27 |
| NN-05 | Low | Extension timeouts depend on host timers; storage rate; `ui.*` calls outside commands | Partly fixed: the timeout now terminates the worker, also for a script that tries to hide from it (ships in 0.3.0). Open: the storage rate and `ui.*` calls outside commands |
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

### What was changed for NN-02 and the timeout part of NN-05

- **NN-02, fixed.** The content security policy does not govern `RTCPeerConnection` and the webview cannot switch
  WebRTC off, and a script in the sandbox window could always recover the constructors from a fresh child frame, so an
  extension granted `editor.read` could have sent text out. The extension script now runs in a dedicated **Web
  Worker** inside the sandbox iframe. A worker has no WebRTC, no DOM and cannot create frames, and it inherits the
  sandbox policy `default-src 'none'; script-src 'unsafe-inline'; worker-src blob:` (header and meta tag), so nothing
  else is opened either. The app still validates every message; the wire format is unchanged. See
  [extensions.md](extensions.md).
- **NN-05, timeout part, fixed.** The command timeout is now kept by the sandbox iframe, which calls
  `worker.terminate()` when a handler overruns, so a loop that never ends is stopped for real. The app keeps its own
  clock as a backstop and both stand still while a dialog drawn by the app waits for the user.
  A hostile script shares the worker with our bootstrap, so it can read the command's id, answer early (which clears
  that clock) and then loop, or loop at the top level. A **heartbeat** closes this: every 2 s the iframe pings the worker
  with a fresh random nonce, the worker bootstrap answers from a listener registered before the extension runs, and a
  ping unanswered for 5 s gets the worker terminated and the app told. A script that blocks the worker is stopped within
  about 8 seconds; a legitimate synchronous step shorter than about 5 s is left alone. A script that stays responsive but
  busy, or uses a lot of memory, is not covered (CPU and memory use are out of scope).
- **Hardening in the same change.** The iframe passes on only a well-formed request, reply, `ready` or `error` event
  from the worker, so a script cannot forge the iframe's own `timeout`, `worker-failed`, `unresponsive` or `hold`
  messages. The app counts every message from the sandbox against the rate limit, not only calls, and checks events and
  replies strictly. The worker bootstrap also removes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `WebTransport`, `importScripts`, `Worker`, `SharedWorker` and `navigator.sendBeacon` before the extension runs. That is
  defence in depth: the content security policy remains the barrier, and the end-to-end check also passes without
  the removal. The blob URL of the worker is revoked once the worker has started.
- **Evidence.** A hostile extension tried `fetch` (also `keepalive` and `no-cors`), XHR, WebSocket, EventSource,
  WebTransport, `importScripts`, `import()`, nested and other workers, `sendBeacon` and WebRTC against a listener
  on 127.0.0.1, in Playwright Chromium 148 and WebKit 26.4. The listener saw nothing; a control run with a looser policy
  reached it, so the test is real. This is now `npm run test:sandbox`, which runs in CI. It does not cover the app's
  own `nnext` scheme in WKWebView and WebView2, so `examples/nn02-check` is an extension to install in the real app on
  macOS and Windows, which shows green when everything is blocked.
- **Breaking for a few extensions.** Extension code has no `window` or `document` any more. The `nimble` v1 API
  never promised a DOM and is unchanged; `setTimeout`, `Promise` and `JSON` are still there.

## Accepted and open items

- **NN-05, remainder, open.** The rate limit on extension storage writes (`storage.set`) is loose, and `ui.*` calls
  are allowed outside commands. Awaiting an owner decision. (The timeout part is fixed, see above.)
- **NN-06, remainder, open.** The update version is not part of the signed data, and the signing key reaches the
  build action as a repository secret. The recommendation is to run the signing job in a GitHub environment named
  `release` with required reviewers and move the key secrets there; it is not applied because adding the environment
  without moving the secrets would break signing.
- **NN-07, remainder, open.** The extension install check compares the manifest only, session buffers are plaintext on
  disk, one helper in the UI code is easy to misuse, some test hooks are present in release builds, and code
  signing is optional (see [signing](signing.md)). Informational.

## Not covered

- Dynamic behaviour of the sandbox in the review itself: it was reviewed by reading the design and code. The NN-02 fix
  was tested dynamically afterwards (see above) in Chromium and WebKit, not in the app's own webviews.
- Platform differences in WebView2 and WKWebView beyond what the documentation states.
- Dependency audits and the release pipeline beyond the workflow files.
- Translations.

## Notes for users

Fixes for NN-01, NN-03 and NN-04 are in 0.2.2; the NN-02 fix and the timeout part of NN-05 are in 0.3.0. See the [releases page](https://github.com/Ferdinand99/Nimble-Newt/releases) and
[updates](updates.md).

- Replace in folder now skips files that are not valid in their detected encoding and tells you which ones; it also
  refuses files that changed after the preview, so run the search again.
- Opening a FIFO, device or directory as a file is refused.
- Extensions: from 0.3.0 their code runs in a Web Worker, which closes the WebRTC route (NN-02). Extensions that used
  `window` or `document` stop working. Before 0.3.0, be careful with any extension that has the `editor.read`
  permission.
