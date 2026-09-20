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

/** Reads one key. A body that throws from a getter costs its own node, not the trip. */
function read(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key];
  } catch {
    return undefined;
  }
}

/** A lookup's answer and the key it came from: the report describes the parse. */
interface Picked {
  value: string;
  key: string | null;
}

const NOT_FOUND: Picked = { value: "", key: null };

/** First non-empty `keys` value across `sources`, nearest source first. */
function pick(sources: Source[], keys: string[]): Picked {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const found = text(read(source, key));
      if (found) return { value: found, key };
    }
  }
  return NOT_FOUND;
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

/** Keys a record locator has been seen under, most specific first. */
const PNR_KEYS = ["pnr", "recordLocator", "recordNumber", "bookingReference", "reference"];

const ORIGIN_KEYS = ["origin", "originStation", "departureStation", "from"];
const DESTINATION_KEYS = ["destination", "destinationStation", "arrivalStation", "to"];

/** `FR1234`, however it is spelled: one field, or a carrier code beside a number. */
function pickFlightNumber(sources: Source[]): Picked {
  for (const source of sources) {
    if (!source) continue;

    for (const key of ["flightNumber", "flightNo"]) {
      const direct = text(read(source, key));
      if (direct) return { value: direct, key };
    }

    const number = text(read(source, "number"));
    if (number) {
      const carrier = text(read(source, "carrierCode"));
      return { value: carrier ? `${carrier}${number}` : number, key: "number" };
    }
  }
  return NOT_FOUND;
}

/* ------------------------------------------------------------------ *
 * Finding the bookings inside a trip
 *
 * The id was read as `record.bookingId` and the booking dropped when that came
 * back as NaN, which is a guess at an undocumented key that silently costs the
 * whole booking when it is wrong. Nothing below `flights[]` is spelled our way
 * on purpose, so a booking is now recognised by what it carries rather than by
 * what it is called.
 * ------------------------------------------------------------------ */

/** What an id is plausibly called: `id`, `bookingId`, `bookingRef`, … */
const BOOKING_ID_KEYS = [/^(booking)?id$/i, /booking(id|number|ref|reference)/i];
/** A key whose value is a record locator, if the value looks like one. */
const PNR_KEY = /pnr|record|locator|reference/i;
const PNR_VALUE = /^[A-Z0-9]{6}$/;
/** Arrays only a booking carries. */
const BOOKING_ARRAY_KEY = /^(journeys|segments|legs|passengers)$/i;

/** Object levels below a trip a booking may hide at. */
const BOOKING_MAX_DEPTH = 4;
/** Nodes weighed per trip, so a pathological body cannot fan the walk out. */
const BOOKING_MAX_CANDIDATES = 64;

interface BookingNode {
  record: Record<string, unknown>;
  entries: Array<[string, unknown]>;
  id: number;
  idKey: string;
  idNumeric: boolean;
}

