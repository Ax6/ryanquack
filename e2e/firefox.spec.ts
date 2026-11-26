import { expect, test as base } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Builder, By, until, type WebDriver } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { expectPassZip, expectPkpass, expectPng } from "./downloads";

interface FirefoxFixture {
  driver: WebDriver;
  popupUrl: string;
}

const test = base.extend<FirefoxFixture>({
  popupUrl: "",
  driver: async ({}, use, info) => {
    // Marionette requires system access to read Firefox's dynamically assigned
    // moz-extension:// UUID for the temporary add-on and grant MV3 host origins.
    process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";

    const downloadPath = info.outputPath("downloads");
    mkdirSync(downloadPath, { recursive: true });

    const options = new firefox.Options()
      .addArguments("-headless")
      .setPreference("browser.download.folderList", 2)
      .setPreference("browser.download.dir", downloadPath)
      .setPreference("browser.download.useDownloadDir", true)
      .setPreference("browser.download.manager.showWhenStarting", false);

    const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
    try {
      const addonId = await driver.installAddon(resolve("dist/firefox"), true);

      await driver.setContext(firefox.Context.CHROME);
      const uuid = await driver.executeAsyncScript<string>(`
        const [addonId, done] = arguments;
        (async () => {
          const { ExtensionPermissions } = ChromeUtils.importESModule(
            "resource://gre/modules/ExtensionPermissions.sys.mjs"
          );
          await ExtensionPermissions.add(addonId, {
            permissions: [],
            origins: [
              "https://*.ryanair.com/*",
              "https://mntappbp.ryanair.com/*",
              "https://mawbp.ryanair.com/*",
              "https://mgpbp.ryanair.com/*",
              "http://localhost:3000/*",
            ],
          });
          const uuids = JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids", "{}"));
          done(uuids[addonId] || "");
        })().catch((err) => done("ERR:" + String(err)));
      `, addonId);
      await driver.setContext(firefox.Context.CONTENT);

      if (!uuid || uuid.startsWith("ERR:")) {
        throw new Error(`Could not resolve Firefox extension UUID: ${uuid}`);
      }

      const popupUrl = `moz-extension://${uuid}/src/popup/popup.html`;
      await driver.get(popupUrl);
      await driver.wait(until.elementLocated(By.id("status")), 10_000);

      // Seed Ryanair's session cookie via the extension's own cookies API.
      const payload = Buffer.from(JSON.stringify({ sub: "e2e-customer" })).toString("base64url");
      await driver.executeAsyncScript(`
        const [value, done] = arguments;
        browser.cookies.set({
          url: "https://www.ryanair.com/",
          name: "SESSION_COOKIE",
          value,
        }).then(() => done(null), (err) => done(String(err)));
      `, `mock.${payload}.mock`);

      // Reload so the popup fetches passes with the seeded cookie and attach an error trap.
      await driver.get(popupUrl);
      await driver.wait(until.elementLocated(By.css(".pass .pass-title")), 10_000);
      await driver.executeScript(`
        window.__e2eErrors = [];
        window.addEventListener("error", (e) => window.__e2eErrors.push(String(e.message || e.error)));
        window.addEventListener("unhandledrejection", (e) => window.__e2eErrors.push(String(e.reason)));
      `);

      await use(driver);
    } finally {
      await driver.quit();
    }
  },
});

async function completedExtensionDownload(driver: WebDriver): Promise<string> {
  let filename = "";
  await expect.poll(async () => {
    filename = await driver.executeAsyncScript<string>(`
      const done = arguments[arguments.length - 1];
      browser.downloads.search({ state: "complete" })
        .then((items) => done(items[0]?.filename ?? ""))
        .catch(() => done(""));
    `);
    return filename;
  }, { timeout: 10_000 }).not.toBe("");
  return filename;
}

async function clickButtonByText(driver: WebDriver, text: string) {
  const buttons = await driver.findElements(By.css("button"));
  for (const button of buttons) {
    if ((await button.getText()).trim() === text) {
      await button.click();
      return;
    }
  }
  throw new Error(`Button not found: ${text}`);
}

