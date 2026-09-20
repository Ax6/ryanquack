import { describe, it, expect } from "vitest";
import {
  buildDiagnosticReport,
  createHasher,
  createSalt,
  hashValue,
  newEndpointLog,
  redactCustomerId,
  skeleton,
  summarizeDetails,
  summarizeMerge,
  summarizePasses,
  summarizeTrips,
} from "./diagnostics";
import type { DiagnosticInput } from "./diagnostics";
import type { BoardingPass, FlightSummary, OrderResponse } from "./ryanair";

/** The values a report must never carry, in every place they could leak from. */
const SEED_PNR = "QZ7X4M";
const SEED_FIRST = "Sofia";
const SEED_LAST = "Lindqvist";
const SEED_BARCODE = "M1LINDQVIST/SOFIA EQZ7X4M STNDUB FR 1000 015Y012B0100";
const SEED_CUSTOMER_ID = "cust-0d41d8cd98f0";

describe("skeleton", () => {
  it("should replace every primitive with its type", () => {
    expect(skeleton({ pnr: "QZ7X4M", bookingId: 1234, prime: true, seat: null }))
      .toEqual({ pnr: "string(6)", bookingId: "number", prime: "boolean", seat: "null" });
  });

  it("should keep one element of an array and count the rest", () => {
    expect(skeleton({ flights: [{ pnr: "AAA111" }, { pnr: "BBB222" }, { pnr: "CCC333" }] }))
      .toEqual({ flights: [{ pnr: "string(6)" }, "…×3"] });
    expect(skeleton({ cars: [] })).toEqual({ cars: [] });
  });

  it("should stop at the depth limit rather than walk forever", () => {
    const deep: Record<string, unknown> = { pnr: "QZ7X4M" };
    const nested = Array.from({ length: 12 }).reduce<Record<string, unknown>>(
      (inner) => ({ next: inner }),
      deep
    );

    expect(JSON.stringify(skeleton(nested))).toContain('"…"');
    expect(JSON.stringify(skeleton(nested))).not.toContain("string(6)");
  });

  it("should reach the nesting the trip listing hides bookings in", () => {
    const body = { items: [{ flights: [{ journeys: [{ segments: [{ flightNumber: "FR1000", departureDateUTC: "2026-09-22T06:00:00Z" }] }] }] }] };

    expect(skeleton(body)).toEqual({
      items: [
        {
          flights: [
            {
              journeys: [
                { segments: [{ flightNumber: "string(6)", departureDateUTC: "string(20)" }, "…×1"] },
                "…×1",
              ],
            },
            "…×1",
          ],
        },
        "…×1",
      ],
    });
  });

  it("should stop at a body that points back at itself", () => {
    const cycle: Record<string, unknown> = { pnr: "QZ7X4M" };
    cycle.self = cycle;
    const loop: unknown[] = [];
    loop.push(loop);

    expect(skeleton(cycle)).toEqual({ pnr: "string(6)", self: "…circular" });
    expect(skeleton(loop)).toEqual(["…circular", "…×1"]);
  });

  it("should leave no value of the response behind", () => {
    const body = {
      items: [{
        tripId: "trip-1", startDate: "2026-09-22",
        flights: [{ bookingId: 5000, pnr: SEED_PNR, passengers: [{ first: SEED_FIRST, last: SEED_LAST }] }],
      }],
      nextToken: "b2Zmc2V0OjMw",
    };

    const json = JSON.stringify(skeleton(body));

    for (const leak of ["trip-1", "2026-09-22", "5000", SEED_PNR, SEED_FIRST, SEED_LAST, "b2Zmc2V0OjMw"]) {
      expect(json).not.toContain(leak);
    }
    // The shape, which is the whole point, is still there.
    expect(json).toContain("flights");
    expect(json).toContain("passengers");
  });
});

