import { describe, it, expect } from "vitest";
import { isInfant, buildDownloadPayload, decodeCustomerId, filterReadyBookings, extractFlightsFromOrders, sortFlightsByDeparture, sortPassesByDeparture, buildPassBaseName, buildPassFilename, hasBarcode } from "./ryanair";
import type { BoardingPass } from "./ryanair";

/**
 * Fixtures carry only the fields the function under test reads; the rest of a
 * real BoardingPass is irrelevant here, so they are asserted into the type.
 */
function makePass(fields: Record<string, unknown>): BoardingPass {
  return fields as unknown as BoardingPass;
}

describe("Ryanair Logic", () => {
  it("should identify infants correctly", () => {
    expect(isInfant("INF")).toBe(true);
    expect(isInfant("ADT")).toBe(false);
  });

  it("should build download payload correctly", () => {
    const mockPass = makePass({
      sequence: 42,
      arrival: { code: "DUB" },
      departure: { code: "STN" },
      pnr: "ABCDEF",
      paxType: "ADT"
    });

    const payload = buildDownloadPayload(mockPass);

    expect(payload).toEqual({
      sequenceNumber: "42",
      lang: "en",
      arrivalStation: "DUB",
      departureStation: "STN",
      recordLocator: "ABCDEF",
      isInfant: false
    });
  });

  it("should flag infants in the download payload", () => {
    const payload = buildDownloadPayload(makePass({
      sequence: 1,
      arrival: { code: "DUB" },
      departure: { code: "STN" },
      pnr: "ABCDEF",
      paxType: "INF"
    }));

    expect(payload.isInfant).toBe(true);
    expect(payload.sequenceNumber).toBe("1");
  });

  it("should decode customer ID from token", () => {
    // Mock JWT with sub="testcustomer1"
    const token = "header.eyJzdWIiOiJ0ZXN0Y3VzdG9tZXIxIiwiZXhwIjoxNzY2ODIzMzUwfQ.signature";
    expect(decodeCustomerId(token)).toBe("testcustomer1");
  });

  it("should return null for invalid token", () => {
    expect(decodeCustomerId("invalid-token")).toBe(null);
  });

  it("should extract flights from orders", () => {
    const mockOrders = {
      items: [
        {
          rawBooking: {
            bookingId: 101,
            recordLocator: "PNR1",
            flights: [
              { journeyNum: 0, origin: "DUB", destination: "STN", flightNumber: "FR1", times: { departUTC: "2023-01-01T10:00:00Z" } },
              { journeyNum: 1, origin: "STN", destination: "DUB", flightNumber: "FR2", times: { departUTC: "2023-01-05T10:00:00Z" } }
            ],
            checkins: [
              { journeyNum: 0, status: "checkedin" },
              { journeyNum: 1, status: "nocheckin" }
            ]
          }
        }
      ]
    };

    const summaries = extractFlightsFromOrders(mockOrders as any);
    expect(summaries).toHaveLength(2);
    
    // Outbound
    expect(summaries[0]).toMatchObject({ 
      bookingId: 101, 
      pnr: "PNR1", 
      flightNumber: "FR1",
      checkinStatus: "checkedin", 
      isReady: true 
    });

    // Return
    expect(summaries[1]).toMatchObject({ 
      bookingId: 101, 
      pnr: "PNR1", 
      flightNumber: "FR2",
      checkinStatus: "nocheckin", 
      isReady: false 
    });
  });

  it("should filter ready bookings", () => {
    const mockFlights = [
      { bookingId: 101, isReady: false },
      { bookingId: 102, isReady: true },
      { bookingId: 103, isReady: true }
    ];

    const readyIds = filterReadyBookings(mockFlights as any);
    expect(readyIds).toEqual([102, 103]);
  });

  it("should extract check-in window times", () => {
    const mockOrders = {
      items: [
        {
          rawBooking: {
            bookingId: 200,
            recordLocator: "PNR2",
            flights: [
              { 
                journeyNum: 0, 
                origin: "BER", 
                destination: "MAD", 
                flightNumber: "FR99", 
                times: { departUTC: "2026-06-01T10:00:00Z" },
                checkInOpenUTC: "2026-05-01T10:00:00Z",
                checkInCloseUTC: "2026-06-01T08:00:00Z"
              }
            ],
            checkins: [
              { journeyNum: 0, status: "nocheckin" }
            ]
          }
        }
      ]
    };

    const summaries = extractFlightsFromOrders(mockOrders as any);
    expect(summaries[0]).toMatchObject({
      checkinStatus: "nocheckin",
      checkInOpenUTC: "2026-05-01T10:00:00Z",
      checkInCloseUTC: "2026-06-01T08:00:00Z"
    });
  });
});

