import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifestChrome from "./src/manifests/manifest.chrome.json";
import manifestFirefox from "./src/manifests/manifest.firefox.json";

const target = process.env.TARGET || "chrome";
const isMock = process.env.MOCK === "true";
const manifest = target === "firefox" ? manifestFirefox : manifestChrome;
const outDir = `dist/${target}`;

export default defineConfig({
  plugins: [crx({ manifest })],
  define: {
    API_BOARDING_PASS_URL: JSON.stringify(isMock ? "http://localhost:3000" : "https://mntappbp.ryanair.com"),
    API_DOWNLOAD_PASS_URL: JSON.stringify(isMock ? "http://localhost:3000" : "https://mawbp.ryanair.com"),
    API_ORDERS_URL: JSON.stringify(isMock ? "http://localhost:3000" : "https://services-api.ryanair.com"),
    CACHE_TTL_MS: isMock ? 60_000 : 60 * 60 * 1000,
  },
  build: {
    outDir,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
