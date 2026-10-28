# NN-02 check

A test extension for the Nimble Newt extension sandbox. It tries the usual ways to get data out of the sandbox and
shows one message: green when everything was blocked, red with a list when something got through.

What it tries, all against `127.0.0.1` on port 59871 and nothing else: `fetch` (also `no-cors` and `keepalive`),
`XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `importScripts`, `import()`, `sendBeacon`, workers from
an `http:` and a `data:` URL, a worker made inside the extension (with `fetch`, `WebSocket` and WebRTC), and WebRTC in
the extension's own scope. It also reports when it runs in a window instead of a Worker, which is how the old sandbox
(before 0.3.0) would fail it.

## Check it in the real app (macOS and Windows)

1. Optional: open a terminal and run `python -m http.server 59871 --bind 127.0.0.1`. Anything that reaches the port
   would show up in its log.
2. In Nimble Newt open the command palette, choose **Extensions…**, then **Install from folder…** and pick this
   folder (`examples/nn02-check`). Accept the install sheet; it asks for nothing except showing a message.
3. Run **NN-02 check** from the **Tools** menu or the command palette.
4. Expect a green toast starting with `NN-02 check: all blocked. Runs in a worker, no WebRTC`.
5. If you started the Python server, its log must still be empty.

Run it on both macOS (WKWebView) and Windows (WebView2). The automated end-to-end check (`npm run test:sandbox`)
covers Chromium and WebKit with the same sandbox document, but not the app's own `nnext` scheme in each webview; this
manual check does.

A red message lists what got through. In that case do not trust extensions you have not read, and please report it with
the list and your platform.

## Notes

- The extension asks only for `ui` (to show the result). The sandbox does not depend on the permissions, so it
  tests the same limits that apply to an extension that can read your text.
- A "not present" note for an API (for example `WebTransport` or `sendBeacon` in a worker) is fine: an API that does not
  exist cannot send anything.
- Remove it afterwards in **Extensions…**.
