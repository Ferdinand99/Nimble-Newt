import { defineConfig } from "@playwright/test";

// The end-to-end check of the extension sandbox (e2e/). Chromium and WebKit are the engines behind WebView2 and WKWebView.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  retries: 0,
  fullyParallel: true,
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
