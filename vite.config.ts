import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
  test: { environment: "node", include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"] },
});