/** The own keys of an object, or null for anything else — a throwing getter included. */
function entriesOf(value: unknown): Array<[string, unknown]> | null {
  if (!asRecord(value)) return null;
  try {
    return Object.entries(value as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** A positive integer, written as one or as digits. Anything else is not an id. */
function bookingIdOf(value: unknown): number | null {
  const digits = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;

  return typeof digits === "number" && Number.isSafeInteger(digits) && digits > 0 ? digits : null;
}

/**
 * An id alone is not enough: `passengers[].id` is an id on a node that is not a
 * booking. Something only a booking carries has to be on the same node.
 */
function looksLikeBooking(entries: Array<[string, unknown]>): boolean {
  return entries.some(([key, value]) =>
    (PNR_KEY.test(key) && PNR_VALUE.test(text(value).toUpperCase()))
    || (BOOKING_ARRAY_KEY.test(key) && Array.isArray(value)));
}

function bookingNode(value: unknown, entries: Array<[string, unknown]>): BookingNode | null {
  for (const [key, raw] of entries) {
    if (!BOOKING_ID_KEYS.some((pattern) => pattern.test(key))) continue;

    const id = bookingIdOf(raw);
    if (id === null) continue;
    if (!looksLikeBooking(entries)) return null;

    return {
      record: value as Record<string, unknown>,
      entries,
      id,
      idKey: key,
      idNumeric: typeof raw === "number",
    };
  }
  return null;
}

/**
 * Every booking under one trip, wherever Ryanair keeps it. Nothing inside an
 * accepted booking is walked, so `passengers[].id` and `linkedBookings[]` cannot
 * pass themselves off as bookings of the trip.
 */
function harvestBookings(trip: unknown): BookingNode[] {
  const found: BookingNode[] = [];
  const seen = new Set<number>();
  let weighed = 0;

  const walk = (node: unknown, depth: number): void => {
    // An array is not a level: `flights[0]` sits where `flights` does.
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth);
      return;
    }
    if (depth > BOOKING_MAX_DEPTH || weighed >= BOOKING_MAX_CANDIDATES) return;

    const entries = entriesOf(node);
    if (!entries) return;
    weighed++;

    const booking = bookingNode(node, entries);
    if (booking) {
      // The same booking listed twice in a trip is one booking.
      if (!seen.has(booking.id)) {
        seen.add(booking.id);
        found.push(booking);
      }
      return;
    }

    for (const [, value] of entries) walk(value, depth + 1);
  };

  walk(trip, 1);
  return found;
}

/** Object levels below a booking a leg may hide at. */
const LEG_MAX_DEPTH = 4;
const LEG_MAX_CANDIDATES = 64;

/** Nearest first: the leg knows its own times, an ancestor only the journey. */
function sourcesOf(chain: Array<Record<string, unknown>>): Source[] {
  return chain.flatMap((node) => [node, asRecord(read(node, "times"))]);
}

/** A node that knows a flight number or a departure time is a leg. */
function isLeg(record: Record<string, unknown>): boolean {
  const sources = [record, asRecord(read(record, "times"))];
  return pickFlightNumber(sources).value !== "" || pick(sources, DEPARTURE_KEYS).value !== "";
}

/**
 * The legs of one booking, found the same way the booking itself was: by what a
 * node knows rather than by where it sits, so a listing that nests its segments
 * a level deeper than we guessed still renders.
 */
function collectLegs(booking: BookingNode): Source[][] {
  const legs: Source[][] = [];
  let weighed = 0;

  const walk = (node: unknown, chain: Array<Record<string, unknown>>, depth: number): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, chain, depth);
      return;
    }
    if (depth > LEG_MAX_DEPTH || weighed >= LEG_MAX_CANDIDATES) return;

    const entries = entriesOf(node);
    if (!entries) return;
    weighed++;

    const record = node as Record<string, unknown>;
    const inner = [record, ...chain];
    if (isLeg(record)) {
      legs.push(sourcesOf(inner));
      return;
    }

    for (const [, value] of entries) walk(value, inner, depth + 1);
  };

  for (const [, value] of booking.entries) walk(value, [booking.record], 1);
  return legs;
}

/**
 * Which key each lookup matched on. Every value is a constant of ours, so the
 * diagnostic report can carry the lot without carrying anything of the user's.
 */
export interface TripBookingTrace {
  parsed: boolean;
  bookingIdKey: string | null;
  bookingIdNumeric: boolean;
  pnrKey: string | null;
  dateKey: string | null;
  flightNumberKey: string | null;
  routeKey: string | null;
}

/** What the trace says about a node the harvest did not accept as a booking. */
export const UNPARSED_TRIP_BOOKING: TripBookingTrace = {
  parsed: false,
  bookingIdKey: null,
  bookingIdNumeric: false,
  pnrKey: null,
  dateKey: null,
  flightNumberKey: null,
  routeKey: null,
};

export interface TripBookingParse {
  flights: FlightSummary[];
  trace: TripBookingTrace;
}

function parseBooking(booking: BookingNode): TripBookingParse {
  const record = booking.record;
  const legs = collectLegs(booking);
  const firstLeg = legs[0]?.[0] ?? null;
  const pnr = pick([record], PNR_KEYS);

  const trace: TripBookingTrace = {
    parsed: true,
    bookingIdKey: booking.idKey,
    bookingIdNumeric: booking.idNumeric,
    pnrKey: pnr.key,
    dateKey: null,
    flightNumberKey: null,
    routeKey: null,
  };

  const build = (sources: Source[]): FlightSummary => {
    const leg = sources[0] ?? null;
    const date = pick(sources, DEPARTURE_KEYS);
    const flightNumber = pickFlightNumber(sources);
    // Route is booking-level on the site; the leg in hand fills the gap.
    const origin = pick([record, leg, firstLeg], ORIGIN_KEYS);
    const destination = pick([record, leg, firstLeg], DESTINATION_KEYS);

    // The first leg that answers is the one the report describes; a later leg
    // reading the same keys says nothing new.
    trace.dateKey ??= date.key;
    trace.flightNumberKey ??= flightNumber.key;
    trace.routeKey ??= origin.key ?? destination.key;

    return {
      bookingId: booking.id,
      pnr: pnr.value,
      origin: origin.value,
      destination: destination.value,
      date: date.value,
      flightNumber: flightNumber.value,
      checkinStatus: "unknown",
      isReady: true,
    };
  };

  return {
    // A booking with no legs is still a booking we can ask for passes.
    flights: legs.length > 0 ? legs.map(build) : [build(sourcesOf([record]))],
    trace,
  };
}

