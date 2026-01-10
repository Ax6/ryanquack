export interface FlightSummary {
  bookingId: number;
  pnr: string;
  origin: string;
  destination: string;
  date: string; // ISO date
  flightNumber: string;
  checkinStatus: string; // "nocheckin", "checkedin", etc.
  isReady: boolean;
}

export function extractFlightsFromOrders(orders: OrderResponse): FlightSummary[] {
  if (!orders || !orders.items) return [];

  return orders.items.flatMap((item) => {
    const raw = item.rawBooking;
    if (!raw || !raw.flights) return [];

    return raw.flights.map((flight) => {
      // Find matching check-in status for this journey
      const checkin = raw.checkins?.find(c => c.journeyNum === flight.journeyNum);
      
      return {
        bookingId: raw.bookingId,
        pnr: raw.recordLocator || "",
        origin: flight.origin,
        destination: flight.destination,
        date: flight.times?.departUTC || "",
        flightNumber: flight.flightNumber,
        checkinStatus: checkin?.status || "unknown",
        isReady: checkin?.status !== "nocheckin"
      };
    });
  });
}

export function filterReadyBookings(flights: FlightSummary[]): number[] {
  return flights.filter(f => f.isReady).map(f => f.bookingId);
}

export function isInfant(paxType: string): boolean {
  return paxType === "INF";
}

export function buildDownloadPayload(passItem: any) {
  return {
    sequenceNumber: String(passItem.sequence),
    lang: "en",
    arrivalStation: passItem.arrival.code,
    departureStation: passItem.departure.code,
    recordLocator: passItem.pnr,
    isInfant: isInfant(passItem.paxType)
  };
}

export function decodeCustomerId(token: string): string | null {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));

    const payload = JSON.parse(jsonPayload);
    return payload.sub || null;
  } catch (e) {
    return null;
  }
}

export interface OrderItem {
  rawBooking?: {
    bookingId: number;
    recordLocator?: string;
    flights?: Array<{
      journeyNum: number;
      origin: string;
      destination: string;
      flightNumber: string;
      times?: { departUTC: string };
    }>;
    checkins?: Array<{ status: string; journeyNum: number }>;
  };
}

export interface OrderResponse {
  items: OrderItem[];
}