describe("Pass file names", () => {
  const pass = (overrides: Record<string, unknown> = {}) => makePass({
    pnr: "MOCK01",
    departure: { code: "DUB" },
    arrival: { code: "STN" },
    flight: { carrierCode: "FR", number: "1234" },
    name: { first: "Ryan", last: "Quack" },
    seat: { designator: "1A" },
    ...overrides,
  });

  it("builds a readable name from booking, route, flight, passenger and seat", () => {
    expect(buildPassBaseName(pass())).toBe("mock01_dub-stn_fr1234_ryan_quack_1a");
    expect(buildPassFilename(pass(), "pkpass")).toBe("mock01_dub-stn_fr1234_ryan_quack_1a.pkpass");
  });

  it("strips whitespace and punctuation", () => {
    const name = buildPassBaseName(pass({ name: { first: "Mary Jane", last: "O'Brien-Smith" } }));
    expect(name).toBe("mock01_dub-stn_fr1234_mary_jane_obriensmith_1a");
  });

  it("drops missing parts instead of leaving stray separators", () => {
    expect(buildPassBaseName(pass({ seat: undefined }))).toBe("mock01_dub-stn_fr1234_ryan_quack");
    expect(buildPassBaseName(pass({ seat: { designator: null } }))).toBe("mock01_dub-stn_fr1234_ryan_quack");
    expect(buildPassBaseName(makePass({}))).toBe("");
  });

  it("is unique across a booking that repeats a route with the same seat", () => {
    const legs = [
      pass({ flight: { carrierCode: "FR", number: "1234" } }),
      pass({ flight: { carrierCode: "FR", number: "9876" } }),
    ];
    const names = legs.map(buildPassBaseName);
    expect(new Set(names).size).toBe(2);
  });

  it("is unique across passengers, legs and bookings", () => {
    const names = new Set<string>();
    for (const pnr of ["MOCK01", "MOCK02"]) {
      for (const [from, to] of [["DUB", "STN"], ["STN", "DUB"]]) {
        for (const flightNumber of ["1234", "9876"]) {
          for (const [first, last] of [["Ryan", "Quack"], ["Dana", "Duck"]]) {
            for (const designator of ["1A", "12F"]) {
              names.add(buildPassBaseName(makePass({
                pnr,
                departure: { code: from },
                arrival: { code: to },
                flight: { carrierCode: "FR", number: flightNumber },
                name: { first, last },
                seat: { designator },
              })));
            }
          }
        }
      }
    }
    expect(names.size).toBe(2 * 2 * 2 * 2 * 2);
  });
});

describe("hasBarcode", () => {
  it("accepts a pass with a scannable code", () => {
    expect(hasBarcode(makePass({ barcode: "M1QUACK/RYAN MOCK01 DUBSTNFR 1234" }))).toBe(true);
  });

  it("rejects a pass Ryanair has not issued a code for", () => {
    expect(hasBarcode(makePass({ barcode: null }))).toBe(false);
    expect(hasBarcode(makePass({ barcode: undefined }))).toBe(false);
    expect(hasBarcode(makePass({}))).toBe(false);
  });

  it("rejects a barcode that is only whitespace", () => {
    expect(hasBarcode(makePass({ barcode: "" }))).toBe(false);
    expect(hasBarcode(makePass({ barcode: "   " }))).toBe(false);
    expect(hasBarcode(makePass({ barcode: "\n\t " }))).toBe(false);
  });

  it("keeps a code that is padded but not empty", () => {
    expect(hasBarcode(makePass({ barcode: "  M1QUACK/RYAN  " }))).toBe(true);
  });
});

