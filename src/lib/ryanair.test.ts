import { describe, it, expect } from "vitest";
import { isInfant, buildDownloadPayload, decodeCustomerId, filterReadyBookings, extractFlightsFromOrders, bookingSource, classifyLeg, countBookings, hasMatchingPass, indexPasses, markUnconfirmedFlights, sortFlightsByDeparture, sortPassesByDeparture, buildPassBaseName, buildPassFilename, hasBarcode } from "./ryanair";
import type { OrderItem } from "./ryanair";
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
              { journeyNum: 0, status: "checkin" },
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
      checkinStatus: "checkin",
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

  it("should extract check-in window times, including the free window and bought seats", () => {
    // Free check-in opens 24 hours out; Ryanair's own field for it says 48.
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
                checkInOpenUTC: "2026-04-02T10:00:00Z",
                checkInFreeAllocateOpenUtcDate: "2026-05-30T10:00:00Z",
                checkInCloseUTC: "2026-06-01T08:00:00Z"
              },
              {
                journeyNum: 1,
                origin: "MAD",
                destination: "BER",
                flightNumber: "FR98",
                times: { departUTC: "2026-06-08T10:00:00Z" },
              }
            ],
            checkins: [
              { journeyNum: 0, status: "nocheckin", paxNum: 0, segmentNum: 0 },
              { journeyNum: 1, status: "nocheckin", paxNum: 0, segmentNum: 0 }
            ],
            seats: [{ journeyNum: 1, paxNum: 0, segmentNum: 0, code: "12A" }],
          }
        }
      ]
    };

    const [outbound, inbound] = extractFlightsFromOrders(mockOrders as any);
    expect(outbound).toMatchObject({
      checkinStatus: "nocheckin",
      checkInOpenUTC: "2026-04-02T10:00:00Z",
      checkInFreeOpenUTC: "2026-05-31T10:00:00.000Z",
      checkInCloseUTC: "2026-06-01T08:00:00Z",
      hasSeat: false,
    });
    expect(inbound).toMatchObject({ checkinStatus: "nocheckin", hasSeat: true, checkInFreeOpenUTC: "2026-06-07T10:00:00.000Z" });
  });

  it("should count distinct bookings behind the legs", () => {
    expect(countBookings([
      { bookingId: 1 }, { bookingId: 1 }, { bookingId: 2 },
    ] as FlightSummary[])).toBe(2);
    expect(countBookings([])).toBe(0);
  });
});

describe("Check-in status of a leg", () => {
  it("should say a leg nobody has done anything on is not checked in", () => {
    expect(classifyLeg(["nocheckin"]))
      .toEqual({ status: "nocheckin", ready: false, allCheckedIn: false, flown: false });
    expect(classifyLeg(["nocheckin", "nocheckin", "nocheckin"]))
      .toEqual({ status: "nocheckin", ready: false, allCheckedIn: false, flown: false });
  });

  it("should treat travel documents as not checked in, but still worth asking about", () => {
    // Ryanair's first check-in step. It produces no boarding pass, which the
    // reconcile discovers, so asking costs one request and never a booking.
    expect(classifyLeg(["documentsadded"]))
      .toEqual({ status: "documentsadded", ready: true, allCheckedIn: false, flown: false });
    expect(classifyLeg(["documentsadded", "documentsadded"]))
      .toEqual({ status: "documentsadded", ready: true, allCheckedIn: false, flown: false });
  });

  it("should say a leg every passenger has checked in on is checked in", () => {
    expect(classifyLeg(["checkin", "checkin"]))
      .toEqual({ status: "checkin", ready: true, allCheckedIn: true, flown: false });
  });

  it("should keep a leg in the list while anyone on it has not checked in", () => {
    // The passes of those who have are still fetched; the label says what is
    // missing for the rest, so a family of three with one pass sees the leg.
    expect(classifyLeg(["nocheckin", "checkin", "documentsadded"]))
      .toEqual({ status: "nocheckin", ready: true, allCheckedIn: false, flown: false });
    expect(classifyLeg(["checkin", "documentsadded"]))
      .toEqual({ status: "documentsadded", ready: true, allCheckedIn: false, flown: false });
    expect(classifyLeg(["nocheckin", "documentsadded", "nocheckin"]))
      .toEqual({ status: "nocheckin", ready: false, allCheckedIn: false, flown: false });
  });

  it("should treat a status it has never seen as possibly holding a pass", () => {
    expect(classifyLeg(["Boarded"])).toEqual({ status: "boarded", ready: true, allCheckedIn: true, flown: false });
  });

  it("should mark a leg every passenger has flown", () => {
    expect(classifyLeg(["flown"])).toEqual({ status: "flown", ready: false, flown: true });
    expect(classifyLeg(["flown", "flown"])).toEqual({ status: "flown", ready: false, flown: true });
    // One passenger still to fly is a leg still to fly.
    expect(classifyLeg(["flown", "nocheckin"]))
      .toEqual({ status: "nocheckin", ready: false, allCheckedIn: false, flown: false });
  });

  it("should ask about a leg with no records at all rather than assume", () => {
    expect(classifyLeg([])).toEqual({ status: "unknown", ready: true, flown: false });
    expect(classifyLeg([null, undefined, ""])).toEqual({ status: "unknown", ready: true, flown: false });
  });
});