test("loads both checked-in passengers through the Firefox background script", async ({ driver }) => {
  const titles = await driver.executeScript<string[]>(
    `return Array.from(document.querySelectorAll(".pass .pass-title"), (el) => el.textContent?.trim() ?? "");`
  );
  expect(titles).toEqual([
    "AAANB3 · STN → KRK · Alex Smith",
    "AAAV3J · DUB → ALC · Sam Murphy",
  ]);
});

test("Show Ticket paints an Aztec canvas", async ({ driver }) => {
  await clickButtonByText(driver, "Show Ticket");
  await driver.wait(until.elementLocated(By.css(".aztec-canvas canvas")), 10_000);
  const colors = await driver.executeScript<{ black: boolean; white: boolean }>(`
    const c = document.querySelector(".aztec-canvas canvas");
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    const pixels = new Uint32Array(data.buffer);
    return { black: pixels.includes(0xff000000), white: pixels.includes(0xffffffff) };
  `);
  expect(colors).toEqual({ black: true, white: true });
});

test("Save Image downloads the passenger's PNG", async ({ driver }) => {
  await clickButtonByText(driver, "Show Ticket");
  await driver.wait(until.elementLocated(By.id("btn-save")), 10_000);
  await driver.findElement(By.id("btn-save")).click();
  expectPng(await completedExtensionDownload(driver));
});

test("Download Apple Wallet Pass downloads the passenger's .pkpass", async ({ driver }) => {
  await clickButtonByText(driver, "Download Apple Wallet Pass");
  expectPkpass(await completedExtensionDownload(driver));
});

test("Download All downloads both passengers' PNG and wallet files", async ({ driver }) => {
  await clickButtonByText(driver, "Download All Passes");
  expectPassZip(await completedExtensionDownload(driver));
});

test("Add to Google Wallet opens the save tab with the mock token", async ({ driver }) => {
  const beforeHandles = await driver.getAllWindowHandles();
  await clickButtonByText(driver, "Add to Google Wallet");

  let newHandle = "";
  await expect.poll(async () => {
    const handles = await driver.getAllWindowHandles();
    newHandle = handles.find((h) => !beforeHandles.includes(h)) ?? "";
    return newHandle;
  }, { timeout: 10_000 }).not.toBe("");

  await driver.switchTo().window(newHandle);
  await expect.poll(() => driver.getCurrentUrl(), { timeout: 10_000 })
    .toBe("http://localhost:3000/google-wallet/save/mock-google-wallet-token");
  const body = await driver.findElement(By.css("body")).getText();
  expect(body).toContain("Token: mock-google-wallet-token");
});

test("Copy Image succeeds without uncaught popup errors", async ({ driver }) => {
  await clickButtonByText(driver, "Show Ticket");
  await driver.wait(until.elementLocated(By.id("btn-copy")), 10_000);
  await driver.findElement(By.id("btn-copy")).click();
  await expect.poll(async () => (await driver.findElement(By.id("status")).getText()).trim(), { timeout: 10_000 })
    .toContain("Copied to clipboard");
  const errors = await driver.executeScript<string[]>("return window.__e2eErrors || [];");
  expect(errors).toEqual([]);
});

test("shows clickable Ryanair.com login link when logged out", async ({ driver }) => {
  await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    Promise.all([
      browser.cookies.remove({ url: "https://www.ryanair.com/", name: "SESSION_COOKIE" }),
      browser.storage.local.clear(),
    ]).then(() => done(null), (err) => done(String(err)));
  `);
  await driver.navigate().refresh();
  await expect.poll(async () => (await driver.findElement(By.id("status")).getText()).trim(), { timeout: 10_000 })
    .toBe("Please log in to Ryanair.com 🔒");
  const href = await driver.findElement(By.css("#status a.status-link")).getAttribute("href");
  expect(href).toBe("https://www.ryanair.com/");
});
