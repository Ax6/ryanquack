import { describe, it, expect } from "vitest";
import { isInfant, buildDownloadPayload, decodeCustomerId, filterReadyBookings, extractFlightsFromOrders } from "./ryanair";

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
});