describe("Reading the orders listing", () => {
  const leg = (journeyNum: number, departUTC: string, flightNumber = `FR${journeyNum}`) => ({
    journeyNum, origin: "STN", destination: "DUB", flightNumber, times: { departUTC },
  });

  it("should read every passenger's record for the leg, not the first one's", () => {
    // One of two has checked in: their pass is worth fetching, and the leg stays
    // listed for the other. Reading only the first record missed both.
    const [flight] = extractFlightsFromOrders({ items: [{ rawBooking: {
      bookingId: 1, recordLocator: "GROUP1",
      flights: [leg(0, "2026-09-22T06:00:00Z")],
      checkins: [
        { journeyNum: 0, paxNum: 0, segmentNum: 0, status: "nocheckin" },
        { journeyNum: 0, paxNum: 1, segmentNum: 0, status: "checkin" },
      ],
    } }] });

    expect(flight).toMatchObject({ checkinStatus: "nocheckin", isReady: true, allCheckedIn: false });
  });

  it("should drop a leg that has flown and keep the one still to come", () => {
    const flights = extractFlightsFromOrders({ items: [{ rawBooking: {
      bookingId: 1, recordLocator: "RETURN",
      flights: [leg(0, "2026-09-19T06:00:00Z"), leg(1, "2026-09-26T06:00:00Z")],
      checkins: [
        { journeyNum: 0, paxNum: 0, segmentNum: 0, status: "flown" },
        { journeyNum: 1, paxNum: 0, segmentNum: 0, status: "documentsadded" },
      ],
    } }] });

    expect(flights.map((flight) => flight.flightNumber)).toEqual(["FR1"]);
    expect(flights[0]).toMatchObject({ checkinStatus: "documentsadded", isReady: true });
  });

  it("should read the booking out of the payload when Ryanair failed to load it", () => {
    const item: OrderItem = {
      tripId: "trip-1", productId: "1", type: "flight",
      payload: { booking: {
        bookingId: 4242, pnr: "PAYLD1", origin: "STN", destination: "DUB",
        journeys: [
          { segments: [
            { origin: "STN", destination: "DUB", flightNumber: "FR1000", departureTime: "2026-09-22T06:00:00Z" },
          ] },
          { segments: [
            { origin: "DUB", destination: "BER", flightNumber: "FR2000", departureTime: "2026-09-29T06:00:00Z" },
            { origin: "BER", destination: "STN", flightNumber: "FR2001", departureTime: "2026-09-29T10:00:00Z" },
          ] },
        ],
      } },
      rawBookingFailure: { message: "timeout" },
    };

    const flights = extractFlightsFromOrders({ items: [item] }, Date.parse("2026-09-20T00:00:00Z"));

    expect(bookingSource(item)).toBe("payload");
    expect(flights).toHaveLength(2);
    expect(flights[0]).toMatchObject({
      bookingId: 4242, pnr: "PAYLD1", origin: "STN", destination: "DUB",
      flightNumber: "FR1000", date: "2026-09-22T06:00:00Z",
      checkinStatus: "unknown", isReady: true,
    });
    // A connecting journey is one leg, from its first station to its last.
    expect(flights[1]).toMatchObject({ origin: "DUB", destination: "STN", flightNumber: "FR2000" });

    // Once the outbound has left, only the return is still to come.
    expect(extractFlightsFromOrders({ items: [item] }, Date.parse("2026-09-25T00:00:00Z"))
      .map((flight) => flight.flightNumber)).toEqual(["FR2000"]);
  });

  it("should prefer the raw booking when both are there", () => {
    const item: OrderItem = {
      payload: { booking: { bookingId: 1, pnr: "PAYLD1", journeys: [{ segments: [{ flightNumber: "WRONG" }] }] } },
      rawBooking: { bookingId: 1, recordLocator: "RAW001", flights: [leg(0, "2026-09-22T06:00:00Z")], checkins: [] },
    };

    expect(bookingSource(item)).toBe("rawBooking");
    expect(extractFlightsFromOrders({ items: [item] }).map((flight) => flight.pnr)).toEqual(["RAW001"]);
  });

  it("should say when an item holds nothing it can read", () => {
    const item: OrderItem = { tripId: "trip-1", rawBookingFailure: "boom" };

    expect(bookingSource(item)).toBe("none");
    expect(extractFlightsFromOrders({ items: [item] })).toEqual([]);
    expect(extractFlightsFromOrders({ items: [{ payload: { booking: { pnr: "NOID00", journeys: [] } } }] })).toEqual([]);
  });

  it("should fall back to the payload when the raw booking lists no flights at all", () => {
    // An empty array is truthy; it must not count as a booking that was read.
    const item: OrderItem = {
      rawBooking: { bookingId: 7, recordLocator: "EMPTY1", flights: [], checkins: [] },
      payload: { booking: { bookingId: 7, pnr: "EMPTY1", journeys: [{ segments: [
        { origin: "STN", destination: "DUB", flightNumber: "FR9", departureTime: "2026-10-10T06:00:00Z" },
      ] }] } },
    };

    expect(bookingSource(item)).toBe("payload");
    expect(extractFlightsFromOrders({ items: [item] }, Date.parse("2026-09-20T00:00:00Z"))).toHaveLength(1);
  });

  it("should read a booking repeated across two pages once", () => {
    // A cursor over a list that changes under it can hand the seam back twice.
    const item: OrderItem = {
      rawBooking: { bookingId: 1, recordLocator: "TWICE1", flights: [leg(0, "2026-09-22T06:00:00Z")], checkins: [] },
    };

    const flights = extractFlightsFromOrders({ items: [item, { ...item }] });

    expect(flights).toHaveLength(1);
    expect(filterReadyBookings(flights)).toEqual([1]);
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

describe("Reconciling the list against the passes", () => {
  const flight = (fields: Partial<FlightSummary>): FlightSummary => ({
    bookingId: 0, pnr: "", origin: "", destination: "", date: "",
    flightNumber: "", checkinStatus: "unknown", isReady: true, ...fields,
  });

  const pass = (fields: Record<string, unknown>) => fields as unknown as BoardingPass;

  /** The invariant: a ready flight is one a returned pass speaks for. */
  function rendersSomewhere(flights: FlightSummary[], passes: BoardingPass[]): boolean {
    const index = indexPasses(passes);
    return markUnconfirmedFlights(flights, passes)
      .every((f) => !f.isReady || hasMatchingPass(f, index));
  }

  it("should move a booking with no pass into the upcoming list", () => {
    const flights = [flight({ bookingId: 9001, pnr: "GROUP1" })];

    const marked = markUnconfirmedFlights(flights, [pass({ pnr: "OTHER1" })]);

    expect(marked[0]).toMatchObject({ bookingId: 9001, isReady: false, checkinStatus: "unknown" });
    // The caller's array is left alone.
    expect(flights[0].isReady).toBe(true);
  });

  it("should leave a booking that did produce a pass alone", () => {
    const marked = markUnconfirmedFlights(
      [flight({ bookingId: 9001, pnr: "GROUP1" })],
      [pass({ pnr: "group1" })]
    );

    expect(marked[0].isReady).toBe(true);
  });

  it("should not let the outbound pass speak for the return leg", () => {
    // Outbound checked in, return with documents added: one pass comes back,
    // for the outbound. Matching by booking alone hid the return leg entirely.
    const marked = markUnconfirmedFlights(
      [
        flight({ bookingId: 500, pnr: "QWE123", origin: "STN", destination: "DUB", checkinStatus: "checkin", allCheckedIn: true }),
        flight({ bookingId: 500, pnr: "QWE123", origin: "DUB", destination: "STN", checkinStatus: "documentsadded", allCheckedIn: false }),
      ],
      [pass({ pnr: "QWE123", departure: { code: "STN" } })]
    );

    expect(marked.map(f => f.isReady)).toEqual([true, false]);
  });

  it("should match a leg by where its pass departs, whatever the case", () => {
    const flights = [
      flight({ bookingId: 1, pnr: "ABC123", origin: "STN", allCheckedIn: true }),
      flight({ bookingId: 1, pnr: "ABC123", origin: "DUB", allCheckedIn: true }),
    ];

    const marked = markUnconfirmedFlights(flights, [
      pass({ pnr: "abc123", departure: { code: "stn" } }),
      pass({ pnr: "ABC123", departure: { code: " DUB " } }),
    ]);

    expect(marked.map(f => f.isReady)).toEqual([true, true]);
  });

  it("should let a pass that does not say where it departs cover any leg of its booking", () => {
    // Stricter matching than the data allows would list the leg twice, which is
    // visible; but a pass with no station is matched the old way rather than dropped.
    const marked = markUnconfirmedFlights(
      [flight({ bookingId: 1, pnr: "GROUP1", origin: "STN", allCheckedIn: true })],
      [pass({ pnr: "GROUP1" })]
    );

    expect(marked[0].isReady).toBe(true);
  });

  it("should keep a leg in the list while a passenger on it has no pass", () => {
    // Two of three checked in: their passes show, and so does the leg, labelled
    // with what the third still has to do.
    const marked = markUnconfirmedFlights(
      [flight({ bookingId: 1, pnr: "FAM001", origin: "STN", checkinStatus: "nocheckin", allCheckedIn: false })],
      [pass({ pnr: "FAM001", departure: { code: "STN" } }), pass({ pnr: "FAM001", departure: { code: "STN" } })]
    );

    expect(marked[0].isReady).toBe(false);
  });

  it("should flip a details flight whose pass never came back, whatever its status said", () => {
    // A check-in status is not a pass. Trusting it left a checked-in booking out
    // of the pass list and out of the upcoming list both.
    const marked = markUnconfirmedFlights(
      [
        flight({ bookingId: 1, pnr: "GOTONE", checkinStatus: "checkedin" }),
        flight({ bookingId: 2, pnr: "NOPASS", checkinStatus: "checkedin" }),
        flight({ bookingId: 3, pnr: "LATER1", checkinStatus: "nocheckin", isReady: false }),
      ],
      [pass({ pnr: "GOTONE" })]
    );

    expect(marked.map(f => f.isReady)).toEqual([true, false, false]);
  });

  it("should flip every unconfirmed booking when no pass came back at all", () => {
    const marked = markUnconfirmedFlights(
      [flight({ bookingId: 9001 }), flight({ bookingId: 9002, pnr: "GROUP2" })],
      []
    );

    expect(marked.map(f => f.isReady)).toEqual([false, false]);
  });

  it("should flip everything when the passes carry nothing to match on", () => {
    // Passes arrived, but with no id and no pnr, so matching failed wholesale.
    // Every booking is listed twice, which is visible; guessing they are all
    // covered loses them, which is not.
    const flights = [flight({ bookingId: 9001, pnr: "" }), flight({ bookingId: 9002, pnr: "GROUP2" })];
    const passes = [pass({ pnr: "" }), pass({ pnr: "   " })];

    expect(markUnconfirmedFlights(flights, passes).map(f => f.isReady)).toEqual([false, false]);
    expect(rendersSomewhere(flights, passes)).toBe(true);
  });

  it("should keep every flight, and leave none of them rendering nowhere", () => {
    const flights = [
      flight({ bookingId: 1, pnr: "GROUP1", checkinStatus: "checkedin" }),
      flight({ bookingId: 9001, pnr: "GROUP1" }),
      flight({ bookingId: 9002, pnr: "GROUP2" }),
    ];

    const marked = markUnconfirmedFlights(flights, [pass({ pnr: "GROUP1" })]);

    expect(marked.map(f => f.bookingId)).toEqual([1, 9001, 9002]);
    expect(marked.map(f => f.isReady)).toEqual([true, true, false]);
    expect(rendersSomewhere(flights, [pass({ pnr: "GROUP1" })])).toBe(true);
  });

  it.each([
    ["no passes", []],
    ["unmatchable passes", [{ pnr: "" }]],
    ["passes for other bookings", [{ pnr: "OTHER1" }, { bookingId: 12345, pnr: "OTHER2" }]],
    ["a pass for one of them", [{ pnr: "GROUP2" }]],
  ])("should leave nothing rendering nowhere given %s", (_case, passes) => {
    const flights = [
      flight({ bookingId: 1, pnr: "GROUP1", checkinStatus: "checkedin" }),
      flight({ bookingId: 2, pnr: "GROUP2", checkinStatus: "nocheckin", isReady: false }),
      flight({ bookingId: 9003, pnr: "" }),
      flight({ bookingId: 9004, pnr: "GROUP4" }),
    ];

    expect(rendersSomewhere(flights, passes.map(pass))).toBe(true);
  });
});

describe("Download payload", () => {
  it("should survive a pass missing an airport rather than fail the whole refresh", () => {
    const pass = { pnr: "MOCK01", sequence: 3, paxType: "ADT", departure: { code: "DUB" } } as unknown as BoardingPass;

    expect(buildDownloadPayload(pass)).toEqual({
      sequenceNumber: "3", lang: "en", arrivalStation: "", departureStation: "DUB",
      recordLocator: "MOCK01", isInfant: false,
    });
  });
});
