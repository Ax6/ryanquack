import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./tmp/playwright",
  projects: [
    { name: "chromium-extension", testMatch: "chromium.spec.ts", use: { browserName: "chromium" } },
    { name: "firefox-extension", testMatch: "firefox.spec.ts" },
    { name: "webkit-tab", testMatch: "webkit.spec.ts", use: { browserName: "webkit" } },
  ],
  webServer: [
    { command: "node test-server/server.mjs", url: "http://localhost:3000" },
    {
      command: "python3 -m http.server 43173 --bind 127.0.0.1 --directory dist/safari",
      url: "http://127.0.0.1:43173/src/popup/popup.html",
    },
  ],
});
