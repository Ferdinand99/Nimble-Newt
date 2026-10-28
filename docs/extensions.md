# Extensions: design

Status: design note and first implementation (version 1 of the API). Nothing here is a promise about a store or
an ecosystem; it is the smallest safe foundation that lets people add commands and text tools.

## Goals and non-goals

- Let someone add **commands, menu items and text operations** with a few lines of JavaScript.
- **Safe by construction.** An extension is data and sandboxed script. It never runs native code, never touches the
  file system or the network, and can only do what its manifest asked for and the user allowed.
- **Cheap when unused.** No extension code is loaded at start-up. Manifests are read after the first paint and an
  extension's script starts the first time one of its commands runs.
- Non-goals for v1: UI panels, language servers, native plugins (DLL/dylib), access to files or processes, a store.

## Threat model

Extensions are written by third parties and may be hostile or buggy. The protection layers, from the outside in:

1. **No native code.** The Rust side only parses manifests and reads files from the extension's own folder. Nothing in
   an extension package is ever executed by the OS. (This rules out Notepad++-style DLL plugins on purpose.)
2. **A sandboxed iframe with a Web Worker inside, per extension.** The extension's script does not run in the iframe's
   window at all. The iframe is `<iframe sandbox="allow-scripts" src=...>` without `allow-same-origin`, so it has an
   opaque origin: no access to the app's DOM, storage, cookies or Tauri IPC. It runs only our own bootstrap, which starts
   a **dedicated Web Worker** from a `blob:` URL (the worker bootstrap that defines `nimble`, followed by the
   extension's script) and passes the well-formed messages between the worker and the app on. The document is **served
   by the app from its own URI scheme (`nnext`)** with the header
   `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; worker-src blob:`, and the same policy as a
   meta tag in the document (the two policies apply together, so both must allow the worker). Nothing else is opened:
   there is no `connect-src`, `frame-src` or `img-src`, and `worker-src` is only `blob:`. An iframe with an inline
   document would inherit the app's own CSP and its inline scripts would be blocked in a release build, and the app CSP
   deliberately does not allow `'unsafe-inline'` for scripts; it only lists the scheme in `frame-src`.
   **The CSP is the primary barrier.** The sandbox policy is enforced from parsing on and cannot be removed by script,
   and a worker inherits it: `fetch`, XHR, WebSocket, EventSource, WebTransport, `importScripts`, `import()` and
   workers from any other URL are all refused, so the code has no way out except `postMessage` to the host. Both
   WebView2 (Chromium) and WKWebView (WebKit) enforce `sandbox` and CSP. The scheme only serves documents the app
   itself staged a moment before, under unguessable ids; everything else is a 404.
   **Defence in depth in the worker.** Before the extension's script runs, the worker bootstrap removes `fetch`,
   `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `importScripts`, `Worker`, `SharedWorker` and
   `navigator.sendBeacon` from the worker's global and its prototype chain (they become non-configurable getters that
   return `undefined`), so the script has no reference to them. `import()` is syntax and cannot be removed, so the
   policy alone refuses it. A worker that the extension managed to create anyway would be **confined**: it can exist,
   but it inherits the same policy and has no WebRTC. Nothing depends on the lockdown alone: the end-to-end check also
   runs without it, and the sink still sees nothing.
   **Why a worker (NN-02).** Content Security Policy does not govern WebRTC, and the webview does not let the app
   switch it off. In a window, a script can always get `RTCPeerConnection` back from a fresh child frame, so an
   extension with `editor.read` could have sent text out through ICE/STUN/TURN traffic. A worker has **no WebRTC**
   (`RTCPeerConnection` only exists in `Window`; `RTCDataChannel` exists but cannot be constructed), **no DOM** and
   cannot create frames, so there is no child frame to recover the constructors from. This was checked in Chromium and
   WebKit with a hostile extension and a listener on 127.0.0.1: nothing arrived (see the end-to-end check below).
   **The extension shares the worker with our bootstrap**, so it can listen to every message, answer early, forge
   messages and loop. Nothing relies on its good behaviour: the iframe passes on only a well-formed request, reply,
   `ready` or `error` event (everything else the worker sends, including a forged `timeout`, `worker-failed`,
   `unresponsive`, `hold` or pong, is dropped), the app validates every message again and counts every one against the
   rate limit, and the iframe stops a worker that does not answer its heartbeat (see **Limits**).
   **What an extension can use.** Extension code has no `window` or `document`, because it runs in a worker. The
   language and the usual worker globals are there: `setTimeout`/`setInterval`, `Promise`, `JSON`, `TextEncoder`,
   `URL`, `crypto.getRandomValues` and so on. The network APIs listed above are not.
   **Browser versions.** The app runs on the system webview: Microsoft Edge WebView2 on Windows 10/11 (the evergreen
   runtime; the repository pins no minimum) and WKWebView on macOS 11 or later (`minimumSystemVersion` 11.0). The design
   needs blob workers and the CSP directive `worker-src`. A webview without `worker-src` falls back to `child-src`, then
   to `script-src`, which does not allow `blob:`, so the worker does not start and the extension fails to start with an
   error; it does not run unconfined. Which WebView2 and WKWebView versions have been tried by hand is not recorded
   here (the end-to-end check runs Playwright's Chromium 148 and WebKit 26.4).
3. **A small message API with permissions.** The host answers only messages from that iframe's window, validates every
   argument and checks the call against the permissions in the manifest *and* the user's consent. Unknown methods fail.
4. **Limits.** Script size (1 MB), manifest size (16 KB), package size (5 MB, 200 files), message size (4 MB), a call
   rate (200 messages/s from the sandbox, of any kind, not only calls) and two clocks that really stop a runaway
   script, because they end with `worker.terminate()`, which stops even `while (true) {}` at once:
   - **A timeout for command handlers (10 s).** The iframe owns the clock. The app keeps its own, 2 s longer clock as a
     backstop in case the iframe never reports. Both stand still while a dialog drawn by the app for `ui.prompt` or
     `ui.pick` waits for the user.
   - **A heartbeat.** The command clock cannot see a script that answers its command early (the extension can read
     the command's id from its own message listener) and then loops, nor a loop at the top level, nor one left behind
     by a command that finished. So every 2 s the iframe pings the worker with a fresh random nonce, the worker
     bootstrap answers from a listener registered before the extension's script is parsed, and a ping that is still
     unanswered after 5 s (plus a grace of 250 ms) gets the worker terminated and the app told. A stuck worker does
     not read its queue, so the extension cannot answer for it, and the nonce is new for every ping, so a pong it has
     seen is no use for the next one. The result: a script that blocks the worker is stopped within about 8 seconds,
     wherever it blocks, and a long but legitimate synchronous step of up to about 5 s is left alone (steps should be
     asynchronous anyway). The heartbeat does not pause for dialogs: a worker that waits for the app is idle and
     answers.
   - Not covered: a script that keeps the worker responsive but busy (for example a loop that yields with
     `setTimeout`) or that uses a lot of memory. That is CPU and memory use, out of scope here; the user can disable the
     extension.

   A misbehaving extension is terminated (its iframe is destroyed) and disabled until the user turns it back on.
5. **User consent.** Installing shows the requested permissions in plain language; the user can disable or remove an
   extension at any time (Extensions… in the command palette).

What this does **not** protect against: an extension that does something unwanted *with the permissions it was
given* (for example rewriting the document it was asked to edit). Permissions are therefore narrow and named.
Browser side channels (timing, CPU use) are out of scope; the timeout and the kill switch limit the damage.

### Checking the sandbox

- `npm run test:sandbox` (Playwright, in `e2e/`) loads the real sandbox document in Chromium and WebKit, served with the
  real CSP header and in an iframe with an opaque origin, and runs a hostile extension in it: `fetch` (also `keepalive`
  and `no-cors`), XHR, WebSocket, EventSource, WebTransport, `importScripts`, `import()`, workers (also nested),
  `sendBeacon` and WebRTC. A listener on 127.0.0.1 (TCP and UDP) must see nothing, with the lockdown and also without it
  (the policy alone), and a control run with a looser policy must get through, so the test cannot pass by accident. It
  also checks that the network APIs are `undefined` for the extension, that `terminate()` ends an endless loop, that a
  script which answers its command early and then loops, loops at the top level, or loops after a finished command is
  terminated by the heartbeat and the app told, that a step of 1.2 s that blocks the worker is left alone, that forged
  messages do nothing, and that the three built-in extensions still work. It runs in CI as its own job.
- `examples/nn02-check` is an extension to install in the real app on macOS and Windows, which the automated check
  cannot cover (the `nnext` scheme in WKWebView and WebView2). It shows green when everything is blocked. See its README.

## Package format

An extension is a folder (or a `.nnext` file, which is a zip of that folder) with a `manifest.json` and a script:

```
hello/
  manifest.json
  main.js
```

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "Says hello.",
  "author": "Ada Lovelace",
  "minAppVersion": "0.2.0",
  "main": "main.js",
  "permissions": ["editor.read", "ui"],
  "contributes": {
    "commands": [{ "id": "sayHi", "title": "Say hi", "shortcut": "CmdOrCtrl+Alt+H" }],
    "menus": [{ "command": "sayHi", "menu": "tools" }]
  }
}
```

Rules (checked by the Rust validator, with tests): `id` is reverse-DNS style, `^[a-z0-9]+(\.[a-z0-9-]+)+$`, at most 64
characters; `version` is semver; `main` is a plain file name in the folder; `permissions` come from the list below; command
ids are local (`sayHi`) and become `ext:<id>:<command>` in the app; titles are 1-60 characters; menus are `tools` or
`edit`; at most 50 commands. Unknown manifest fields are rejected.

## Permissions (v1)

| Permission | Allows |
|---|---|
| `editor.read` | read the text, the selection, the language and the file name of the active tab |
| `editor.write` | replace the selection or the whole text, insert text (one undoable change each) |
| `ui` | show a message (toast), ask for a line of text or a choice with a host-drawn dialog |
| `clipboard.write` | put text on the clipboard |
| `storage` | a small key-value store of its own (64 KB per key, 1 MB total) |

There is deliberately no permission for files, network, processes, other extensions or app settings. Adding one later
needs a design of its own.

## The API inside the sandbox

A global `nimble` object, every call returns a promise:

```js
nimble.commands.register("sayHi", async () => {
  const sel = await nimble.editor.getSelection();          // { text, ranges: [{ from, to }] }
  await nimble.ui.message(`You selected ${sel.text.length} characters`);
});
nimble.editor.getText(); nimble.editor.getLanguage(); nimble.editor.getFileName();
nimble.editor.replaceSelection(text); nimble.editor.replaceAll(text); nimble.editor.insertText(text);
nimble.ui.message(text, kind?); nimble.ui.prompt({ title, placeholder, value }); nimble.ui.pick({ title, items });
nimble.clipboard.writeText(text);
nimble.storage.get(key); nimble.storage.set(key, value); nimble.storage.remove(key);
```

Wire format (app <-> sandbox, `postMessage`, JSON only): `{ id, method, params }` requests and `{ id, result | error }`
replies; the app starts a command with `{ id, method: "command.run", params: { command, context } }`. The iframe passes
these between the app and the worker on if they are well-formed (error text is cut to 300 characters), and the app
validates every message. Besides these there are a few
messages between the iframe and the app: `{ event: "ready" }`, `{ event: "error", message }`,
`{ event: "worker-failed", message }` (the worker could not start or its script does not parse),
`{ event: "timeout", id }` (the iframe terminated the worker because a command ran too long),
`{ event: "unresponsive" }` (the iframe terminated the worker because it did not answer its heartbeat) and, from the
app, `{ control: "hold" | "release" }` to pause and resume the command clock. Only `ready` and `error` events, requests
and replies can come from the worker; the iframe drops anything else it sends (see the threat model). The bootstrap
scripts (src/ext/bootstrap.ts) are the only code of ours in the sandbox: the iframe bootstrap relays and keeps the
clocks, the worker bootstrap answers the heartbeat, removes the network APIs and defines the frozen `nimble` object.

## Lifecycle

1. At start-up (after the first paint) the app lists installed extensions and reads their manifests. Their commands appear
   in the palette and menus; the scripts are **not** loaded.
2. The first time one of its commands runs, the host stages the sandbox document (with the script inside), creates the
   iframe, which starts the worker, and waits for the script to register its handlers (timeout 5 s), then runs the command.
3. If the worker fails to start or to parse, is too slow, or stops answering its heartbeat (the worker is terminated), the
   iframe is destroyed and the extension is disabled with a message.
4. Disabling or removing an extension destroys its iframe immediately and removes its commands from the palette.

## Installation and updates

- Installed extensions live in `<app data>/extensions/<id>/`. The Rust side installs from a folder or a `.nnext` zip:
  it extracts into a temporary folder with strict limits (no `..`, no absolute paths, no symlinks, no more than 200 files,
  5 MB), validates the manifest, then moves it into place (replacing an older version of the same id).
- **Updates in v1 are manual** (install the newer package over the old one; the version must be higher). Consent is asked
  again when the new version requests more permissions.
- Built-in examples ship with the app (not on disk) and use the same sandbox and API.

## Decisions taken and open questions

Taken, with the safest option as the default (tell me if you want any of them changed):

- No network access for extensions in v1. Hosts allow-lists are a possible later permission (`net:host`).
- No marketplace in v1; people share `.nnext` files or folders. A later store should be a plain signed index on GitHub
  (reusing the minisign setup of the app updater), with updates verified the same way.
- Extensions cannot add keyboard shortcuts silently: a manifest shortcut is only proposed; it is active when it does not
  clash with an app shortcut and the user confirms it at install time. (v1 implements the proposal, not the remapping UI.)

Open, to decide before widening the API:

- Whether to ever allow UI panels (side panels with sandboxed HTML). That needs a second sandbox kind.
- Whether extensions may read other files in the workspace folder (a `workspace.read` permission with a clear prompt).

## Built-in examples (v1)

- **Word Count**: words, characters and lines of the selection or the document (`editor.read`, `ui`).
- **Markdown Helpers**: bold, italic, inline code, link and blockquote the selection (`editor.read`, `editor.write`).
- **Text Cleaner**: slugify the selection, straighten smart quotes, collapse spaces (`editor.read`, `editor.write`).