describe("hashing", () => {
  it("should return ten hex characters", async () => {
    await expect(hashValue(SEED_PNR, "salt")).resolves.toMatch(/^[0-9a-f]{10}$/);
  });

  it("should be stable for one salt and different for another", async () => {
    const [a, b, other] = await Promise.all([
      hashValue(SEED_PNR, "salt-a"),
      hashValue(SEED_PNR, "salt-a"),
      hashValue(SEED_PNR, "salt-b"),
    ]);

    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("should leave a blank value blank, so an absent field still reads as absent", async () => {
    await expect(hashValue("", "salt")).resolves.toBe("");
    await expect(hashValue(undefined, "salt")).resolves.toBe("");
  });

  it("should correlate duplicates within one report", async () => {
    const hash = createHasher("salt");

    expect(await hash(SEED_PNR)).toBe(await hash(SEED_PNR));
    expect(await hash(SEED_PNR)).not.toBe(await hash("OTHER1"));
  });

  it("should draw a different salt every time", () => {
    expect(createSalt()).not.toBe(createSalt());
    expect(createSalt()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("endpoint logs", () => {
  it("should blank the customer id out of the url", () => {
    const log = newEndpointLog(
      `https://services-api.ryanair.com/orders/v2/orders/${SEED_CUSTOMER_ID}/details?type=flight`,
      SEED_CUSTOMER_ID
    );

    expect(log.url).toBe("https://services-api.ryanair.com/orders/v2/orders/<cid>/details?type=flight");
    expect(log.requests).toEqual([]);
  });

  it("should leave a url that never held the id alone", () => {
    expect(redactCustomerId("https://mntappbp.ryanair.com/v1/boardingpasses", SEED_CUSTOMER_ID))
      .toBe("https://mntappbp.ryanair.com/v1/boardingpasses");
    expect(redactCustomerId("https://x/y", "")).toBe("https://x/y");
  });
});

const ORDERS: OrderResponse = {
  items: [
    {
      tripId: "trip-1", productId: "1000", type: "flight",
      payload: { booking: { bookingId: 1000, pnr: SEED_PNR } },
      rawBooking: {
        bookingId: 1000, recordLocator: SEED_PNR,
        flights: [{ journeyNum: 0, origin: "STN", destination: "DUB", flightNumber: "FR1000", times: { departUTC: "2026-09-22T06:00:00Z" } }],
        checkins: [{ journeyNum: 0, status: "checkedin" }],
      },
    },
    {
      tripId: "trip-1", productId: "1001", type: "flight",
      payload: { booking: { bookingId: 1001, pnr: "AAA111" } },
      rawBooking: { bookingId: 1001, recordLocator: "AAA111" },
    },
  ],
};

const TRIP_ITEMS: unknown[] = [
  {
    tripId: "trip-1", startDate: "2026-09-22T06:00:00Z", endDate: "2026-09-22T07:15:00Z",
    cars: [], rooms: [], events: [],
    flights: [
      {
        bookingId: 1000, pnr: SEED_PNR, origin: "STN", destination: "DUB",
        passengers: [{ first: SEED_FIRST, last: SEED_LAST }],
        journeys: [{ segments: [{ flightNumber: "FR1000", departureDateUTC: "2026-09-22T06:00:00Z" }] }],
      },
      {
        bookingId: 9001, pnr: "GROUP1", origin: "STN", destination: "DUB",
        passengers: [{ first: SEED_FIRST, last: SEED_LAST }],
        journeys: [{ segments: [{ flightNumber: "FR1000", departureDateUTC: "2026-09-22T06:00:00Z" }] }],
      },
    ],
  },
  { tripId: "trip-2", cars: [{ id: 1 }] },
];

const PASSES = [{
  pnr: SEED_PNR, paxType: "ADT", barcode: SEED_BARCODE,
  name: { title: "MR", first: SEED_FIRST, last: SEED_LAST },
  seat: { designator: "12B" },
  flight: { carrierCode: "FR", number: "1000", label: "FR 1000", operatedBy: "" },
  departure: { code: "STN", name: "London Stansted", date: "2026-09-22T07:00:00", dateUTC: "2026-09-22T06:00:00Z" },
  arrival: { code: "DUB" },
  docNationality: "GBR",
}] as unknown as BoardingPass[];

describe("summaries", () => {
  it("should count what the details listing repeats, and hash what identifies it", async () => {
    const hash = createHasher("salt");
    const summary = await summarizeDetails(ORDERS, hash);

    expect(summary).toMatchObject({
      items: 2,
      // Two items, one trip: exactly the grouping that hides bookings.
      distinctTripIds: 1,
      distinctProductIds: 2,
      distinctBookingIds: 2,
    });
    expect(summary.entries[0]).toMatchObject({
      type: "flight",
      tripId: await hash("trip-1"),
      bookingId: await hash(1000),
      pnr: await hash(SEED_PNR),
      flights: [{ flightNumber: "FR1000", origin: "STN", destination: "DUB", departUTC: "2026-09-22T06:00:00Z" }],
      checkins: ["checkedin"],
    });
    // Falls back to the payload when rawBooking carries no legs.
    expect(summary.entries[1]).toMatchObject({ flights: [], checkins: [], pnr: await hash("AAA111") });
  });

  it("should count every booking the trip listing holds", async () => {
    const summary = await summarizeTrips(TRIP_ITEMS, createHasher("salt"));

    expect(summary).toMatchObject({ items: 2, distinctTripIds: 2, totalBookings: 2 });
    expect(summary.entries[0]).toMatchObject({
      startDate: "2026-09-22T06:00:00Z",
      endDate: "2026-09-22T07:15:00Z",
      flights: 2,
    });
    expect(summary.entries[0].bookings[1]).toMatchObject({
      origin: "STN", destination: "DUB",
      journeys: 1, segments: 1,
      parsedFlightNumber: "FR1000",
      parsedDate: "2026-09-22T06:00:00Z",
    });
    expect(summary.entries[1]).toMatchObject({ flights: 0, bookings: [] });
  });

  it("should count which side of the merge each booking came from", () => {
    const flight = (bookingId: number, isReady: boolean): FlightSummary => ({
      bookingId, pnr: "", origin: "", destination: "", date: "",
      flightNumber: "", checkinStatus: isReady ? "checkedin" : "nocheckin", isReady,
    });
    const fromDetails = [flight(1, true), flight(2, false)];
    const fromTrips = [flight(1, true), flight(3, true)];

    expect(summarizeMerge(fromDetails, fromTrips, [...fromDetails, flight(3, true)], [1, 3]))
      .toEqual({ onlyInDetails: 1, onlyInTrips: 1, inBoth: 1, total: 3, ready: 2, readyBookingIds: 2, unconfirmed: 0 });
  });

  it("should count the trip-listing bookings the reconcile could not confirm", () => {
    const flight = (bookingId: number, checkinStatus: string, isReady: boolean): FlightSummary => ({
      bookingId, pnr: "", origin: "", destination: "", date: "",
      flightNumber: "", checkinStatus, isReady,
    });
    // Two came only from the trip listing; one of them produced no pass.
    const merged = [flight(1, "checkedin", true), flight(2, "unknown", true), flight(3, "unknown", false)];

    expect(summarizeMerge([merged[0]], merged.slice(1), merged, [1, 2, 3]))
      .toMatchObject({ total: 3, ready: 2, readyBookingIds: 3, unconfirmed: 1 });
  });

  it("should describe a pass without describing its holder", async () => {
    const summary = await summarizePasses(PASSES, createHasher("salt"));

    expect(summary.count).toBe(1);
    expect(summary.entries[0]).toEqual({
      pnr: await hashValue(SEED_PNR, "salt"),
      flight: "FR 1000",
      departure: "2026-09-22T06:00:00Z",
      hasBarcode: true,
      paxType: "ADT",
    });
  });
});

function input(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  const merged = [
    { bookingId: 1000, pnr: SEED_PNR, origin: "STN", destination: "DUB", date: "2026-09-22T06:00:00Z", flightNumber: "FR1000", checkinStatus: "checkedin", isReady: true },
    { bookingId: 9001, pnr: "GROUP1", origin: "STN", destination: "DUB", date: "2026-09-22T06:00:00Z", flightNumber: "FR1000", checkinStatus: "unknown", isReady: true },
  ];

  return {
    environment: { extensionVersion: "0.5.0", userAgent: "vitest", target: "chrome" },
    endpoints: {
      details: {
        url: newEndpointLog(`https://api/orders/v2/orders/${SEED_CUSTOMER_ID}/details`, SEED_CUSTOMER_ID).url,
        requests: [{ status: 200, durationMs: 120, items: 2 }],
      },
      trips: {
        url: newEndpointLog(`https://api/orders/v2/orders/${SEED_CUSTOMER_ID}`, SEED_CUSTOMER_ID).url,
        requests: [{ status: 200, durationMs: 90, items: 2 }],
      },
      boardingpasses: {
        url: "https://passes/v1/boardingpasses",
        requests: [{ status: 200, durationMs: 300, items: 1 }, { status: 500, durationMs: 40, items: 0, error: "boardingpasses failed: 500" }],
      },
    },
    orders: ORDERS,
    trips: TRIP_ITEMS,
    merge: { fromDetails: merged.slice(0, 1), fromTrips: merged, merged, readyBookingIds: [1000, 9001] },
    passes: PASSES,
    schema: { details: skeleton(ORDERS), trips: skeleton({ items: TRIP_ITEMS }), boardingpasses: skeleton(PASSES) },
    salt: "fixed-salt",
    now: new Date("2026-09-20T12:00:00Z"),
    ...overrides,
  };
}

describe("the report", () => {
  it("should carry the environment, the endpoint tallies and the merge counts", async () => {
    const report = await buildDiagnosticReport(input());

    expect(report).toMatchObject({
      generatedAt: "2026-09-20T12:00:00.000Z",
      extensionVersion: "0.5.0",
      userAgent: "vitest",
      target: "chrome",
      merge: { onlyInDetails: 0, onlyInTrips: 1, inBoth: 1, total: 2, ready: 2, readyBookingIds: 2, unconfirmed: 0 },
    });
    expect(report.endpoints.details).toMatchObject({ pages: 1, items: 2, durationMs: 120 });
    expect(report.endpoints.boardingpasses).toMatchObject({ pages: 2, items: 1, durationMs: 340 });
    expect(report.endpoints.boardingpasses.requests[1].error).toContain("500");
    expect(report.details.distinctTripIds).toBe(1);
    expect(report.trips.totalBookings).toBe(2);
    expect(report.passes.count).toBe(1);
  });

  it("should never serialize a pnr, a name, a barcode, a token or the customer id", async () => {
    const json = JSON.stringify(await buildDiagnosticReport(input()));

    for (const leak of [SEED_PNR, SEED_FIRST, SEED_LAST, SEED_BARCODE, SEED_CUSTOMER_ID, "GROUP1", "12B", "GBR"]) {
      expect(json).not.toContain(leak);
    }
    expect(json).toContain("<cid>");
    // The hashed pnr is there, so duplicates across the two listings still line up.
    expect(json).toContain(await hashValue(SEED_PNR, "fixed-salt"));
  });

  it("should hash the same booking to the same value across the two listings", async () => {
    const report = await buildDiagnosticReport(input());

    expect(report.details.entries[0].bookingId).toBe(report.trips.entries[0].bookings[0].bookingId);
    expect(report.details.entries[0].pnr).toBe(report.passes.entries[0].pnr);
  });

  it("should record the reason an endpoint failed without the fetch having to succeed", async () => {
    const empty = input({
      endpoints: {
        ...input().endpoints,
        trips: { url: "https://api/orders/v2/orders/<cid>", requests: [], error: "trips failed: 500" },
      },
      trips: [],
    });

    const report = await buildDiagnosticReport(empty);

    expect(report.endpoints.trips).toMatchObject({ pages: 0, items: 0, error: "trips failed: 500" });
    expect(report.trips).toMatchObject({ items: 0, totalBookings: 0, entries: [] });
  });

  it("should draw a fresh salt when none is given, so hashes cannot be compared across reports", async () => {
    const [first, second] = await Promise.all([
      buildDiagnosticReport(input({ salt: undefined })),
      buildDiagnosticReport(input({ salt: undefined })),
    ]);

    expect(first.details.entries[0].pnr).not.toBe(second.details.entries[0].pnr);
  });
});
