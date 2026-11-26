import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build as esbuild } from "esbuild";
import { defineConfig, configDefaults, type Plugin } from "vitest/config";
import { crx } from "@crxjs/vite-plugin";
import manifestChrome from "./src/manifests/manifest.chrome.json";
import manifestFirefox from "./src/manifests/manifest.firefox.json";

const manifestSafari = {
  ...manifestChrome,
  // App Store Connect rejects Safari extension descriptions longer than 112 characters.
  description: "Fetch, display, and download your Ryanair boarding passes in Safari. Privacy-focused and open source.",
  permissions: manifestChrome.permissions.filter((permission) => permission !== "downloads"),
  browser_specific_settings: {
    safari: {
      strict_min_version: "16.4",
    },
  },
};

const target = process.env.TARGET || "chrome";
const isMock = process.env.MOCK === "true";
const manifest =
  target === "firefox"
    ? manifestFirefox
    : target === "safari"
      ? manifestSafari
      : manifestChrome;
const outDir = `dist/${target}`;

const defines = {
  API_BOARDING_PASS_URL: JSON.stringify(isMock ? "http://localhost:3000" : "https://mntappbp.ryanair.com"),
  API_DOWNLOAD_PASS_URL: JSON.stringify(isMock ? "http://localhost:3000" : "https://mawbp.ryanair.com"),
  API_GOOGLE_WALLET_URL: JSON.stringify(isMock ? "http://localhost:3000" : "https://mgpbp.ryanair.com"),
  API_ORDERS_URL: JSON.stringify(isMock ? "http://localhost:3000" : "https://services-api.ryanair.com"),
  CACHE_TTL_MS: String(isMock ? 60_000 : 60 * 60 * 1000),
  GOOGLE_WALLET_SAVE_URL: JSON.stringify(isMock ? "http://localhost:3000/google-wallet/save" : "https://pay.google.com/gp/v/save"),
};

/**
 * Safari rejects CRXJS's ES-module service_worker loader (`type: "module"`).
 * Bundle the background entrypoint as a single classic IIFE script and switch
 * Safari's emitted manifest to a non-persistent event page (`scripts` + `persistent: false`).
 */
function safariClassicBackground(): Plugin {
  return {
    name: "safari-classic-background",
    apply: "build",
    async closeBundle() {
      await esbuild({
        entryPoints: ["src/background/index.ts"],
        bundle: true,
        format: "iife",
        target: "safari16.4",
        minify: true,
        define: defines,
        outfile: join(outDir, "background.js"),
      });

      rmSync(join(outDir, "service-worker-loader.js"), { force: true });

      const manifestPath = join(outDir, "manifest.json");
      const built = JSON.parse(readFileSync(manifestPath, "utf8"));
      built.background = { scripts: ["background.js"], persistent: false };
      if (Array.isArray(built.web_accessible_resources)) {
        for (const entry of built.web_accessible_resources) {
          delete entry.use_dynamic_url;
        }
      }
      writeFileSync(manifestPath, JSON.stringify(built, null, 2) + "\n");
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), ...(target === "safari" ? [safariClassicBackground()] : [])],
  define: {
    ...defines,
    CACHE_TTL_MS: isMock ? 60_000 : 60 * 60 * 1000,
  },
  build: {
    outDir,
    emptyOutDir: true,
  },
  test: {
    dir: "src",
    // Worktrees checked out inside the repo carry their own copy of the suite,
    // which vitest would otherwise collect alongside the real one.
    exclude: [...configDefaults.exclude, "**/.claude/**", "e2e/**"],
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
