/** Passenger name as the boarding pass endpoint returns it. */
export interface PassName {
  title: string;
  first: string;
  last: string;
}

/** One end of a leg: `departure` and `arrival` share this shape. */
export interface PassStation {
  code: string;
  name: string;
  /** Local time, no zone suffix. */
  date: string;
  dateUTC: string;
  dateUTCOffset: string;
  epoch: number;
}

export interface PassSeat {
  designator: string;
  location?: string;
  paid?: boolean;
  door?: number;
  isPrime?: boolean;
}

export interface PassFlight {
  carrierCode: string;
  number: string;
  label: string;
  operatedBy: string;
}

/** Extras attached to the pass (bags, etc.); `note` is a JSON string. */
export interface PassSsrDetail {
  code: string;
  qty: number;
  note: string;
}

/** A single boarding pass, as returned by `/v1/boardingpasses`. */
export interface BoardingPass {
  passId: string;
  hash: string;
  pnr: string;
  isConnectingFlight: boolean;
  paxNumber: number;
  paxType: string;
  name: PassName;
  /** Ryanair sometimes returns a pass with no barcode, so callers must guard. */
  barcode?: string | null;
  departure: PassStation;
  arrival: PassStation;
  ssrsDetails: PassSsrDetail[];
  /** Infants travel on a lap, so they have no seat. */
  seat?: PassSeat | null;
  priority: boolean;
  fast: boolean;
  leisurePlus: boolean;
  timeSaver: boolean;
  businessPlus: boolean;
  familyPlus: boolean;
  regular: boolean;
  sequence: number;
  boardingTime: string;
  boardingTimeEpoch: number;
  flight: PassFlight;
  ticketType: string;
  discount: string;
  docNationality: string;
  docCountryOfIssue: string;
  authorizationStatus: string;
}

/** Request body for `/v1/downloadpass` and the Google Wallet endpoint. */
export interface DownloadPayload {
  sequenceNumber: string;
  lang: string;
  arrivalStation: string;
  departureStation: string;
  recordLocator: string;
  isInfant: boolean;
}

export interface FlightSummary {
  bookingId: number;
  pnr: string;
  origin: string;
  destination: string;
  date: string; // ISO date
  flightNumber: string;
  checkinStatus: string; // "nocheckin", "checkedin", etc.
  isReady: boolean;
  checkInOpenUTC?: string;
  checkInCloseUTC?: string;
}

/** Ascending. Subtraction would give NaN for two undated entries, so compare instead. */
function compareTimes(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A missing or unparseable time sorts last. */
function toTime(value: string | undefined): number {
  const epoch = Date.parse(value ?? "");
  return Number.isNaN(epoch) ? Number.POSITIVE_INFINITY : epoch;
}

/** Ryanair gives the pass a millisecond epoch; the ISO string is the fallback. */
function passDepartureTime(pass: BoardingPass): number {
  return pass.departure?.epoch || toTime(pass.departure?.dateUTC);
}

/**
 * Soonest first. The server is asked for this order too, but it pages the list
 * and we merge the pages, so the client sorts as well rather than trusting it.
 * Sorts a copy: callers pass arrays they did not expect to be rearranged.
 */
export function sortFlightsByDeparture(flights: FlightSummary[]): FlightSummary[] {
  return [...flights].sort((a, b) => compareTimes(toTime(a.date), toTime(b.date)));
}

/** Soonest first, so the list of passes reads in the order they will be used. */
export function sortPassesByDeparture(passes: BoardingPass[]): BoardingPass[] {
  return [...passes].sort((a, b) => compareTimes(passDepartureTime(a), passDepartureTime(b)));
}

export function extractFlightsFromOrders(orders: OrderResponse): FlightSummary[] {
  if (!orders || !orders.items) return [];

  const flights = orders.items.flatMap((item) => {
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
        isReady: checkin?.status !== "nocheckin",
        checkInOpenUTC: flight.checkInOpenUTC,
        checkInCloseUTC: flight.checkInCloseUTC
      };
    });
  });

  return sortFlightsByDeparture(flights);
}

export function filterReadyBookings(flights: FlightSummary[]): number[] {
  return flights.filter(f => f.isReady).map(f => f.bookingId);
}

export function isInfant(paxType: string): boolean {
  return paxType === "INF";
}

/**
 * Whether the pass carries a scannable code. Ryanair returns the barcode as
 * null or an empty string until it has one, which is a state of the pass rather
 * than a failure, so every caller asks this instead of testing truthiness.
 */
export function hasBarcode(pass: BoardingPass): boolean {
  return typeof pass.barcode === "string" && pass.barcode.trim() !== "";
}

export function buildDownloadPayload(passItem: BoardingPass): DownloadPayload {
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
      checkInOpenUTC?: string;
      checkInCloseUTC?: string;
    }>;
    checkins?: Array<{ status: string; journeyNum: number }>;
  };
}

export interface OrderResponse {
  items: OrderItem[];
  /** Cursor for the next page; absent on the last one. Merged results carry none. */
  nextToken?: string | null;
}

function normalizeNamePart(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

/**
 * Stable file name for a pass. PNR + route + flight + seat is unique per pass,
 * the passenger name is there for readability.
 *
 * Every part is optional-chained on purpose: a pass missing a field still gets a
 * name out of whatever is left rather than throwing.
 */
export function buildPassBaseName(pass: BoardingPass): string {
  const departure = normalizeNamePart(pass.departure?.code);
  const arrival = normalizeNamePart(pass.arrival?.code);
  const route = departure && arrival ? `${departure}-${arrival}` : departure || arrival;
  const flight = normalizeNamePart(`${pass.flight?.carrierCode ?? ""}${pass.flight?.number ?? ""}`);

  return [
    normalizeNamePart(pass.pnr),
    route,
    flight,
    normalizeNamePart(pass.name?.first),
    normalizeNamePart(pass.name?.last),
    normalizeNamePart(pass.seat?.designator),
  ].filter(Boolean).join("_");
}

export function buildPassFilename(pass: BoardingPass, ext: string): string {
  return `${buildPassBaseName(pass)}.${ext}`;
}
