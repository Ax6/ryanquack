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

/* ------------------------------------------------------------------ *
 * Trip listing (`/orders/v2/orders/{cid}`)
 *
 * `/details` answers with one entry per trip, and Ryanair groups several
 * bookings into a trip, so a customer with seven bookings on one flight only
 * ever saw the first. The listing myRyanair itself reads carries the whole
 * `flights` array, but nothing below it is documented, so every field here is
 * looked up by name across the shapes Ryanair plausibly uses and falls back to
 * an empty string rather than throwing.
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A trimmed string for anything scalar, "" for objects, arrays and blanks. */
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

type Source = Record<string, unknown> | null;

/** First non-empty `keys` value across `sources`, nearest source first. */
function pick(sources: Source[], keys: string[]): string {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const found = text(source[key]);
      if (found) return found;
    }
  }
  return "";
}

/** Keys a departure time has been seen under, plus the ones it plausibly uses. */
const DEPARTURE_KEYS = [
  "departUTC",
  "departureUTC",
  "departureDateUTC",
  "departureDate",
  "depart",
  "departure",
  "startDate",
];

/** `FR1234`, however it is spelled: one field, or a carrier code beside a number. */
function pickFlightNumber(sources: Source[]): string {
  for (const source of sources) {
    if (!source) continue;

    const direct = text(source.flightNumber) || text(source.flightNo);
    if (direct) return direct;

    const number = text(source.number);
    if (number) {
      const carrier = text(source.carrierCode);
      return carrier ? `${carrier}${number}` : number;
    }
  }
  return "";
}

/**
 * Every leg of one booking out of the trip listing. The trip listing says
 * nothing about check-in, so the status is unknown and the booking is treated as
 * ready: asking for its pass is how we find out.
 */
export function flightsFromTripBooking(booking: unknown): FlightSummary[] {
  try {
    const record = asRecord(booking);
    if (!record) return [];

    const bookingId = Number(record.bookingId);
    // Without an id the booking cannot be merged, nor asked for a pass.
    if (!Number.isFinite(bookingId)) return [];

    const pnr = text(record.pnr);
    const journeys = asArray(record.journeys);
    const firstSegment = asRecord(asArray(asRecord(journeys[0])?.segments)[0]);

    const build = (journey: Source, segment: Source): FlightSummary => {
      // Nearest first: the segment knows its own leg, the booking only the trip.
      const sources: Source[] = [
        segment,
        asRecord(segment?.times),
        journey,
        asRecord(journey?.times),
        record,
      ];

      return {
        bookingId,
        pnr,
        // Route is booking-level on the site; the segment in hand fills the gap.
        origin: pick([record, segment, firstSegment], ["origin"]),
        destination: pick([record, segment, firstSegment], ["destination"]),
        date: pick(sources, DEPARTURE_KEYS),
        flightNumber: pickFlightNumber(sources),
        checkinStatus: "unknown",
        isReady: true,
      };
    };

    const flights: FlightSummary[] = [];
    for (const rawJourney of journeys) {
      const journey = asRecord(rawJourney);
      const segments = asArray(journey?.segments);

      if (segments.length === 0) {
        flights.push(build(journey, null));
        continue;
      }
      for (const rawSegment of segments) {
        flights.push(build(journey, asRecord(rawSegment)));
      }
    }

    // A booking with no journeys is still a booking we can ask for passes.
    if (flights.length === 0) flights.push(build(null, null));

    return flights;
  } catch {
    // An odd shape costs its own booking and nothing else.
    return [];
  }
}

/**
 * Walks every booking of every trip. Items without a `flights` array (a trip of
 * only cars, rooms or events) contribute nothing.
 */
export function extractFlightsFromTrips(trips: unknown): FlightSummary[] {
  const items = Array.isArray(trips) ? trips : asArray(asRecord(trips)?.items);

  return items.flatMap((item) =>
    asArray(asRecord(item)?.flights).flatMap(flightsFromTripBooking)
  );
}

/**
 * Union of the two listings, keyed by booking. `/details` wins where both know a
 * booking: only it carries the check-in status, which is what decides whether a
 * pass is worth asking for.
 */
export function mergeFlights(
  fromDetails: FlightSummary[],
  fromTrips: FlightSummary[]
): FlightSummary[] {
  const known = new Set(fromDetails.map((flight) => flight.bookingId));

  return sortFlightsByDeparture([
    ...fromDetails,
    ...fromTrips.filter((flight) => !known.has(flight.bookingId)),
  ]);
}

/** Uppercased so a case difference between the two listings is not a mismatch. */
function normalizePnr(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * A booking only the trip listing knows about is asked for passes on spec — that
 * is how we find out whether check-in has happened. When no pass comes back it
 * has to land in the upcoming list, or the booking renders nowhere at all and
 * the user is back to seeing fewer bookings than they have.
 *
 * Only flights with an unknown status are reconsidered: `/details` says what the
 * check-in status actually is, and that answer stands.
 */
export function markUnconfirmedFlights(
  flights: FlightSummary[],
  passes: BoardingPass[]
): FlightSummary[] {
  const bookingIds = new Set<number>();
  const pnrs = new Set<string>();

  for (const pass of passes) {
    // Undocumented, and absent from every pass we have seen — used when it is there.
    const bookingId = Number((pass as { bookingId?: unknown }).bookingId);
    if (Number.isFinite(bookingId)) bookingIds.add(bookingId);

    const pnr = normalizePnr(pass.pnr);
    if (pnr) pnrs.add(pnr);
  }

  return flights.map((flight) => {
    if (flight.checkinStatus !== "unknown") return flight;

    const pnr = normalizePnr(flight.pnr);
    if (bookingIds.has(flight.bookingId) || (pnr && pnrs.has(pnr))) return flight;

    // Passes came back that carry nothing this flight can be matched against.
    // Assume one of them is its own rather than listing the booking twice.
    const identifiable = bookingIds.size > 0 || (pnr !== "" && pnrs.size > 0);
    if (passes.length > 0 && !identifiable) return flight;

    return { ...flight, isReady: false };
  });
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
  /** Ryanair groups bookings into trips, so this repeats across items. */
  tripId?: string;
  productId?: string;
  type?: string;
  payload?: { booking?: { bookingId?: number; pnr?: string } };
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
