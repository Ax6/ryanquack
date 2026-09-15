// Proves the scannable part of a boarding pass is unchanged by our edits.
//
// It renders the SAME fixture pass through two builds — a reference checkout and
// this one — and compares the Aztec pixels from both render paths: the live
// "Show Ticket" canvas and the exported PNG. A passing run means the code the
// gate scanner reads is byte-for-byte what the reference produced.
//
// Usage:
//   git worktree add --detach /tmp/rq-ref <ref>      # e.g. the last released tag
//   cp dev/popup-harness.html /tmp/rq-ref/dev/
//   (cd /tmp/rq-ref && npm ci && npm run build:chrome && python3 -m http.server 8766 &)
//   npm run build:chrome && python3 -m http.server 8765 &
//   node dev/aztec-regression.mjs
//
// Needs playwright available (npx playwright ...); it is not a project dependency.

import { chromium } from "playwright";
import { createHash } from "node:crypto";

const browser = await chromium.launch();

async function probe(port) {
  const page = await browser.newPage({ viewport: { width: 500, height: 900 } });
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  // capture the exported PNG before its blob URL is revoked
  await page.addInitScript(() => {
    window.__captured = null;
    const wait = setInterval(() => {
      if (window.chrome?.downloads) {
        clearInterval(wait);
        const real = window.chrome.downloads.download;
        window.chrome.downloads.download = (opts, cb) => {
          window.__captured = fetch(opts.url).then(r => r.arrayBuffer())
            .then(b => Array.from(new Uint8Array(b)));
          return real(opts, cb);
        };
      }
    }, 10);
  });
  await page.goto(`http://localhost:${port}/dev/popup-harness.html?passes=1`);
  await page.waitForSelector(".pass", { timeout: 15000 });

  // 1. Show Ticket -> Aztec rendered at scale 3 into .aztec-canvas
  await page.click('button[data-action="qr"]');
  await page.waitForSelector(".aztec-canvas canvas", { timeout: 15000 });
  const live = await page.evaluate(() => {
    const c = document.querySelector(".aztec-canvas canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, bytes: Array.from(d) };
  });

  // 2. Save Image -> full ticket PNG; crop the Aztec square (logical 100..400 x 350..650, 3x scale)
  await page.click("#btn-save");
  await page.waitForFunction(() => window.__captured !== null, { timeout: 15000 });
  const png = await page.evaluate(() => window.__captured);
  const region = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext("2d").drawImage(bmp, 0, 0);
    const s = 3, x = 100 * s, y = 350 * s, size = 300 * s;
    const d = cv.getContext("2d").getImageData(x, y, size, size).data;
    return { w: bmp.width, h: bmp.height, bytes: Array.from(d) };
  }, png);

  await page.close();
  const h = (a) => createHash("sha256").update(Buffer.from(a)).digest("hex").slice(0, 16);
  return { errs, liveSize: `${live.w}x${live.h}`, liveHash: h(live.bytes),
           pngSize: `${region.w}x${region.h}`, aztecHash: h(region.bytes) };
}

const main = await probe(8766);
const branch = await probe(8765);
console.log("REFERENCE (8766)", JSON.stringify(main));
console.log("THIS BUILD (8765)", JSON.stringify(branch));
console.log("");
console.log("Show Ticket Aztec identical:", main.liveHash === branch.liveHash);
console.log("Exported Aztec identical:   ", main.aztecHash === branch.aztecHash);
console.log("Exported PNG same size:     ", main.pngSize === branch.pngSize);
await browser.close();

const ok = main.liveHash === branch.liveHash && main.aztecHash === branch.aztecHash;
process.exit(ok ? 0 : 1);
