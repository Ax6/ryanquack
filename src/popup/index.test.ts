// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardingPass, FlightSummary } from "../lib/ryanair";
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
      <div id="passes"></div>
      <div id="status-bar"><div id="progress"></div><div id="progress-fill"></div>
      <div id="summary" hidden></div><div id="status"></div><div id="failures"></div></div>`;
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

describe("diagnostic report button", () => {
  const REPORT = { generatedAt: "2026-09-20T12:00:00.000Z", list: { bookings: 128, flights: 138 } };

  let writeText: ReturnType<typeof vi.fn>;

  /** Answers each message type the popup sends during a load. */
  function respond(report: unknown) {
    mocks.sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === "RYQ_GET_DIAGNOSTICS" ? report : result("CODE", "1A"));
  }

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    document.body.innerHTML = `
      <div id="bulk-actions"></div><div id="search-bar"></div>
      <div id="passes"></div>
      <div id="status-bar"><div id="progress"></div><div id="progress-fill"></div>
      <div id="summary" hidden></div><div id="status"></div><div id="failures"></div></div>`;
    vi.stubGlobal("CACHE_TTL_MS", 3_600_000);
    mocks.get.mockResolvedValue({});
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    respond(REPORT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function load(search: string) {
    window.history.replaceState(null, "", search);
    await import("./index");
    await settle();
  }

  it("should offer an icon in the status bar in the tab view, not a button among the actions", async () => {
    await load("?view=tab");

    const button = document.getElementById("btn-copy-diagnostics");
    expect(button).not.toBeNull();
    expect(button?.parentElement?.id).toBe("status-bar");
    expect(button?.getAttribute("aria-label")).toBe("Copy diagnostic report");
    expect(button?.title).toContain("No flight details");
    expect(document.querySelector("#bulk-actions #btn-copy-diagnostics")).toBeNull();
  });

  it("should leave the popup view without one", async () => {
    await load("?");

    expect(document.getElementById("btn-copy-diagnostics")).toBeNull();
    expect(document.querySelectorAll(".pass")).toHaveLength(1);
  });

  it("should copy the report and show exactly what was copied", async () => {
    await load("?view=tab");
    document.getElementById("btn-copy-diagnostics")?.click();
    await settle();

    const json = JSON.stringify(REPORT, null, 2);
    expect(writeText).toHaveBeenCalledWith(json);
    expect(document.getElementById("status")?.textContent).toBe("Diagnostic report copied");

    const details = document.getElementById("diagnostic-report");
    expect(details?.tagName).toBe("DETAILS");
    expect(details?.parentElement?.id).toBe("status-bar");
    expect(details?.querySelector("summary")?.textContent).toBe("Report contents");
    expect(details?.querySelector("pre")?.textContent).toBe(json);
  });

  it("should ask for a refresh when nothing has been fetched yet", async () => {
    respond(null);
    await load("?view=tab");
    document.getElementById("btn-copy-diagnostics")?.click();
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    expect(document.getElementById("diagnostic-report")).toBeNull();
    expect(document.getElementById("status")?.textContent).toBe("Refresh first, then copy the report");
  });

  it("should leave the report on screen when the clipboard refuses it", async () => {
    writeText.mockRejectedValue(new Error("Denied"));
    await load("?view=tab");
    document.getElementById("btn-copy-diagnostics")?.click();
    await settle();

    expect(document.getElementById("diagnostic-report")).not.toBeNull();
    expect(document.getElementById("status")?.textContent).toContain("Could not copy the report");
  });
});

describe("upcoming flight labels", () => {
  const flight = (fields: Partial<FlightSummary>): FlightSummary => ({
    bookingId: 1, pnr: "GROUP1", origin: "STN", destination: "DUB",
    date: "2026-09-22T06:00:00Z", flightNumber: "FR1000",
    checkinStatus: "unknown", isReady: false, ...fields,
  });

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    window.history.replaceState(null, "", "?");
    document.body.innerHTML = `
      <div id="bulk-actions"></div><div id="search-bar"></div>
      <div id="passes"></div>
      <div id="status-bar"><div id="progress"></div><div id="progress-fill"></div>
      <div id="summary" hidden></div><div id="status"></div><div id="failures"></div></div>`;
    vi.stubGlobal("CACHE_TTL_MS", 3_600_000);
    mocks.get.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** As the popup prints it, in the machine's own zone, so the test runs anywhere. */
  function shortDateTime(isoUtc: string): string {
    const date = new Date(isoUtc);
    const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
    const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return `${day} ${time}`;
  }

  async function render(flights: FlightSummary[], passes: BoardingPass[] = []) {
    mocks.sendMessage.mockResolvedValue({ passes, downloadPayloads: passes.map(buildDownloadPayload), flights });
    await import("./index");
    await settle();
    return Array.from(document.querySelectorAll(".flight-summary"))
      .map((row) => row.querySelector(".pass-meta")?.textContent);
  }

  it("should name an unknown check-in status rather than print the word", async () => {
    expect(await render([flight({})])).toEqual(["Check-in status unknown"]);
    expect(document.querySelectorAll(".flight-summary")).toHaveLength(1);
  });

  it("should tell a passenger without a seat when free check-in opens, not when paid check-in did", async () => {
    // Ryanair's site says "open" here; the reporter called that misleading.
    const window = {
      checkInOpenUTC: "2026-07-24T06:00:00Z",
      checkInFreeOpenUTC: "2026-09-22T06:00:00Z",
      checkInCloseUTC: "2026-09-23T04:00:00Z",
    };
    expect(await render([
      flight({ checkinStatus: "nocheckin", ...window, hasSeat: false }),
      flight({ checkinStatus: "nocheckin", ...window, hasSeat: true }),
      flight({ checkinStatus: "documentsadded", ...window, hasSeat: false }),
    ])).toEqual([
      `Check-in opens ${shortDateTime(window.checkInFreeOpenUTC)}`,
      "Check-in open",
      `Documents added · Check-in opens ${shortDateTime(window.checkInFreeOpenUTC)}`,
    ]);
  });

  it("should say when check-in is open, closed, or has no window it knows of", async () => {
    expect(await render([
      flight({ checkinStatus: "nocheckin", checkInFreeOpenUTC: "2026-09-21T06:00:00Z", checkInCloseUTC: "2026-09-22T04:00:00Z" }),
      flight({ checkinStatus: "documentsadded", checkInFreeOpenUTC: "2026-09-21T06:00:00Z" }),
      flight({ checkinStatus: "nocheckin", checkInOpenUTC: "2026-09-01T06:00:00Z", checkInCloseUTC: "2026-09-20T04:00:00Z" }),
      flight({ checkinStatus: "nocheckin" }),
    ])).toEqual([
      "Check-in open",
      "Documents added · Check-in open",
      "Check-in closed",
      "Check-in not open",
    ]);
  });

  it("should make a status it has never seen readable rather than print Ryanair's token", async () => {
    expect(await render([
      flight({ checkinStatus: "closed" }),
      flight({ checkinStatus: "boardingDenied" }),
      flight({ checkinStatus: "checkin" }),
    ])).toEqual(["Closed", "Boarding denied", "Checked in"]);
  });

  it("should count bookings, upcoming flights and passes in the summary line", async () => {
    const pass = result("CODE", "1A").passes[0];
    await render([
      flight({ bookingId: 1, checkinStatus: "checkin", isReady: true, pnr: "MOCK01" }),
      flight({ bookingId: 2, checkinStatus: "nocheckin" }),
      flight({ bookingId: 2, checkinStatus: "nocheckin", flightNumber: "FR1001" }),
      flight({ bookingId: 3, checkinStatus: "documentsadded" }),
    ], [pass]);

    const summary = document.getElementById("summary") as HTMLElement;
    expect(summary.hidden).toBe(false);
    expect(summary.textContent).toBe("3 bookings · 3 upcoming flights · 1 boarding pass");
  });

  it("should offer the search box for upcoming flights alone, and filter them", async () => {
    await render([
      flight({ bookingId: 1, pnr: "AAAAAA", flightNumber: "FR2372" }),
      flight({ bookingId: 2, pnr: "BBBBBB", flightNumber: "FR2372" }),
      flight({ bookingId: 3, pnr: "CCCCCC", flightNumber: "FR1000", destination: "KRK" }),
      flight({ bookingId: 4, pnr: "DDDDDD", flightNumber: "FR1001" }),
    ]);

    const input = document.querySelector<HTMLInputElement>("#search-bar input");
    expect(input).not.toBeNull();
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".flight-summary"))
      .filter((row) => row.style.display !== "none").length;

    input!.value = "fr2372";
    input!.dispatchEvent(new Event("input"));
    expect(rows()).toBe(2);

    input!.value = "krk";
    input!.dispatchEvent(new Event("input"));
    expect(rows()).toBe(1);

    input!.value = "zzz";
    input!.dispatchEvent(new Event("input"));
    expect(rows()).toBe(0);
    expect((document.querySelector(".search-empty") as HTMLElement).style.display).toBe("");
  });

  it("should not offer the search box for a short list", async () => {
    await render([flight({ bookingId: 1 }), flight({ bookingId: 2 })]);

    expect(document.querySelector("#search-bar input")).toBeNull();
  });

  it("should hide the summary line when there is nothing to count", async () => {
    await render([]);

    expect((document.getElementById("summary") as HTMLElement).hidden).toBe(true);
  });
});
