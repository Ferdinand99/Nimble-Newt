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
2. **A sandboxed iframe per extension.** The script runs in `<iframe sandbox="allow-scripts" src=...>` without
   `allow-same-origin`, so it has an opaque origin: no access to the app's DOM, storage, cookies or Tauri IPC. The
   document is **served by the app from its own URI scheme (`nnext`)** with the header
   `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'` (and the same policy as a meta tag). An
   iframe with `srcdoc` would inherit the app's own CSP and its inline scripts would be blocked in a release build, and
   the app CSP deliberately does not allow `'unsafe-inline'` for scripts; it only lists the scheme in `frame-src`.
   The sandbox policy is enforced from parsing on and cannot be removed by script: `fetch`, XHR, WebSocket, images,
   fonts, media and `import()` are all blocked, so the code has no way out except `postMessage` to the host. Both
   WebView2 (Chromium) and WKWebView (WebKit) enforce `sandbox` and CSP. The scheme only serves documents the app
   itself staged a moment before, under unguessable ids; everything else is a 404.
   **Known gap: WebRTC.** Content Security Policy does not govern `RTCPeerConnection`, and the webview does not let the
   app switch WebRTC off. The bootstrap removes the WebRTC constructors from the sandbox window as defence in depth,
   but a script can get them back from a fresh child frame, so WebRTC is **not** reliably blocked. An extension that
   was granted `editor.read` could therefore try to send text out through ICE/STUN/TURN traffic. This is why
   `editor.read` is shown prominently in the consent sheet and why extensions have no marketplace in v1: only install
   extensions you trust. Closing the gap needs a webview-level setting that Tauri does not expose today.
3. **A small message API with permissions.** The host answers only messages from that iframe's window, validates every
   argument and checks the call against the permissions in the manifest *and* the user's consent. Unknown methods fail.
4. **Limits.** Script size (1 MB), manifest size (16 KB), package size (5 MB, 200 files), message size (4 MB), call
   rate (200 calls/s) and a **timeout** for command handlers (10 s). A misbehaving extension is terminated (its iframe
   is destroyed) and disabled until the user turns it back on.
5. **User consent.** Installing shows the requested permissions in plain language; the user can disable or remove an
   extension at any time (Extensions… in the command palette).

What this does **not** protect against: an extension that does something unwanted *with the permissions it was
given* (for example rewriting the document it was asked to edit). Permissions are therefore narrow and named.
Browser side channels (timing, CPU use) are out of scope; the timeout and the kill switch limit the damage.

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

Wire format (host <-> iframe, `postMessage`, JSON only): `{ id, method, params }` requests and `{ id, result | error }`
replies; the host starts a command with `{ id, method: "command.run", params: { command, context } }`.
The bootstrap script that defines `nimble` is part of the srcdoc and is the only code written by us in there.

## Lifecycle

1. At start-up (after the first paint) the app lists installed extensions and reads their manifests. Their commands appear
   in the palette and menus; the scripts are **not** loaded.
2. The first time one of its commands runs, the host creates the iframe, sends the script and waits for it to register
   its handlers (timeout 5 s), then runs the command.
3. If the iframe fails the timeout, crashes or is too slow, it is destroyed and the extension is disabled with a message.
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