describe("Flight ordering", () => {
  /** One booking per flight, so input order is entirely up to the caller. */
  function ordersFor(departures: Array<string | undefined>) {
    return {
      items: departures.map((departUTC, i) => ({
        rawBooking: {
          bookingId: 100 + i,
          recordLocator: `PNR${i}`,
          flights: [{
            journeyNum: 0,
            origin: "DUB",
            destination: "STN",
            flightNumber: `FR${i}`,
            times: departUTC === undefined ? undefined : { departUTC },
          }],
          checkins: [{ journeyNum: 0, status: "nocheckin" }],
        },
      })),
    };
  }

  it("should sort flights by departure whatever order they arrive in", () => {
    const summaries = extractFlightsFromOrders(ordersFor([
      "2026-06-01T10:00:00Z",
      "2026-01-15T10:00:00Z",
      "2026-12-24T10:00:00Z",
      "2026-03-08T10:00:00Z",
    ]) as any);

    expect(summaries.map(f => f.date)).toEqual([
      "2026-01-15T10:00:00Z",
      "2026-03-08T10:00:00Z",
      "2026-06-01T10:00:00Z",
      "2026-12-24T10:00:00Z",
    ]);
  });

  it("should sort the legs of one booking too", () => {
    const orders = {
      items: [{
        rawBooking: {
          bookingId: 101,
          recordLocator: "PNR1",
          flights: [
            { journeyNum: 1, origin: "STN", destination: "DUB", flightNumber: "FR2", times: { departUTC: "2026-01-05T10:00:00Z" } },
            { journeyNum: 0, origin: "DUB", destination: "STN", flightNumber: "FR1", times: { departUTC: "2026-01-01T10:00:00Z" } },
          ],
          checkins: [{ journeyNum: 0, status: "checkedin" }, { journeyNum: 1, status: "nocheckin" }],
        },
      }],
    };

    expect(extractFlightsFromOrders(orders as any).map(f => f.flightNumber)).toEqual(["FR1", "FR2"]);
  });

  it("should put flights with no usable date last, in the order they came", () => {
    const summaries = extractFlightsFromOrders(ordersFor([
      undefined,
      "2026-06-01T10:00:00Z",
      "not-a-date",
      "2026-01-15T10:00:00Z",
    ]) as any);

    expect(summaries.map(f => f.flightNumber)).toEqual(["FR3", "FR1", "FR0", "FR2"]);
  });

  it("should sort flights already in order without disturbing them", () => {
    const dates = ["2026-01-15T10:00:00Z", "2026-02-15T10:00:00Z", "2026-03-15T10:00:00Z"];
    expect(extractFlightsFromOrders(ordersFor(dates) as any).map(f => f.date)).toEqual(dates);
  });
});

describe("Pass ordering", () => {
  /** Ryanair sends a millisecond epoch alongside the ISO time; some fixtures have only one. */
  const passAt = (pnr: string, departure: Record<string, unknown>) =>
    makePass({ pnr, departure });

  it("should sort passes by departure, falling back to the ISO time", () => {
    const passes = [
      passAt("LATE", { epoch: Date.parse("2026-03-15T10:00:00Z"), dateUTC: "2026-03-15T10:00:00Z" }),
      passAt("EARLY", { epoch: 0, dateUTC: "2026-01-15T10:00:00Z" }),
      passAt("MID", { epoch: Date.parse("2026-02-15T10:00:00Z"), dateUTC: "2026-02-15T10:00:00Z" }),
    ];

    expect(sortPassesByDeparture(passes).map(p => p.pnr)).toEqual(["EARLY", "MID", "LATE"]);
  });

  it("should put passes with no usable time last, in the order they came", () => {
    const passes = [
      passAt("NOTIME", { epoch: 0 }),
      passAt("LATE", { epoch: Date.parse("2026-03-15T10:00:00Z") }),
      passAt("BADTIME", { epoch: 0, dateUTC: "not-a-date" }),
      passAt("EARLY", { epoch: Date.parse("2026-01-15T10:00:00Z") }),
    ];

    expect(sortPassesByDeparture(passes).map(p => p.pnr)).toEqual(["EARLY", "LATE", "NOTIME", "BADTIME"]);
  });

  it("should leave the caller's arrays alone", () => {
    const passes = [
      passAt("LATE", { epoch: Date.parse("2026-03-15T10:00:00Z") }),
      passAt("EARLY", { epoch: Date.parse("2026-01-15T10:00:00Z") }),
    ];
    const flights = [
      { date: "2026-03-15T10:00:00Z" },
      { date: "2026-01-15T10:00:00Z" },
    ] as any;

    expect(sortPassesByDeparture(passes).map(p => p.pnr)).toEqual(["EARLY", "LATE"]);
    expect(passes.map(p => p.pnr)).toEqual(["LATE", "EARLY"]);

    expect(sortFlightsByDeparture(flights)[0].date).toBe("2026-01-15T10:00:00Z");
    expect(flights[0].date).toBe("2026-03-15T10:00:00Z");
  });
});