/**
 * Every booking of one trip, with the keys each field was read out of. The trip
 * listing says nothing about check-in, so the status is unknown and the booking
 * is treated as ready: asking for its pass is how we find out. A booking no pass
 * comes back for is moved to the upcoming list by `markUnconfirmedFlights`, so
 * nothing found here can end up rendering nowhere.
 */
export function parseTripBookings(trip: unknown): TripBookingParse[] {
  const parsed: TripBookingParse[] = [];

  for (const booking of harvestBookings(trip)) {
    try {
      parsed.push(parseBooking(booking));
    } catch {
      // An odd shape costs its own booking and nothing else.
    }
  }

  return parsed;
}

/**
 * Walks every booking of every trip. Items holding no booking (a trip of only
 * cars, rooms or events) contribute nothing.
 */
export function extractFlightsFromTrips(trips: unknown): FlightSummary[] {
  const items = Array.isArray(trips) ? trips : asArray(asRecord(trips)?.items);

  return items.flatMap((item) => parseTripBookings(item).flatMap((parse) => parse.flights));
}

/** Uppercased so a case difference between the two listings is not a mismatch. */
function normalizePnr(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * Union of the two listings, keyed by booking. `/details` wins where both know a
 * booking: only it carries the check-in status, which is what decides whether a
 * pass is worth asking for. The pnr is a second key because the two listings are
 * not known to share an id space, and a booking counted twice is a booking the
 * user sees twice.
 */
export function mergeFlights(
  fromDetails: FlightSummary[],
  fromTrips: FlightSummary[]
): FlightSummary[] {
  const knownIds = new Set(fromDetails.map((flight) => flight.bookingId));
  const knownPnrs = new Set(
    fromDetails.map((flight) => normalizePnr(flight.pnr)).filter(Boolean)
  );

  return sortFlightsByDeparture([
    ...fromDetails,
    ...fromTrips.filter((flight) =>
      !knownIds.has(flight.bookingId) && !knownPnrs.has(normalizePnr(flight.pnr))),
  ]);
}

/** What the passes that came back can be matched against. */
export interface PassMatchIndex {
  bookingIds: Set<number>;
  pnrs: Set<string>;
}

export function indexPasses(passes: BoardingPass[]): PassMatchIndex {
  const bookingIds = new Set<number>();
  const pnrs = new Set<string>();

  for (const pass of passes) {
    // Undocumented, and absent from every pass we have seen — used when it is there.
    const bookingId = Number((pass as { bookingId?: unknown }).bookingId);
    if (Number.isFinite(bookingId)) bookingIds.add(bookingId);

    const pnr = normalizePnr(pass.pnr);
    if (pnr) pnrs.add(pnr);
  }

  return { bookingIds, pnrs };
}

/** By booking id where the pass carries one, by pnr otherwise. */
export function hasMatchingPass(flight: FlightSummary, index: PassMatchIndex): boolean {
  if (index.bookingIds.has(flight.bookingId)) return true;

  const pnr = normalizePnr(flight.pnr);
  return pnr !== "" && index.pnrs.has(pnr);
}

/**
 * Every flight either matches a pass that came back or lands in the upcoming
 * list, because the popup only renders the two and a flight in neither is a
 * booking the user cannot see at all.
 *
 * Nothing is exempt. A check-in status from `/details` used to be taken as proof
 * the booking was accounted for, and a body of passes we could match nothing
 * against used to be read as "they must all be in there" — both leave a booking
 * rendering nowhere. Listing a booking twice is visible and can be reported;
 * losing it is neither.
 */
export function markUnconfirmedFlights(
  flights: FlightSummary[],
  passes: BoardingPass[]
): FlightSummary[] {
  const index = indexPasses(passes);

  return flights.map((flight) =>
    !flight.isReady || hasMatchingPass(flight, index) ? flight : { ...flight, isReady: false });
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
