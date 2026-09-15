// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardingPass } from "../lib/ryanair";
import { buildDownloadPayload } from "../lib/ryanair";
import type { PassesResult } from "../lib/messages";

const mocks = vi.hoisted(() => ({ get: vi.fn(), sendMessage: vi.fn(), toCanvas: vi.fn() }));
vi.mock("webextension-polyfill", () => ({ default: {
  storage: { local: { get: mocks.get } },
  runtime: { sendMessage: mocks.sendMessage },
} }));
vi.mock("bwip-js", () => ({ default: { toCanvas: mocks.toCanvas } }));

function result(barcode: string, seat: string): PassesResult {
  const pass = {
    pnr: "MOCK01", name: { first: "Ryan", last: "Quack" },
    departure: { code: "DUB", date: "2026-09-16T10:00:00" },
    arrival: { code: "STN" }, flight: { carrierCode: "FR", number: "1234" },
    boardingTime: "2026-09-16T09:30:00", seat: { designator: seat },
    sequence: 1, paxType: "ADT", barcode,
  } as BoardingPass;
  return { passes: [pass], downloadPayloads: [buildDownloadPayload(pass)], flights: [] };
}

// Let the storage read and runtime response settle without advancing print timers.
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("print tab refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    window.history.replaceState(null, "", "?view=tab&print=1");
    document.body.innerHTML = `
      <div id="bulk-actions"></div><div id="search-bar"></div>
      <div id="passes"></div><div id="status"></div>
      <div id="progress"></div><div id="progress-fill"></div><div id="failures"></div>`;
    vi.spyOn(window, "print").mockImplementation(() => {});
    vi.stubGlobal("CACHE_TTL_MS", 3_600_000);
    mocks.get.mockResolvedValue({ cachedPasses: { ...result("OLD", "1A"), cachedAt: Date.now() } });
  });

  afterEach(() => {
    window.dispatchEvent(new Event("afterprint"));
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for the response and prints the refreshed seat and barcode", async () => {
    let resolve!: (value: PassesResult) => void;
    mocks.sendMessage.mockReturnValue(new Promise<PassesResult>(r => { resolve = r; }));
    await import("./index");
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelectorAll(".pass")).toHaveLength(1);
    expect(window.print).not.toHaveBeenCalled();

    resolve(result("NEW", "12B"));
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(document.getElementById("print-sheet")?.textContent).toContain("12B");
    expect(mocks.toCanvas).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: "NEW" }));
  });

  it.each([0, 7_200_000])("requires a manual print after failure with a %i ms old cache", async (age) => {
    mocks.get.mockResolvedValue({ cachedPasses: { ...result("OLD", "1A"), cachedAt: Date.now() - age } });
    mocks.sendMessage.mockRejectedValue(new Error("Network unavailable"));
    await import("./index");
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.print).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain("Review the cached passes");
    document.getElementById("btn-print-all")?.click();
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(document.getElementById("print-sheet")?.textContent).toContain("1A");
  });

  it("does not print cached passes when the fresh result is empty", async () => {
    mocks.sendMessage.mockResolvedValue({ passes: [], downloadPayloads: [], flights: [] });
    await import("./index");
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.print).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".pass")).toHaveLength(0);
  });

  it("prints a missing-code notice instead of encoding whitespace", async () => {
    mocks.get.mockResolvedValue({});
    mocks.sendMessage.mockResolvedValue(result("   ", "12B"));
    await import("./index");
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(mocks.toCanvas).not.toHaveBeenCalled();
    expect(document.querySelector(".print-aztec-missing")?.textContent).toBe("No barcode issued for this pass");
  });
});
