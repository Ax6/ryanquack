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
  /**
   * The check-in state of this leg, across every passenger on it. Ryanair's own
   * words: "nocheckin", "documentsadded" (travel documents entered, not checked
   * in yet) and "checkin"; "unknown" when the listing said nothing.
   */
  checkinStatus: string;
  /**
   * Worth asking the pass endpoint about. Not the same as checked in: a booking
   * that turns out to have no pass is put back in the upcoming list by
   * `markUnconfirmedFlights`, so a status we have never seen costs a wrong label
   * and never a missing booking.
   */
  isReady: boolean;
  checkInOpenUTC?: string;
  checkInCloseUTC?: string;
  /** When check-in opens for a passenger who has not bought a seat. */
  checkInFreeOpenUTC?: string;
  /** A seat was bought on this leg, so check-in opens at `checkInOpenUTC`. */
  hasSeat?: boolean;
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

/* ------------------------------------------------------------------ *
 * Check-in status
 * ------------------------------------------------------------------ */

/**
 * Statuses that say a passenger has not checked in. Ryanair's check-in is two
 * steps: travel documents first, which can be done any time after booking and
 * leaves the passenger at "documentsadded", then the seat and the pass once the
 * window opens. Anything not listed here is treated as possibly holding a pass.
 */
const NOT_CHECKED_IN = new Set(["nocheckin", "documentsadded"]);
const FLOWN = "flown";

export interface LegCheckin {
  /** One word for the whole leg; see `FlightSummary.checkinStatus`. */
  status: string;
  /** Whether to ask the pass endpoint about the booking. */
  ready: boolean;
  /** Every passenger has flown this leg, so it is not upcoming. */
  flown: boolean;
}

/**
 * Folds the per-passenger records of one leg into one state. The most advanced
 * passenger wins, because a pass for any of them is worth fetching.
 */
export function classifyLeg(statuses: Array<string | null | undefined>): LegCheckin {
  const seen = statuses
    .map((status) => String(status ?? "").trim().toLowerCase())
    .filter(Boolean);

  if (seen.length === 0) return { status: "unknown", ready: true, flown: false };
  if (seen.every((status) => status === FLOWN)) return { status: FLOWN, ready: false, flown: true };

  const live = seen.filter((status) => status !== FLOWN);
  const checkedIn = live.find((status) => !NOT_CHECKED_IN.has(status));
  if (checkedIn) return { status: checkedIn, ready: true, flown: false };
  if (live.includes("documentsadded")) return { status: "documentsadded", ready: true, flown: false };

  return { status: "nocheckin", ready: false, flown: false };
}

type RawBooking = NonNullable<OrderItem["rawBooking"]>;

/** The check-in records of every passenger on one leg. */
export function legStatuses(raw: RawBooking, journeyNum: number): string[] {
  return (raw.checkins ?? [])
    .filter((checkin) => checkin.journeyNum === journeyNum)
    .map((checkin) => checkin.status);
}

function hasSeatOn(raw: RawBooking, journeyNum: number): boolean {
  return (raw.seats ?? []).some((seat) => seat.journeyNum === journeyNum);
}

/* ------------------------------------------------------------------ *
 * The orders listing
 * ------------------------------------------------------------------ */

/** Which part of an item the flights were read from. */
export type BookingSource = "rawBooking" | "payload" | "none";

export function bookingSource(item: OrderItem): BookingSource {
  if (item.rawBooking?.flights) return "rawBooking";
  if (item.payload?.booking?.journeys) return "payload";
  return "none";
}

function flightsFromRawBooking(raw: RawBooking): FlightSummary[] {
  return (raw.flights ?? []).flatMap((flight) => {
    const checkin = classifyLeg(legStatuses(raw, flight.journeyNum));
    if (checkin.flown) return [];

    return [{
      bookingId: raw.bookingId,
      pnr: raw.recordLocator || "",
      origin: flight.origin,
      destination: flight.destination,
      date: flight.times?.departUTC || "",
      flightNumber: flight.flightNumber,
      checkinStatus: checkin.status,
      isReady: checkin.ready,
      checkInOpenUTC: flight.checkInOpenUTC,
      checkInCloseUTC: flight.checkInCloseUTC,
      checkInFreeOpenUTC: flight.checkInFreeAllocateOpenUtcDate,
      hasSeat: hasSeatOn(raw, flight.journeyNum),
    }];
  });
}

