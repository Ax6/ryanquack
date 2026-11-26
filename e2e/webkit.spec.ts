import { expect, test } from "@playwright/test";
import { buildDownloadPayload, type BoardingPass } from "../src/lib/ryanair";
import { expectPassZip, expectPng, firstPng } from "./downloads";

test.beforeEach(async ({ page, request }) => {
  const response = await request.post("http://localhost:3000/v1/boardingpasses", {
    headers: { client: "ios" }, data: { bookingIds: [200000000, 200000037] },
  });
  expect(response.ok()).toBe(true);
  const passes: BoardingPass[] = await response.json();
  await page.addInitScript(result => {
    const runtime = {
      id: "ryanquack-test",
      sendMessage: async (message: { type: string }) => {
        if (message.type === "RYQ_FETCH_BOARDING_PASSES") return result;
        throw new Error(`Unexpected extension message: ${message.type}`);
      },
    };
    // webextension-polyfill checks chrome.runtime.id before selecting the browser API.
    Object.assign(window, { chrome: { runtime }, browser: { runtime, storage: { local: { get: async () => ({}) } } } });
  }, { passes, downloadPayloads: passes.map(buildDownloadPayload), flights: [] });
  await page.goto("http://127.0.0.1:43173/src/popup/popup.html?view=tab");
});

for (const [action, filename] of [["Save Image", firstPng], ["Download All Passes", "passes.zip"]]) {
  test(`${action} triggers a WebKit download with its filename and contents`, async ({ page }, info) => {
    if (action === "Save Image") await page.getByRole("button", { name: "Show Ticket" }).first().click();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: action }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(filename);
    const file = info.outputPath(filename);
    await download.saveAs(file);
    if (filename === firstPng) expectPng(file);
    else expectPassZip(file);
  });
}
