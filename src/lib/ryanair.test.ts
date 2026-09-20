import { describe, it, expect } from "vitest";
import { isInfant, buildDownloadPayload, decodeCustomerId, filterReadyBookings, extractFlightsFromOrders, extractFlightsFromTrips, markUnconfirmedFlights, mergeFlights, sortFlightsByDeparture, sortPassesByDeparture, buildPassBaseName, buildPassFilename, hasBarcode } from "./ryanair";
import type { BoardingPass, FlightSummary } from "./ryanair";

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

describe("Trip listing", () => {
  /** One trip holding `count` bookings on the same flight — issue #20 in miniature. */
  function tripWith(count: number) {
    return {
      tripId: "trip-1",
      startDate: "2026-09-22T06:00:00Z",
      flights: Array.from({ length: count }, (_, i) => ({
        bookingId: 5000 + i,
        pnr: `GROUP${i}`,
        origin: "STN",
        destination: "DUB",
        journeys: [{ segments: [{ flightNumber: "FR1000", departureDateUTC: "2026-09-22T06:00:00Z" }] }],
      })),
    };
  }

  it("should walk every booking of every trip, not just the first", () => {
    const flights = extractFlightsFromTrips({ items: [tripWith(7)] });

    expect(flights).toHaveLength(7);
    expect(flights.map(f => f.bookingId)).toEqual([5000, 5001, 5002, 5003, 5004, 5005, 5006]);
    expect(flights[0]).toMatchObject({
      pnr: "GROUP0",
      origin: "STN",
      destination: "DUB",
      flightNumber: "FR1000",
      date: "2026-09-22T06:00:00Z",
      checkinStatus: "unknown",
      isReady: true,
    });
    expect(flights[0].checkInOpenUTC).toBeUndefined();
  });

  it("should accept the response object or its items", () => {
    expect(extractFlightsFromTrips([tripWith(2)])).toHaveLength(2);
    expect(extractFlightsFromTrips({ items: [tripWith(2)] })).toHaveLength(2);
  });

  it("should ignore trips that hold no flights", () => {
    const flights = extractFlightsFromTrips({
      items: [
        { tripId: "cars-only", cars: [{ id: 1 }], rooms: [{ id: 2 }], events: [{ id: 3 }] },
        { tripId: "not-an-array", flights: "nope" },
        tripWith(1),
      ],
    });

    expect(flights.map(f => f.bookingId)).toEqual([5000]);
  });

  it("should build one flight per segment, falling back to the journey and the booking", () => {
    const flights = extractFlightsFromTrips({ items: [{
      flights: [
        {
          bookingId: 1,
          journeys: [
            { segments: [{ flightNumber: "FR1" }, { flightNumber: "FR2" }] },
            { segments: [{ flightNumber: "FR3" }] },
          ],
        },
        { bookingId: 2, journeys: [{ flightNumber: "FR4", departureDate: "2026-01-01" }] },
        { bookingId: 3, flightNumber: "FR5", startDate: "2026-02-02" },
      ],
    }] });

    expect(flights.map(f => `${f.bookingId}:${f.flightNumber}`))
      .toEqual(["1:FR1", "1:FR2", "1:FR3", "2:FR4", "3:FR5"]);
    expect(flights[3].date).toBe("2026-01-01");
    expect(flights[4].date).toBe("2026-02-02");
  });

  it.each([
    [{ flightNumber: "FR11" }, "FR11"],
    [{ flightNo: "FR22" }, "FR22"],
    [{ number: "33" }, "33"],
    [{ carrierCode: "FR", number: "44" }, "FR44"],
    [{ seat: "1A" }, ""],
  ])("should read the flight number out of %o", (segment, expected) => {
    const flights = extractFlightsFromTrips({ items: [{ flights: [{ bookingId: 1, journeys: [{ segments: [segment] }] }] }] });
    expect(flights[0].flightNumber).toBe(expected);
  });

  it.each([
    "departUTC", "departureUTC", "departureDateUTC", "departureDate", "depart", "departure", "startDate",
  ])("should read the departure time out of %s", (key) => {
    const flights = extractFlightsFromTrips({
      items: [{ flights: [{ bookingId: 1, journeys: [{ segments: [{ [key]: "2026-03-03T08:00:00Z" }] }] }] }],
    });
    expect(flights[0].date).toBe("2026-03-03T08:00:00Z");
  });

  it("should leave the date empty rather than guess at an object", () => {
    const flights = extractFlightsFromTrips({
      items: [{ flights: [{ bookingId: 1, journeys: [{ segments: [{ departure: { code: "STN" } }] }] }] }],
    });
    expect(flights[0].date).toBe("");
  });

  it("should drop bookings with no usable id and keep their neighbours", () => {
    const flights = extractFlightsFromTrips({
      items: [{ flights: [{ pnr: "NOID" }, { bookingId: "not-a-number" }, { bookingId: "77", pnr: "OK" }] }],
    });

    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ bookingId: 77, pnr: "OK" });
  });

  it("should never throw on an odd shape", () => {
    const hostile = { get flights() { throw new Error("boom"); } };

    expect(() => extractFlightsFromTrips(null)).not.toThrow();
    expect(() => extractFlightsFromTrips({ items: [null, 7, "x", []] })).not.toThrow();
    expect(extractFlightsFromTrips({ items: [{ flights: [hostile, { bookingId: 5 }] }] }))
      .toHaveLength(1);
  });
});

