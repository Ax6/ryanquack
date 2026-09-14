import { describe, it, expect } from "vitest";
import { isInfant, buildDownloadPayload, decodeCustomerId, filterReadyBookings, extractFlightsFromOrders, buildPassBaseName, buildPassFilename } from "./ryanair";

describe("Ryanair Logic", () => {
  it("should identify infants correctly", () => {
    expect(isInfant("INF")).toBe(true);
    expect(isInfant("ADT")).toBe(false);
  });

  it("should build download payload correctly", () => {
    const mockPass = {
      sequence: 42,
      arrival: { code: "DUB" },
      departure: { code: "STN" },
      pnr: "ABCDEF",
      paxType: "ADT"
    };

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

  it("should decode customer ID from token", () => {
    // Mock JWT with sub="4suhppvsu3fz"
    const token = "header.eyJzdWIiOiI0c3VocHB2c3UzZnoiLCJleHAiOjE3NjY4MjMzNTB9.signature";
    expect(decodeCustomerId(token)).toBe("4suhppvsu3fz");
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
  const pass = (overrides: any = {}) => ({
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
    expect(buildPassBaseName({})).toBe("");
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
              names.add(buildPassBaseName({
                pnr,
                departure: { code: from },
                arrival: { code: to },
                flight: { carrierCode: "FR", number: flightNumber },
                name: { first, last },
                seat: { designator },
              }));
            }
          }
        }
      }
    }
    expect(names.size).toBe(2 * 2 * 2 * 2 * 2);
  });
});
