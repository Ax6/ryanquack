import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  listener: null as ((message: unknown) => Promise<any>) | null,
}));

// A JWT whose payload is {"sub":"cust-1"}.
const TOKEN = vi.hoisted(() => `x.${btoa(JSON.stringify({ sub: "cust-1" })).replace(/=+$/, "")}.y`);

vi.mock("webextension-polyfill", () => ({ default: {
  cookies: { get: async () => ({ value: TOKEN }) },
  runtime: {
    getURL: () => "chrome-extension://x/",
    getManifest: () => ({ version: "0.0.0" }),
    onMessage: { addListener: (fn: any) => { state.listener = fn; } },
  },
  storage: { local: {
    set: async (values: Record<string, unknown>) => { Object.assign(state.store, values); },
    get: async (key: string) => ({ [key]: state.store[key] }),
  } },
} }));

await import("./index");

const HOUR = 3600e3;
const pnr = (i: number) => `PNR${String(i).padStart(3, "0")}`;

function booking(i: number) {
  return {
    type: "flight",
    rawBooking: {
      bookingId: 1000 + i,
      recordLocator: pnr(i),
      flights: [{ journeyNum: 0, origin: "STN", destination: "DUB", flightNumber: `FR${i}`,
        times: { departUTC: new Date(Date.now() + (i + 1) * HOUR).toISOString() } }],
      checkins: [{ journeyNum: 0, status: "checkin", paxNum: 0 }],
    },
  };
}

function pass(i: number) {
  return { passId: `p${i}`, pnr: pnr(i), paxType: "ADT", sequence: 1, barcode: "M1ABC",
    name: { first: "A", last: "B" },
    departure: { code: "STN", epoch: Date.now() + (i + 1) * HOUR }, arrival: { code: "DUB" },
    flight: { carrierCode: "FR", number: String(i) } };
}

/** Serves `items` in pages of 25 and answers each pass chunk through `passesFor`. */
function stubRyanair(items: unknown[], passesFor: (ids: number[], chunk: number) => Response) {
  const posted: number[][] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/orders/")) {
      const second = url.includes("nextToken=");
      const body = second ? { items: items.slice(25) } : { items: items.slice(0, 25), ...(items.length > 25 ? { nextToken: "t1" } : {}) };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const ids: number[] = JSON.parse(String(init?.body)).bookingIds;
    posted.push(ids);
    return passesFor(ids, posted.length);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posted };
}

const fetchBoardingPasses = () => state.listener!({ type: "RYQ_FETCH_BOARDING_PASSES" });

beforeEach(() => {
  for (const key of Object.keys(state.store)) delete state.store[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Fetching boarding passes", () => {
  it("should list every booking across pages, and put a checked-in one whose pass did not come back in the upcoming list", async () => {
    const items = Array.from({ length: 30 }, (_, i) => booking(i));
    const { fetchMock, posted } = stubRyanair(items, (ids) =>
      new Response(JSON.stringify(ids.map((id) => id - 1000).filter((i) => i !== 7).map(pass)), { status: 200 }));

    const result = await fetchBoardingPasses();

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/orders/"))).toHaveLength(2);
    expect(posted.flat().sort()).toEqual(items.map((_, i) => 1000 + i));
    expect(result.passes).toHaveLength(29);
    expect(result.flights.filter((f: any) => !f.isReady).map((f: any) => f.pnr)).toEqual([pnr(7)]);
  });

  it("should fail rather than hand back a partial answer when one pass chunk fails, and leave the cache alone", async () => {
    const items = Array.from({ length: 25 }, (_, i) => booking(i));
    state.store.cachedPasses = { passes: items.map((_, i) => pass(i)), flights: [], downloadPayloads: [], cachedAt: 1 };
    stubRyanair(items, (ids, chunk) => chunk === 2
      ? new Response("busy", { status: 503 })
      : new Response(JSON.stringify(ids.map((id) => pass(id - 1000))), { status: 200 }));

    await expect(fetchBoardingPasses()).rejects.toThrow("boardingpasses failed: 503");

    // The popup falls back to this on an error, so it must still hold all 25.
    expect((state.store.cachedPasses as any).passes).toHaveLength(25);
    expect((state.store.cachedPasses as any).cachedAt).toBe(1);
  });
});
