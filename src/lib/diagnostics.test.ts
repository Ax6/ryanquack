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
  summarizeUserAgent,
} from "./diagnostics";
import type { DiagnosticInput } from "./diagnostics";
import type { BoardingPass, FlightSummary, OrderResponse } from "./ryanair";

/** The values a report must never carry, in every place they could leak from. */
const SEED_PNR = "QZ7X4M";
const SEED_FIRST = "Sofia";
const SEED_LAST = "Lindqvist";
const SEED_BARCODE = "M1LINDQVIST/SOFIA EQZ7X4M STNDUB FR 1000 015Y012B0100";
const SEED_CUSTOMER_ID = "cust-0d41d8cd98f0";
/** The itinerary itself: where from, where to, on what and when. */
const SEED_ORIGIN = "STN";
const SEED_DESTINATION = "DUB";
const SEED_FLIGHT = "FR1000";
const SEED_DATE = "2026-09-22T06:00:00Z";

const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36";

describe("skeleton", () => {
  it("should replace every primitive with its type", () => {
    expect(skeleton({ pnr: SEED_PNR, bookingId: 1234, prime: true, seat: null }))
      .toEqual({ pnr: "string", bookingId: "number", prime: "boolean", seat: "null" });
  });

  it("should not say how long a string was", () => {
    // A boarding pass skeleton with lengths on it is a list of how long each
    // passenger's name is, which is neither a shape nor anybody's business.
    const json = JSON.stringify(skeleton({
      name: { first: SEED_FIRST, last: SEED_LAST },
      barcode: SEED_BARCODE,
    }));

    expect(json).toBe('{"name":{"first":"string","last":"string"},"barcode":"string"}');
    expect(json).not.toMatch(/\d/);
  });

  it("should describe every element of an array and count them", () => {
    expect(skeleton({ flights: [{ pnr: "AAA111" }, { pnr: "BBB222" }, { pnr: "CCC333" }] }))
      .toEqual({ flights: [{ pnr: "string ×3/3" }, "…×3"] });
    expect(skeleton({ cars: [] })).toEqual({ cars: [] });
  });

  it("should union the keys across elements rather than sample the first", () => {
    // Sampling element zero is what would hide a listing that parses for some
    // bookings and not others — the shape we are looking for.
    expect(skeleton({
      flights: [
        { bookingId: 1, pnr: "AAA111" },
        { bookingId: 2 },
        { id: "3", pnr: "CCC333", journeys: [{ segments: [] }] },
      ],
    })).toEqual({
      flights: [
        {
          bookingId: "number ×2/3",
          pnr: "string ×2/3",
          id: "string ×1/3",
          "journeys ×1/3": [{ segments: [] }, "…×1"],
        },
        "…×3",
      ],
    });
  });

  it("should say when one key holds two different types", () => {
    expect(skeleton({ flights: [{ bookingId: 1 }, { bookingId: "2" }] }))
      .toEqual({ flights: [{ bookingId: "number|string ×2/2" }, "…×2"] });
  });

  it("should report the range when sibling arrays differ in length", () => {
    expect(skeleton({ trips: [{ legs: [1, 2, 3] }, { legs: [4] }] }))
      .toEqual({ trips: [{ legs: ["number", "…×1–3"] }, "…×2"] });
  });

  it("should mask a key that reads as an identifier rather than a field name", () => {
    // Undocumented endpoint: a level keyed by pnr would otherwise be a list of pnrs.
    expect(skeleton({ QZ7X4M: { seat: "12B" }, ABC123: { seat: "1A" }, pnr: SEED_PNR }))
      .toEqual({ "<id>": { seat: "string ×2/2" }, pnr: "string" });

    expect(skeleton({ 1234567: true })).toEqual({ "<id>": "boolean" });
    expect(skeleton({ [`x${"y".repeat(40)}`]: true })).toEqual({ "<id>": "boolean" });
    // Four digits is an id; three is a field name that happens to be short.
    expect(skeleton({ 123: true, seat: "1A" })).toEqual({ 123: "boolean", seat: "string" });
  });

  it("should stop at the depth limit rather than walk forever", () => {
    const deep: Record<string, unknown> = { pnr: SEED_PNR };
    const nested = Array.from({ length: 12 }).reduce<Record<string, unknown>>(
      (inner) => ({ next: inner }),
      deep
    );

    expect(JSON.stringify(skeleton(nested))).toContain('"…"');
    expect(JSON.stringify(skeleton(nested))).not.toContain("string");
  });

  it("should reach the nesting the trip listing hides bookings in", () => {
    const body = { items: [{ flights: [{ journeys: [{ segments: [{ flightNumber: SEED_FLIGHT, departureDateUTC: SEED_DATE }] }] }] }] };

    expect(skeleton(body)).toEqual({
      items: [
        {
          flights: [
            {
              journeys: [
                { segments: [{ flightNumber: "string", departureDateUTC: "string" }, "…×1"] },
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
    const cycle: Record<string, unknown> = { pnr: SEED_PNR };
    cycle.self = cycle;
    const loop: unknown[] = [];
    loop.push(loop);

    expect(skeleton(cycle)).toEqual({ pnr: "string", self: "…circular" });
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

describe("user agent", () => {
  it.each([
    [CHROME_UA, "Chrome 141 on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox 133 on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57", "Edge 141 on Windows"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "Safari 17 on iOS"],
    ["Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0", "Firefox 133 on Android"],
    ["", "unknown browser"],
  ])("should trim %s to the browser, major version and OS", (userAgent, expected) => {
    expect(summarizeUserAgent(userAgent)).toBe(expected);
  });

  it("should drop the build numbers a reporter could be singled out by", () => {
    expect(summarizeUserAgent(CHROME_UA)).not.toContain("7390");
    expect(summarizeUserAgent(CHROME_UA)).not.toContain("AppleWebKit");
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
        flights: [{ journeyNum: 0, origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: SEED_FLIGHT, times: { departUTC: SEED_DATE } }],
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

/**
 * One trip holding three bookings: the shape we always read, a shape we never
 * guessed at, and a node that is not a booking at all.
 */
const TRIP_ITEMS: unknown[] = [
  {
    tripId: "trip-1", startDate: SEED_DATE, endDate: "2026-09-22T07:15:00Z",
    cars: [], rooms: [], events: [],
    flights: [
      {
        bookingId: 1000, pnr: SEED_PNR, origin: SEED_ORIGIN, destination: SEED_DESTINATION,
        passengers: [{ first: SEED_FIRST, last: SEED_LAST }],
        journeys: [{ segments: [{ flightNumber: SEED_FLIGHT, departureDateUTC: SEED_DATE }] }],
      },
      {
        id: "9001", recordLocator: "GROUP1",
        passengers: [{ first: SEED_FIRST, last: SEED_LAST }],
        itinerary: {
          journeys: [{ sectors: [{ segments: [{
            origin: SEED_ORIGIN, destination: SEED_DESTINATION,
            flightNumber: SEED_FLIGHT, departureDateUTC: SEED_DATE,
          }] }] }],
        },
      },
      { note: "not a booking at all" },
    ],
  },
  { tripId: "trip-2", cars: [{ id: 1 }] },
];

const PASSES = [
  {
    pnr: SEED_PNR, paxType: "ADT", barcode: SEED_BARCODE,
    name: { title: "MR", first: SEED_FIRST, last: SEED_LAST },
    seat: { designator: "12B" },
    flight: { carrierCode: "FR", number: "1000", label: "FR 1000", operatedBy: "" },
    departure: { code: SEED_ORIGIN, name: "London Stansted", date: "2026-09-22T07:00:00", dateUTC: SEED_DATE },
    arrival: { code: SEED_DESTINATION },
    docNationality: "GBR",
  },
  {
    pnr: "AAA111", paxType: "CHD", barcode: null,
    name: { title: "MISS", first: SEED_FIRST, last: SEED_LAST },
    flight: { carrierCode: "FR", number: "1000", label: "FR 1000", operatedBy: "" },
    departure: { code: SEED_ORIGIN, dateUTC: SEED_DATE },
    arrival: { code: SEED_DESTINATION },
  },
] as unknown as BoardingPass[];

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
    expect(summary.entries[0]).toEqual({
      type: "flight",
      tripId: await hash("trip-1"),
      bookingId: await hash(1000),
      pnr: await hash(SEED_PNR),
      legs: 1,
      parsedLegs: 1,
      checkins: ["checkedin"],
      productId: await hash("1000"),
    });
    // Falls back to the payload when rawBooking carries no legs.
    expect(summary.entries[1]).toMatchObject({ legs: 0, parsedLegs: 0, pnr: await hash("AAA111") });
  });

  it("should count a leg it could not read as unparsed", async () => {
    const orders = {
      items: [{ rawBooking: { bookingId: 1, recordLocator: "AAA111", flights: [
        { journeyNum: 0, origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: SEED_FLIGHT, times: { departUTC: SEED_DATE } },
        { journeyNum: 1, origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: "" },
      ] } }],
    } as unknown as OrderResponse;

    expect((await summarizeDetails(orders, createHasher("salt"))).entries[0])
      .toMatchObject({ legs: 2, parsedLegs: 1 });
  });

  it("should count every booking the trip listing holds, and say which it could read", async () => {
    const summary = await summarizeTrips(TRIP_ITEMS, createHasher("salt"));

    expect(summary).toMatchObject({
      items: 2, distinctTripIds: 2, totalBookings: 3, totalParsedBookings: 2,
    });
    expect(summary.entries[0]).toMatchObject({ flights: 3, parsedBookings: 2 });

    expect(summary.entries[0].bookings[0]).toMatchObject({
      parsed: true,
      bookingIdKey: "bookingId",
      bookingIdNumeric: true,
      pnrKey: "pnr",
      dateKey: "departureDateUTC",
      flightNumberKey: "flightNumber",
      routeKey: "origin",
      journeys: 1,
      segments: 1,
    });

    // The same booking in a shape we never guessed at, read anyway.
    expect(summary.entries[0].bookings[1]).toMatchObject({
      parsed: true,
      bookingIdKey: "id",
      bookingIdNumeric: false,
      pnrKey: "recordLocator",
      dateKey: "departureDateUTC",
      // Not under `journeys` here, so the raw counts are honestly zero.
      journeys: 0,
      segments: 0,
    });

    expect(summary.entries[0].bookings[2]).toMatchObject({
      parsed: false,
      bookingIdKey: null,
      pnrKey: null,
      dateKey: null,
      flightNumberKey: null,
      routeKey: null,
    });
    expect(summary.entries[1]).toMatchObject({ flights: 0, parsedBookings: 0, bookings: [] });
  });

  it("should hash a booking the same whichever key its id was under", async () => {
    const hash = createHasher("salt");
    const summary = await summarizeTrips([{ flights: [
      { bookingId: 9001, pnr: "GROUP1" },
      { id: "9001", recordLocator: "GROUP1" },
    ] }], hash);

    const [first, second] = summary.entries[0].bookings;
    expect(first.bookingId).toBe(second.bookingId);
    expect(first.bookingId).toBe(await hash("9001"));
  });

  it("should count which side of the merge each booking came from", () => {
    const flight = (bookingId: number, isReady: boolean): FlightSummary => ({
      bookingId, pnr: "", origin: "", destination: "", date: "",
      flightNumber: "", checkinStatus: isReady ? "checkedin" : "nocheckin", isReady,
    });
    const fromDetails = [flight(1, true), flight(2, false)];
    const fromTrips = [flight(1, true), flight(3, true)];
    const passes = [{ bookingId: 1, pnr: "" }, { bookingId: 3, pnr: "" }] as unknown as BoardingPass[];

    expect(summarizeMerge(fromDetails, fromTrips, [...fromDetails, flight(3, true)], [1, 3], passes))
      .toEqual({
        onlyInDetails: 1, onlyInTrips: 1, inBoth: 1, total: 3, ready: 2, readyBookingIds: 2,
        unconfirmed: 0, bookingIdsWithPasses: 2, renderedNowhere: 0,
      });
  });

  it("should count the trip-listing bookings the reconcile could not confirm", () => {
    const flight = (bookingId: number, checkinStatus: string, isReady: boolean): FlightSummary => ({
      bookingId, pnr: "", origin: "", destination: "", date: "",
      flightNumber: "", checkinStatus, isReady,
    });
    // Two came only from the trip listing; one of them produced no pass.
    const merged = [flight(1, "checkedin", true), flight(2, "unknown", true), flight(3, "unknown", false)];
    const passes = [{ bookingId: 1, pnr: "" }, { bookingId: 2, pnr: "" }] as unknown as BoardingPass[];

    expect(summarizeMerge([merged[0]], merged.slice(1), merged, [1, 2, 3], passes))
      .toMatchObject({ total: 3, ready: 2, readyBookingIds: 3, unconfirmed: 1, renderedNowhere: 0 });
  });

  it("should count a booking that renders in neither list", () => {
    // Zero everywhere else in this suite, so a non-zero here is the metric working.
    const stranded: FlightSummary = {
      bookingId: 9001, pnr: "GROUP1", origin: "", destination: "", date: "",
      flightNumber: "", checkinStatus: "checkedin", isReady: true,
    };

    expect(summarizeMerge([], [stranded], [stranded], [9001], []))
      .toMatchObject({ renderedNowhere: 1, bookingIdsWithPasses: 0 });
  });

  it("should describe a pass without describing its holder or its flight", async () => {
    const summary = await summarizePasses(PASSES, createHasher("salt"));

    expect(summary.count).toBe(2);
    expect(summary.paxTypes).toEqual({ ADT: 1, CHD: 1 });
    expect(summary.entries).toEqual([
      { pnr: await hashValue(SEED_PNR, "salt"), hasBarcode: true },
      { pnr: await hashValue("AAA111", "salt"), hasBarcode: false },
    ]);

    const json = JSON.stringify(summary);
    for (const leak of ["FR 1000", SEED_FLIGHT, SEED_DATE, SEED_ORIGIN, SEED_DESTINATION]) {
      expect(json).not.toContain(leak);
    }
  });

  it("should tally a pass with no passenger type under something", async () => {
    const passes = [{ pnr: "AAA111" }, { pnr: "BBB222", paxType: "" }] as unknown as BoardingPass[];

    expect((await summarizePasses(passes, createHasher("salt"))).paxTypes).toEqual({ unknown: 2 });
  });
});

function input(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  // As the background builds it: reconciled, so the unmatched booking is already
  // in the upcoming list rather than rendering nowhere.
  const merged = [
    { bookingId: 1000, pnr: SEED_PNR, origin: SEED_ORIGIN, destination: SEED_DESTINATION, date: SEED_DATE, flightNumber: SEED_FLIGHT, checkinStatus: "checkedin", isReady: true },
    { bookingId: 9001, pnr: "GROUP1", origin: SEED_ORIGIN, destination: SEED_DESTINATION, date: SEED_DATE, flightNumber: SEED_FLIGHT, checkinStatus: "unknown", isReady: false },
  ];

  return {
    environment: { extensionVersion: "0.5.0", userAgent: CHROME_UA, target: "chrome" },
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
      userAgent: "Chrome 141 on macOS",
      target: "chrome",
      merge: {
        onlyInDetails: 0, onlyInTrips: 1, inBoth: 1, total: 2, ready: 1, readyBookingIds: 2,
        unconfirmed: 1, bookingIdsWithPasses: 1, renderedNowhere: 0,
      },
    });
    expect(report.endpoints.details).toMatchObject({ pages: 1, items: 2, durationMs: 120 });
    expect(report.endpoints.boardingpasses).toMatchObject({ pages: 2, items: 1, durationMs: 340 });
    expect(report.endpoints.boardingpasses.requests[1].error).toContain("500");
    expect(report.details.distinctTripIds).toBe(1);
    expect(report.trips.totalBookings).toBe(3);
    expect(report.trips.totalParsedBookings).toBe(2);
    expect(report.passes.count).toBe(2);
    expect(report.passes.paxTypes).toEqual({ ADT: 1, CHD: 1 });
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

  it("should never serialize a route, a flight number or a date the user is travelling on", async () => {
    // What the reporter refused to post: their itinerary, three times over.
    const json = JSON.stringify(await buildDiagnosticReport(input()));

    for (const leak of [SEED_ORIGIN, SEED_DESTINATION, SEED_FLIGHT, SEED_DATE, "2026-09-22"]) {
      expect(json).not.toContain(leak);
    }
    // What it says instead: which key we read, and whether we read it.
    expect(json).toContain("departureDateUTC");
    expect(json).toContain("parsed");
  });

  it("should describe the parse rather than the itinerary, key by key", async () => {
    const report = await buildDiagnosticReport(input());

    expect(report.trips.entries[0].bookings[1]).toEqual({
      bookingId: await hashValue("9001", "fixed-salt"),
      pnr: await hashValue("GROUP1", "fixed-salt"),
      journeys: 0,
      segments: 0,
      parsed: true,
      bookingIdKey: "id",
      bookingIdNumeric: false,
      pnrKey: "recordLocator",
      dateKey: "departureDateUTC",
      flightNumberKey: "flightNumber",
      routeKey: "origin",
    });
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

describe("keeping the report postable", () => {
  /** The obvious shape, the shape we never guessed at, and a node that is neither. */
  function tripBookingOf(index: number): unknown {
    if (index % 3 === 0) {
      return {
        bookingId: 1000 + index, pnr: `AAA${String(index).padStart(3, "0")}`,
        origin: SEED_ORIGIN, destination: SEED_DESTINATION,
        journeys: [{ segments: [{ flightNumber: SEED_FLIGHT, departureDateUTC: SEED_DATE }] }],
      };
    }
    if (index % 3 === 1) {
      return {
        id: String(1000 + index), recordLocator: `BBB${String(index).padStart(3, "0")}`,
        passengers: [{ first: SEED_FIRST, last: SEED_LAST }],
        itinerary: { journeys: [{ sectors: [{ segments: [{
          origin: SEED_ORIGIN, destination: SEED_DESTINATION,
          flightNumber: SEED_FLIGHT, departureDateUTC: SEED_DATE,
        }] }] }] },
      };
    }
    return { note: `nothing we can read, ${index}` };
  }

  const TRIPS = 150;
  /** 50 trips carry a second booking, so 150 trips hold 200 bookings. */
  const DOUBLED = 50;

  function heavyTrips(): unknown[] {
    let booking = 0;
    return Array.from({ length: TRIPS }, (_, trip) => ({
      tripId: `trip-${trip}`,
      startDate: SEED_DATE,
      endDate: SEED_DATE,
      cars: [], rooms: [], events: [],
      flights: Array.from({ length: trip < DOUBLED ? 2 : 1 }, () => tripBookingOf(booking++)),
    }));
  }

  function heavyOrders(): OrderResponse {
    return {
      items: Array.from({ length: 200 }, (_, index) => ({
        tripId: `trip-${index % TRIPS}`, productId: String(index), type: "flight",
        payload: { booking: { bookingId: 1000 + index, pnr: `AAA${index}` } },
        rawBooking: {
          bookingId: 1000 + index, recordLocator: `AAA${index}`,
          flights: [{ journeyNum: 0, origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: SEED_FLIGHT, times: { departUTC: SEED_DATE } }],
          checkins: [{ journeyNum: 0, status: index % 2 === 0 ? "checkedin" : "nocheckin" }],
        },
      })),
    };
  }

  function heavyPasses(): BoardingPass[] {
    return Array.from({ length: 200 }, (_, index) => ({
      pnr: `AAA${index}`,
      paxType: index % 10 === 0 ? "CHD" : "ADT",
      barcode: index % 25 === 0 ? null : SEED_BARCODE,
      name: { title: "MR", first: SEED_FIRST, last: SEED_LAST },
      flight: { carrierCode: "FR", number: "1000", label: "FR 1000" },
      departure: { code: SEED_ORIGIN, dateUTC: SEED_DATE },
      arrival: { code: SEED_DESTINATION },
    })) as unknown as BoardingPass[];
  }

  function heavyInput(): DiagnosticInput {
    const orders = heavyOrders();
    const trips = heavyTrips();
    const passes = heavyPasses();
    const merged: FlightSummary[] = Array.from({ length: 200 }, (_, index) => ({
      bookingId: 1000 + index, pnr: `AAA${index}`, origin: SEED_ORIGIN, destination: SEED_DESTINATION,
      date: SEED_DATE, flightNumber: SEED_FLIGHT, checkinStatus: "checkedin", isReady: true,
    }));

    return input({
      orders,
      trips,
      passes,
      merge: { fromDetails: merged, fromTrips: merged, merged, readyBookingIds: merged.map((f) => f.bookingId) },
      schema: {
        details: skeleton(orders),
        trips: skeleton({ items: trips }),
        boardingpasses: skeleton(passes),
      },
    });
  }

  it("should stay well inside what an issue comment holds, at 200 bookings across 150 trips", async () => {
    const report = await buildDiagnosticReport(heavyInput());

    // GitHub caps a comment at 65,536 characters, and a report nobody can paste
    // costs us the one round we get with a reporter. Indented, because that is
    // the form the popup puts on the clipboard.
    expect(JSON.stringify(report, null, 2).length).toBeLessThan(50_000);
    expect(JSON.stringify(report).length).toBeLessThan(50_000);
    expect(report.trips.items).toBe(TRIPS);
    expect(report.trips.totalBookings).toBe(200);
  });

  it("should count all 200 bookings in the tally however few rows it keeps", async () => {
    const report = await buildDiagnosticReport(heavyInput());
    const { tally, entries, entriesTruncated } = report.trips;
    const sum = (counts: Record<string, number>) =>
      Object.values(counts).reduce((total, count) => total + count, 0);

    for (const counts of [tally.bookingIdKeys, tally.pnrKeys, tally.dateKeys, tally.flightNumberKeys, tally.routeKeys]) {
      expect(sum(counts)).toBe(200);
    }
    expect(tally.parsed + tally.unparsed).toBe(200);
    expect(tally.numericBookingIds + tally.stringBookingIds).toBe(tally.parsed);
    // Two shapes in, two shapes counted, and the key each was read under.
    expect(tally.bookingIdKeys).toEqual({ bookingId: 67, id: 67, none: 66 });
    expect(tally.pnrKeys).toEqual({ pnr: 67, recordLocator: 67, none: 66 });

    // The rows are examples; the count above is the listing.
    expect(entries).toHaveLength(20);
    expect(entriesTruncated).toBe(TRIPS - 20);
    expect(entries.length + entriesTruncated).toBe(report.trips.items);
  });

  it("should count every details item and pass however few rows it keeps", async () => {
    const report = await buildDiagnosticReport(heavyInput());

    expect(report.details.tally).toEqual({
      types: { flight: 200 },
      checkins: { checkedin: 100, nocheckin: 100 },
    });
    expect(report.details.entries).toHaveLength(20);
    expect(report.details.entriesTruncated).toBe(180);

    expect(report.passes.count).toBe(200);
    expect(report.passes.paxTypes).toEqual({ ADT: 180, CHD: 20 });
    expect(report.passes.entries).toHaveLength(20);
    expect(report.passes.entriesTruncated).toBe(180);
  });

  it("should keep the schema skeletons whole, since they are the point", async () => {
    const report = await buildDiagnosticReport(heavyInput());
    const trips = JSON.stringify(report.schema.trips);

    // Both shapes, and how many bookings answered to each.
    expect(trips).toContain("bookingId");
    expect(trips).toContain("itinerary");
    expect(trips).toMatch(/×\d+\/200/);
  });

  it("should keep the interesting rows and fill the rest from the start", async () => {
    // Only the last two trips hold more than one booking.
    const trips = Array.from({ length: 25 }, (_, index) => ({
      tripId: `trip-${index}`,
      flights: index >= 23
        ? [tripBookingOf(0), tripBookingOf(3)]
        : [tripBookingOf(0)],
    }));

    const hash = createHasher("salt");
    const summary = await summarizeTrips(trips, hash);

    expect(summary.entries).toHaveLength(20);
    expect(summary.entriesTruncated).toBe(5);
    // The two worth reading, plus the first eighteen, in the order they arrived.
    expect(summary.entries.filter((entry) => entry.flights > 1)).toHaveLength(2);
    expect(summary.entries[0].tripId).toBe(await hash("trip-0"));
    expect(summary.entries[17].tripId).toBe(await hash("trip-17"));
    expect(summary.entries[18].tripId).toBe(await hash("trip-23"));
    expect(summary.entries[19].tripId).toBe(await hash("trip-24"));
  });

  it("should keep the bookings it could not read when a trip holds too many", async () => {
    const flights = Array.from({ length: 25 }, (_, index) =>
      index === 20 || index === 24 ? { note: "unreadable" } : tripBookingOf(0));

    const summary = await summarizeTrips([{ tripId: "trip-1", flights }], createHasher("salt"));
    const [entry] = summary.entries;

    expect(entry.flights).toBe(25);
    expect(entry.bookings).toHaveLength(20);
    expect(entry.bookingsTruncated).toBe(5);
    expect(entry.bookings.filter((booking) => !booking.parsed)).toHaveLength(2);
    // Counted in full regardless.
    expect(summary.tally.unparsed).toBe(2);
    expect(summary.tally.parsed).toBe(23);
  });
});