describe("Merging the two listings", () => {
  const flight = (fields: Partial<FlightSummary>): FlightSummary => ({
    bookingId: 0, pnr: "", origin: "", destination: "", date: "",
    flightNumber: "", checkinStatus: "unknown", isReady: true, ...fields,
  });

  it("should keep the details entry where both listings know the booking", () => {
    const fromDetails = [flight({ bookingId: 1, checkinStatus: "checkedin", date: "2026-01-02T10:00:00Z" })];
    const fromTrips = [flight({ bookingId: 1, checkinStatus: "unknown", date: "2026-01-02T10:00:00Z" })];

    const merged = mergeFlights(fromDetails, fromTrips);

    expect(merged).toHaveLength(1);
    expect(merged[0].checkinStatus).toBe("checkedin");
  });

  it("should add the bookings only the trip listing knows about", () => {
    const fromDetails = [flight({ bookingId: 1, date: "2026-01-03T10:00:00Z" })];
    const fromTrips = [
      flight({ bookingId: 1, date: "2026-01-03T10:00:00Z" }),
      flight({ bookingId: 2, date: "2026-01-01T10:00:00Z" }),
      flight({ bookingId: 3, date: "2026-01-02T10:00:00Z" }),
    ];

    expect(mergeFlights(fromDetails, fromTrips).map(f => f.bookingId)).toEqual([2, 3, 1]);
  });

  it("should keep every leg of a booking that has more than one", () => {
    const fromDetails = [
      flight({ bookingId: 1, flightNumber: "OUT", date: "2026-01-01T10:00:00Z" }),
      flight({ bookingId: 1, flightNumber: "BACK", date: "2026-01-08T10:00:00Z" }),
    ];

    expect(mergeFlights(fromDetails, []).map(f => f.flightNumber)).toEqual(["OUT", "BACK"]);
    expect(mergeFlights([], fromDetails)).toHaveLength(2);
  });

  it("should leave the caller's arrays alone", () => {
    const fromDetails = [flight({ bookingId: 2, date: "2026-02-01T10:00:00Z" })];
    const fromTrips = [flight({ bookingId: 1, date: "2026-01-01T10:00:00Z" })];

    mergeFlights(fromDetails, fromTrips);

    expect(fromDetails.map(f => f.bookingId)).toEqual([2]);
    expect(fromTrips.map(f => f.bookingId)).toEqual([1]);
  });
});

describe("Reconciling trip-listing bookings against the passes", () => {
  const flight = (fields: Partial<FlightSummary>): FlightSummary => ({
    bookingId: 0, pnr: "", origin: "", destination: "", date: "",
    flightNumber: "", checkinStatus: "unknown", isReady: true, ...fields,
  });

  const pass = (fields: Record<string, unknown>) => fields as unknown as BoardingPass;

  it("should move a trip-listing booking with no pass into the upcoming list", () => {
    const flights = [flight({ bookingId: 9001, pnr: "GROUP1" })];

    const marked = markUnconfirmedFlights(flights, [pass({ pnr: "OTHER1" })]);

    expect(marked[0]).toMatchObject({ bookingId: 9001, isReady: false, checkinStatus: "unknown" });
    // The caller's array is left alone.
    expect(flights[0].isReady).toBe(true);
  });

  it("should leave a trip-listing booking that did produce a pass alone", () => {
    const marked = markUnconfirmedFlights(
      [flight({ bookingId: 9001, pnr: "GROUP1" })],
      [pass({ pnr: "group1" })]
    );

    expect(marked[0].isReady).toBe(true);
  });

  it("should match on the booking id when the pass carries one", () => {
    const marked = markUnconfirmedFlights(
      [flight({ bookingId: 9001, pnr: "GROUP1" }), flight({ bookingId: 9002, pnr: "GROUP2" })],
      [pass({ bookingId: 9001, pnr: "SOMETHINGELSE" })]
    );

    expect(marked.map(f => f.isReady)).toEqual([true, false]);
  });

  it("should never touch a flight that came from the details listing", () => {
    const marked = markUnconfirmedFlights(
      [
        flight({ bookingId: 1, checkinStatus: "checkedin" }),
        flight({ bookingId: 2, checkinStatus: "nocheckin", isReady: false }),
      ],
      []
    );

    expect(marked.map(f => f.isReady)).toEqual([true, false]);
  });

  it("should flip every unconfirmed booking when no pass came back at all", () => {
    const marked = markUnconfirmedFlights(
      [flight({ bookingId: 9001 }), flight({ bookingId: 9002, pnr: "GROUP2" })],
      []
    );

    expect(marked.map(f => f.isReady)).toEqual([false, false]);
  });

  it("should keep a flight it cannot match against passes that did arrive", () => {
    // No pnr on the flight, no booking id on the pass: nothing to compare.
    const marked = markUnconfirmedFlights([flight({ bookingId: 9001, pnr: "" })], [pass({ pnr: "" })]);

    expect(marked[0].isReady).toBe(true);
  });

  it("should keep every flight, whatever it decides", () => {
    const flights = [
      flight({ bookingId: 1, checkinStatus: "checkedin" }),
      flight({ bookingId: 9001, pnr: "GROUP1" }),
      flight({ bookingId: 9002, pnr: "GROUP2" }),
    ];

    const marked = markUnconfirmedFlights(flights, [pass({ pnr: "GROUP1" })]);

    expect(marked.map(f => f.bookingId)).toEqual([1, 9001, 9002]);
    expect(marked.map(f => f.isReady)).toEqual([true, true, false]);
  });
});
