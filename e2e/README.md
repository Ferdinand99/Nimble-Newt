# End-to-end check of the extension sandbox

`sandbox.spec.ts` loads the real sandbox document (the output of `sandboxDocument` in `src/ext/document.ts`, which is
what the app stages) in a sandboxed iframe with an opaque origin, served with the real CSP header (read from
`src-tauri/src/sandbox.rs`). It runs a hostile extension in it, plus the three built-in extensions, in **Chromium and
WebKit**, the engines behind WebView2 and WKWebView. A sink on 127.0.0.1 (TCP and UDP) records anything that reaches it
and must stay empty. A control run with a looser policy must reach the sink, so the check cannot pass by accident.

It does not run the app itself, so the `nnext` scheme in the real webviews is not covered. For that, install
`examples/nn02-check` in the app on macOS and Windows (see its README).

## Run it

In CI it is the job `Sandbox (Playwright, Chromium and WebKit)`; it installs only those two browsers.

Locally, with the browsers installed:

```
npm ci
npx playwright install chromium webkit
npm run test:sandbox
```

or without installing anything, in the Playwright image (use the tag that matches `@playwright/test` in package.json):

```
docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.60.0-noble \
  sh -c "npm ci --ignore-scripts && npm run test:sandbox"
```

Set `NN_E2E_VERBOSE=1` to print what every attempt of the hostile extension did.

The payloads are in `e2e/payloads/`: `attack.js` (every way out it could think of, aimed at the sink), `spin.js` (commands that
never return or take a while), `evade.js` (answering a command early and then looping, a loop left behind by a finished
command, a long synchronous step, forged messages) and `toplevel.js` (a loop at the top level). The attack runs twice, with
the real worker bootstrap and without its lockdown part, so the policy is shown to hold on its own.