/**
 * The same booking as `payload.booking` describes it, for an item whose
 * `rawBooking` Ryanair failed to load (`rawBookingFailure`). It carries the
 * itinerary but no check-in records, so the booking is asked about and, failing
 * a pass, listed as upcoming.
 */
function flightsFromPayload(item: OrderItem): FlightSummary[] {
  const booking = item.payload?.booking;
  const bookingId = Number(booking?.bookingId);
  if (!booking || !Number.isFinite(bookingId)) return [];

  return (booking.journeys ?? []).flatMap((journey) => {
    const segments = journey.segments ?? [];
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (!first) return [];

    return [{
      bookingId,
      pnr: booking.pnr || "",
      origin: first.origin || booking.origin || "",
      destination: last?.destination || booking.destination || "",
      date: first.departureTime || "",
      flightNumber: first.flightNumber || "",
      checkinStatus: "unknown",
      isReady: true,
    }];
  });
}

export function extractFlightsFromOrders(orders: OrderResponse): FlightSummary[] {
  if (!orders || !orders.items) return [];

  const flights = orders.items.flatMap((item) =>
    item.rawBooking?.flights ? flightsFromRawBooking(item.rawBooking) : flightsFromPayload(item));

  return sortFlightsByDeparture(flights);
}

/** Distinct bookings behind a list of legs. */
export function countBookings(flights: FlightSummary[]): number {
  return new Set(flights.map((flight) => flight.bookingId)).size;
}

/* ------------------------------------------------------------------ *
 * Reconciling the list against the passes
 * ------------------------------------------------------------------ */

function normalizePnr(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

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

export function hasMatchingPass(flight: FlightSummary, index: PassMatchIndex): boolean {
  if (index.bookingIds.has(flight.bookingId)) return true;

  const pnr = normalizePnr(flight.pnr);
  return pnr !== "" && index.pnrs.has(pnr);
}

/**
 * A ready flight is shown through its passes, so a ready flight with no pass
 * would render nowhere. Whatever its status said, it goes back in the upcoming
 * list; this is the invariant that keeps every booking on screen.
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

/** One check-in record: per passenger, per segment. */
export interface OrderCheckin {
  status: string;
  journeyNum: number;
  paxNum?: number;
  segmentNum?: number;
}

export interface OrderSeat {
  journeyNum: number;
  paxNum?: number;
  segmentNum?: number;
  code?: string;
}

export interface OrderFlight {
  journeyNum: number;
  origin: string;
  destination: string;
  flightNumber: string;
  times?: { departUTC: string; arriveUTC?: string };
  checkInOpenUTC?: string;
  checkInCloseUTC?: string;
  /** When free check-in opens; `checkInOpenUTC` is the paid-seat window. */
  checkInFreeAllocateOpenUtcDate?: string;
}

export interface PayloadSegment {
  origin?: string;
  destination?: string;
  flightNumber?: string;
  departureTime?: string;
  arrivalTime?: string;
}

/** The booking as the site's own view of it, alongside `rawBooking`. */
export interface PayloadBooking {
  bookingId?: number;
  pnr?: string;
  origin?: string;
  destination?: string;
  departureDate?: string;
  journeys?: Array<{ segments?: PayloadSegment[] }>;
}

/** One item of `/orders/v2/orders/{cid}/details`, as observed in September 2026. */
export interface OrderItem {
  tripId?: string;
  productId?: string;
  type?: string;
  payload?: { booking?: PayloadBooking };
  rawBooking?: {
    bookingId: number;
    recordLocator?: string;
    flights?: OrderFlight[];
    checkins?: OrderCheckin[];
    seats?: OrderSeat[];
  };
  /** Set when Ryanair could not load `rawBooking`; the item then has only `payload`. */
  rawBookingFailure?: unknown;
  processingStatus?: { code?: string; reason?: string | null };
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
