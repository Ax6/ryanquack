import { chromium, expect, test as base, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expectPassZip, expectPkpass, expectPng } from "./downloads";

const test = base.extend({
  page: async ({}, use, info) => {
    const extension = resolve("dist/chrome");
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try {
      const payload = Buffer.from(JSON.stringify({ sub: "e2e-customer" })).toString("base64url");
      await context.addCookies([{
        url: "https://www.ryanair.com", name: "SESSION_COOKIE", value: `mock.${payload}.mock`,
      }]);
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const page = await context.newPage();
      // chrome.downloads is browser-managed. Redirect its files into a per-test folder.
      const downloadPath = info.outputPath("downloads");
      mkdirSync(downloadPath, { recursive: true });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath });
      await page.goto(new URL("/src/popup/popup.html", worker.url()).href);
      await use(page);
    } finally {
      await context.close();
    }
  },
});

async function completedExtensionDownload(page: Page) {
  let filename = "";
  await expect.poll(async () => {
    filename = await page.evaluate(async () => {
      const items = await chrome.downloads.search({ state: "complete" });
      return items.find(item => item.byExtensionId === chrome.runtime.id)?.filename ?? "";
    });
    return filename;
  }).not.toBe("");
  return filename;
}

test("loads both checked-in passengers through the background worker", async ({ page }) => {
  await expect(page.locator(".pass .pass-title")).toHaveText([
    "AAANB3 · STN → KRK · Alex Smith", "AAAV3J · DUB → ALC · Sam Murphy",
  ]);
});

test("Show Ticket paints an Aztec canvas", async ({ page }) => {
  await page.getByRole("button", { name: "Show Ticket" }).first().click();
  const canvas = page.locator(".aztec-canvas canvas");
  await expect(canvas).toBeVisible();
  const colors = await canvas.evaluate((c: HTMLCanvasElement) => {
    const { data } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    const pixels = new Uint32Array(data.buffer);
    return { black: pixels.includes(0xff000000), white: pixels.includes(0xffffffff) };
  });
  expect(colors).toEqual({ black: true, white: true });
});

test("Save Image downloads the passenger's PNG", async ({ page }) => {
  await page.getByRole("button", { name: "Show Ticket" }).first().click();
  await page.getByRole("button", { name: "Save Image" }).click();
  expectPng(await completedExtensionDownload(page));
});

test("Download Apple Wallet Pass downloads the passenger's .pkpass", async ({ page }) => {
  await page.getByRole("button", { name: "Download Apple Wallet Pass" }).first().click();
  expectPkpass(await completedExtensionDownload(page));
});

test("Download All downloads both passengers' PNG and wallet files", async ({ page }) => {
  await page.getByRole("button", { name: "Download All Passes" }).click();
  expectPassZip(await completedExtensionDownload(page));
});

test("Add to Google Wallet opens the save tab with the mock token", async ({ page }) => {
  const popup = page.context().waitForEvent("page");
  await page.getByRole("button", { name: "Add to Google Wallet" }).first().click();
  const walletTab = await popup;
  await walletTab.waitForLoadState("domcontentloaded");
  expect(walletTab.url()).toBe("http://localhost:3000/google-wallet/save/mock-google-wallet-token");
  await expect(walletTab.locator("body")).toContainText("Token: mock-google-wallet-token");
});

test("Copy Image succeeds without uncaught popup errors", async ({ page }) => {
  await page.getByRole("button", { name: "Show Ticket" }).first().click();
  await page.getByRole("button", { name: "Copy Image" }).click();
  await expect(page.locator("#status")).toContainText("Copied to clipboard");
  expect(await page.pageErrors()).toEqual([]);
});

test("shows clickable Ryanair.com login link when logged out", async ({ page }) => {
  await page.context().clearCookies();
  await page.evaluate(() => chrome.storage.local.clear());
  await page.reload();
  await expect(page.locator("#status")).toHaveText("Please log in to Ryanair.com 🔒");
  const link = page.locator("#status a.status-link");
  await expect(link).toHaveAttribute("href", "https://www.ryanair.com/");
});
