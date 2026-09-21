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
  summarizeList,
  summarizePasses,
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

  it("should reach a deeply nested itinerary", () => {
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
        checkins: [{ journeyNum: 0, status: "checkin" }],
      },
      processingStatus: { code: "PROCESSED", reason: null },
      rawBookingFailure: null,
    },
    {
      // Ryanair could not load the booking: only the site's own view of it is there.
      tripId: "trip-2", productId: "9001", type: "flight",
      payload: { booking: {
        bookingId: 9001, pnr: "GROUP1", origin: SEED_ORIGIN, destination: SEED_DESTINATION,
        journeys: [{ segments: [{ origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: SEED_FLIGHT, departureTime: SEED_DATE }] }],
      } },
      processingStatus: { code: "FAILED", reason: "upstream timeout" },
      rawBookingFailure: { message: "upstream timeout" },
    },
  ],
};

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
  it("should count what the details listing holds, and hash what identifies it", async () => {
    const hash = createHasher("salt");
    const summary = await summarizeDetails(ORDERS, hash);

    expect(summary).toMatchObject({
      items: 2,
      distinctTripIds: 2,
      distinctProductIds: 2,
      distinctBookingIds: 2,
      tally: {
        types: { flight: 2 },
        checkins: { checkin: 1 },
        sources: { rawBooking: 1, payload: 1 },
        processingStatuses: { PROCESSED: 1, FAILED: 1 },
        rawBookingFailures: 1,
      },
    });
    expect(summary.entries[0]).toEqual({
      type: "flight",
      tripId: await hash("trip-1"),
      bookingId: await hash(1000),
      pnr: await hash(SEED_PNR),
      source: "rawBooking",
      legs: 1,
      flownLegs: 0,
      parsedLegs: 1,
      checkins: ["checkin"],
      productId: await hash("1000"),
    });
    // Read from the payload: no raw legs to count, one row all the same.
    expect(summary.entries[1]).toMatchObject({
      source: "payload", legs: 0, flownLegs: 0, parsedLegs: 1, pnr: await hash("GROUP1"), checkins: [],
    });
  });

  it("should count a leg it could not read as unparsed, and a flown leg as flown", async () => {
    const orders = {
      items: [{ rawBooking: { bookingId: 1, recordLocator: "AAA111", flights: [
        { journeyNum: 0, origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: SEED_FLIGHT, times: { departUTC: SEED_DATE } },
        { journeyNum: 1, origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: "" },
        { journeyNum: 2, origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: SEED_FLIGHT, times: { departUTC: SEED_DATE } },
      ], checkins: [{ journeyNum: 2, status: "flown" }] } }],
    } as unknown as OrderResponse;

    expect((await summarizeDetails(orders, createHasher("salt"))).entries[0])
      .toMatchObject({ legs: 3, flownLegs: 1, parsedLegs: 1 });
  });

  it("should count the list the popup shows", () => {
    const flight = (bookingId: number, checkinStatus: string, isReady: boolean): FlightSummary => ({
      bookingId, pnr: `PNR${bookingId}`, origin: "", destination: "", date: "",
      flightNumber: "", checkinStatus, isReady,
    });
    const flights = [
      flight(1, "checkin", true),
      flight(2, "nocheckin", false),
      flight(2, "nocheckin", false),
      flight(3, "documentsadded", false),
    ];
    const passes = [{ pnr: "PNR1" }] as unknown as BoardingPass[];

    expect(summarizeList(flights, [1, 3], passes)).toEqual({
      bookings: 3, flights: 4, ready: 1, upcoming: 3,
      readyBookingIds: 2, bookingIdsWithPasses: 1, renderedNowhere: 0,
      statuses: { checkin: 1, nocheckin: 2, documentsadded: 1 },
    });
  });

  it("should count a booking that renders in neither list", () => {
    // Zero everywhere else in this suite, so a non-zero here is the metric working.
    const stranded: FlightSummary = {
      bookingId: 9001, pnr: "GROUP1", origin: "", destination: "", date: "",
      flightNumber: "", checkinStatus: "checkin", isReady: true,
    };

    expect(summarizeList([stranded], [9001], []))
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
  // As the background builds it: reconciled, so the booking with no pass is
  // already in the upcoming list rather than rendering nowhere.
  const flights = [
    { bookingId: 1000, pnr: SEED_PNR, origin: SEED_ORIGIN, destination: SEED_DESTINATION, date: SEED_DATE, flightNumber: SEED_FLIGHT, checkinStatus: "checkin", isReady: true },
    { bookingId: 9001, pnr: "GROUP1", origin: SEED_ORIGIN, destination: SEED_DESTINATION, date: SEED_DATE, flightNumber: SEED_FLIGHT, checkinStatus: "unknown", isReady: false },
  ];

  return {
    environment: { extensionVersion: "0.5.1", userAgent: CHROME_UA, target: "chrome" },
    endpoints: {
      details: {
        url: newEndpointLog(`https://api/orders/v2/orders/${SEED_CUSTOMER_ID}/details`, SEED_CUSTOMER_ID).url,
        requests: [{ status: 200, durationMs: 120, items: 2 }],
      },
      boardingpasses: {
        url: "https://passes/v1/boardingpasses",
        requests: [{ status: 200, durationMs: 300, items: 1 }, { status: 500, durationMs: 40, items: 0, error: "boardingpasses failed: 500" }],
      },
    },
    orders: ORDERS,
    list: { flights, readyBookingIds: [1000, 9001] },
    passes: PASSES,
    schema: { details: skeleton(ORDERS), boardingpasses: skeleton(PASSES) },
    salt: "fixed-salt",
    now: new Date("2026-09-20T12:00:00Z"),
    ...overrides,
  };
}

describe("the report", () => {
  it("should carry the environment, the endpoint tallies and the list counts", async () => {
    const report = await buildDiagnosticReport(input());

    expect(report).toMatchObject({
      generatedAt: "2026-09-20T12:00:00.000Z",
      extensionVersion: "0.5.1",
      userAgent: "Chrome 141 on macOS",
      target: "chrome",
      list: {
        bookings: 2, flights: 2, ready: 1, upcoming: 1, readyBookingIds: 2,
        bookingIdsWithPasses: 1, renderedNowhere: 0, statuses: { checkin: 1, unknown: 1 },
      },
    });
    expect(report.endpoints.details).toMatchObject({ pages: 1, items: 2, durationMs: 120 });
    expect(report.endpoints.boardingpasses).toMatchObject({ pages: 2, items: 1, durationMs: 340 });
    expect(report.endpoints.boardingpasses.requests[1].error).toContain("500");
    expect(report.details.tally.rawBookingFailures).toBe(1);
    expect(report.passes.count).toBe(2);
    expect(report.passes.paxTypes).toEqual({ ADT: 1, CHD: 1 });
  });

  it("should never serialize a pnr, a name, a barcode, a token or the customer id", async () => {
    const json = JSON.stringify(await buildDiagnosticReport(input()));

    for (const leak of [SEED_PNR, SEED_FIRST, SEED_LAST, SEED_BARCODE, SEED_CUSTOMER_ID, "GROUP1", "12B", "GBR"]) {
      expect(json).not.toContain(leak);
    }
    expect(json).toContain("<cid>");
    // The hashed pnr is there, so a booking and its passes still line up.
    expect(json).toContain(await hashValue(SEED_PNR, "fixed-salt"));
  });

  it("should never serialize a route, a flight number or a date the user is travelling on", async () => {
    // What the reporter refused to post: their itinerary, three times over.
    const json = JSON.stringify(await buildDiagnosticReport(input()));

    for (const leak of [SEED_ORIGIN, SEED_DESTINATION, SEED_FLIGHT, SEED_DATE, "2026-09-22", "upstream timeout"]) {
      expect(json).not.toContain(leak);
    }
    // What it says instead: the shape, and what we made of it.
    expect(json).toContain("departureTime");
    expect(json).toContain("rawBookingFailure");
    expect(json).toContain("parsedLegs");
  });

  it("should hash the same booking to the same value in the listing and the passes", async () => {
    const report = await buildDiagnosticReport(input());

    expect(report.details.entries[0].pnr).toBe(report.passes.entries[0].pnr);
  });

  it("should record the reason an endpoint failed without the fetch having to succeed", async () => {
    const empty = input({
      endpoints: {
        ...input().endpoints,
        details: { url: "https://api/orders/v2/orders/<cid>/details", requests: [], error: "orders failed: 500" },
      },
      orders: { items: [] },
      list: { flights: [], readyBookingIds: [] },
      passes: [],
    });

    const report = await buildDiagnosticReport(empty);

    expect(report.endpoints.details).toMatchObject({ pages: 0, items: 0, error: "orders failed: 500" });
    expect(report.details).toMatchObject({ items: 0, entries: [] });
    expect(report.list).toMatchObject({ bookings: 0, flights: 0 });
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
  const BOOKINGS = 200;

  function heavyOrders(): OrderResponse {
    return {
      items: Array.from({ length: BOOKINGS }, (_, index) => ({
        tripId: `trip-${index}`, productId: String(index), type: "flight",
        payload: { booking: { bookingId: 1000 + index, pnr: `AAA${index}` } },
        rawBooking: {
          bookingId: 1000 + index, recordLocator: `AAA${index}`,
          flights: [{ journeyNum: 0, origin: SEED_ORIGIN, destination: SEED_DESTINATION, flightNumber: SEED_FLIGHT, times: { departUTC: SEED_DATE } }],
          // Groups of up to thirteen, as a real account had.
          checkins: Array.from({ length: 1 + (index % 13) }, (_, pax) => ({
            journeyNum: 0, paxNum: pax, segmentNum: 0, status: index % 2 === 0 ? "checkin" : "nocheckin",
          })),
        },
        processingStatus: { code: "PROCESSED", reason: null },
        rawBookingFailure: null,
      })),
    };
  }

  function heavyPasses(): BoardingPass[] {
    return Array.from({ length: BOOKINGS }, (_, index) => ({
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
    const passes = heavyPasses();
    const flights: FlightSummary[] = Array.from({ length: BOOKINGS }, (_, index) => ({
      bookingId: 1000 + index, pnr: `AAA${index}`, origin: SEED_ORIGIN, destination: SEED_DESTINATION,
      date: SEED_DATE, flightNumber: SEED_FLIGHT, checkinStatus: "checkin", isReady: true,
    }));

    return input({
      orders,
      passes,
      list: { flights, readyBookingIds: flights.map((f) => f.bookingId) },
      schema: { details: skeleton(orders), boardingpasses: skeleton(passes) },
    });
  }

  it("should stay well inside what an issue comment holds, at 200 bookings", async () => {
    const report = await buildDiagnosticReport(heavyInput());

    // GitHub caps a comment at 65,536 characters, and a report nobody can paste
    // costs us the one round we get with a reporter. Indented, because that is
    // the form the popup puts on the clipboard.
    expect(JSON.stringify(report, null, 2).length).toBeLessThan(40_000);
    expect(report.details.items).toBe(BOOKINGS);
  });

  it("should count every details item and pass however few rows it keeps", async () => {
    const report = await buildDiagnosticReport(heavyInput());

    expect(report.details.tally).toMatchObject({
      types: { flight: 200 },
      sources: { rawBooking: 200 },
      processingStatuses: { PROCESSED: 200 },
      rawBookingFailures: 0,
    });
    // 1..13 passengers cycling over 200 bookings: every record counted.
    const records = Object.values(report.details.tally.checkins).reduce((sum, n) => sum + n, 0);
    expect(records).toBe(Array.from({ length: 200 }, (_, i) => 1 + (i % 13)).reduce((a, b) => a + b, 0));
    expect(report.details.entries).toHaveLength(20);
    expect(report.details.entriesTruncated).toBe(180);

    expect(report.passes.count).toBe(200);
    expect(report.passes.paxTypes).toEqual({ ADT: 180, CHD: 20 });
    expect(report.passes.entries).toHaveLength(20);
    expect(report.passes.entriesTruncated).toBe(180);
  });

  it("should keep the schema skeleton whole, since it is the point", async () => {
    const report = await buildDiagnosticReport(heavyInput());
    const details = JSON.stringify(report.schema.details);

    expect(details).toContain("rawBooking");
    expect(details).toContain("checkins");
    expect(details).toMatch(/×\d+\/200/);
  });

  it("should keep the rows worth reading and fill the rest from the start", async () => {
    // Two items Ryanair failed to load, buried at the end of a long listing.
    const orders = heavyOrders();
    for (const index of [190, 199]) {
      const item = orders.items[index];
      delete item.rawBooking;
      item.rawBookingFailure = { message: "timeout" };
      item.payload = { booking: {
        bookingId: 1000 + index, pnr: `AAA${index}`,
        journeys: [{ segments: [{ flightNumber: SEED_FLIGHT, departureTime: SEED_DATE }] }],
      } };
    }

    const hash = createHasher("salt");
    const summary = await summarizeDetails(orders, hash);

    expect(summary.entries).toHaveLength(20);
    expect(summary.entriesTruncated).toBe(180);
    // The two worth reading, plus the first eighteen, in the order they arrived.
    expect(summary.entries.filter((entry) => entry.source === "payload")).toHaveLength(2);
    expect(summary.entries[0].tripId).toBe(await hash("trip-0"));
    expect(summary.entries[17].tripId).toBe(await hash("trip-17"));
    expect(summary.entries[18].tripId).toBe(await hash("trip-190"));
    expect(summary.entries[19].tripId).toBe(await hash("trip-199"));
    expect(summary.tally.rawBookingFailures).toBe(2);
  });
});
