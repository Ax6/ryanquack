/**
 * A report the user can paste into a GitHub issue without handing over their
 * travel plans. Ryanair's listings disagree about how many bookings an account
 * has, and the only way to tell which shape a reporter is actually getting is to
 * see it — so this describes the responses (counts, keys, types) and never
 * carries a value that identifies anyone.
 *
 * Nothing here touches a browser API: the background passes the environment in
 * and persists the result, which keeps every helper unit-testable.
 */
import type { BoardingPass, FlightSummary, OrderResponse } from "./ryanair";
import { flightsFromTripBooking, hasBarcode } from "./ryanair";

/** `browser.storage.local` key. One report, overwritten by every fetch. */
export const DIAGNOSTICS_STORAGE_KEY = "diagnostics";

/* ------------------------------------------------------------------ *
 * Hashing
 * ------------------------------------------------------------------ */

/** Hashes one value. Blank in, blank out: an absent field must not look present. */
export type Hasher = (value: unknown) => Promise<string>;

const HASH_LENGTH = 10;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A fresh salt per report. A PNR is six characters, so an unsalted digest of one
 * is brute-forceable in seconds; the salt keeps the digests correlatable inside
 * a single report and meaningless outside it.
 */
export function createSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** First 10 hex characters of SHA-256(salt + value). Enough to spot duplicates. */
export async function hashValue(value: unknown, salt: string): Promise<string> {
  const text = String(value ?? "");
  if (!text) return "";

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + text));
  return toHex(new Uint8Array(digest)).slice(0, HASH_LENGTH);
}

/** Memoised so a value repeated across a report costs one digest, not hundreds. */
export function createHasher(salt: string): Hasher {
  const cache = new Map<string, Promise<string>>();

  return (value: unknown) => {
    const key = String(value ?? "");
    let hashed = cache.get(key);
    if (!hashed) {
      hashed = hashValue(key, salt);
      cache.set(key, hashed);
    }
    return hashed;
  };
}

/* ------------------------------------------------------------------ *
 * Schema skeletons
 * ------------------------------------------------------------------ */

/** Objects deep. Deeper than anything Ryanair sends, and a hard stop for the rest. */
export const SKELETON_MAX_DEPTH = 8;

/**
 * The shape of a response with every value removed: keys survive, primitives
 * become their type (strings keep only their length), and an array becomes its
 * first element plus a count. This is what tells us whether a reporter's
 * `journeys[].segments[]` looks like the one we guessed at.
 */
export function skeleton(value: unknown, maxDepth: number = SKELETON_MAX_DEPTH): unknown {
  return shapeOf(value, maxDepth, new Set());
}

/** `path` holds the ancestors of `value`, so a body that points at itself terminates. */
function shapeOf(value: unknown, depth: number, path: Set<unknown>): unknown {
  if (value === null) return "null";

  if (typeof value !== "object") {
    // number, boolean, undefined, bigint, symbol, function.
    return typeof value === "string" ? `string(${value.length})` : typeof value;
  }

  if (path.has(value)) return "…circular";
  if (depth <= 0) return "…";

  path.add(value);
  try {
    // An array costs no depth: `flights[0]` is the same level as `flights`, and
    // charging for both would cut the nesting we are here to look at in half.
    if (Array.isArray(value)) {
      return value.length === 0 ? [] : [shapeOf(value[0], depth, path), `…×${value.length}`];
    }

    const shape: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      shape[key] = shapeOf(inner, depth - 1, path);
    }
    return shape;
  } finally {
    path.delete(value);
  }
}

/* ------------------------------------------------------------------ *
 * Endpoint logs, filled in as the fetch runs
 * ------------------------------------------------------------------ */

export interface RequestLog {
  status: number | null;
  durationMs: number;
  items: number;
  error?: string;
}

export interface EndpointLog {
  /** The customer id is replaced by `<cid>`; the token is a header and never appears. */
  url: string;
  /** One entry per page (listings) or per chunk (boarding passes). */
  requests: RequestLog[];
  /** Set when the endpoint failed outright rather than in one request. */
  error?: string;
}

export function redactCustomerId(url: string, customerId: string): string {
  return customerId ? url.split(customerId).join("<cid>") : url;
}

export function newEndpointLog(url: string, customerId: string): EndpointLog {
  return { url: redactCustomerId(url, customerId), requests: [] };
}

export interface EndpointReport extends EndpointLog {
  /** Pages, or chunks, actually fetched. */
  pages: number;
  items: number;
  durationMs: number;
}

function summarizeEndpoint(log: EndpointLog): EndpointReport {
  return {
    ...log,
    pages: log.requests.length,
    items: log.requests.reduce((total, request) => total + request.items, 0),
    durationMs: log.requests.reduce((total, request) => total + request.durationMs, 0),
  };
}

/* ------------------------------------------------------------------ *
 * Per-endpoint summaries
 * ------------------------------------------------------------------ */

export interface DetailsLegSummary {
  flightNumber: string;
  origin: string;
  destination: string;
  departUTC: string;
}

export interface DetailsItemSummary {
  tripId: string;
  productId: string;
  bookingId: string;
  pnr: string;
  type: string;
  flights: DetailsLegSummary[];
  checkins: string[];
}

export interface DetailsSummary {
  items: number;
  /** A trip id shared by several items is the bug we are chasing, so count them. */
  distinctTripIds: number;
  distinctProductIds: number;
  distinctBookingIds: number;
  entries: DetailsItemSummary[];
}

function countDistinct(values: Array<string | number | undefined>): number {
  return new Set(values.filter((value) => value !== undefined && value !== "")).size;
}

export async function summarizeDetails(
  orders: OrderResponse | null | undefined,
  hash: Hasher
): Promise<DetailsSummary> {
  const items = orders?.items ?? [];

  const entries = await Promise.all(items.map(async (item): Promise<DetailsItemSummary> => {
    const raw = item.rawBooking;
    const bookingId = raw?.bookingId ?? item.payload?.booking?.bookingId;
    const pnr = raw?.recordLocator ?? item.payload?.booking?.pnr;

    return {
      tripId: await hash(item.tripId),
      productId: await hash(item.productId),
      bookingId: await hash(bookingId),
      pnr: await hash(pnr),
      type: item.type ?? "",
      // Route and flight number are shared by everyone on the flight, so they
      // identify the schema rather than the traveller.
      flights: (raw?.flights ?? []).map((flight) => ({
        flightNumber: flight.flightNumber ?? "",
        origin: flight.origin ?? "",
        destination: flight.destination ?? "",
        departUTC: flight.times?.departUTC ?? "",
      })),
      checkins: (raw?.checkins ?? []).map((checkin) => checkin.status ?? ""),
    };
  }));

  return {
    items: items.length,
    distinctTripIds: countDistinct(items.map((item) => item.tripId)),
    distinctProductIds: countDistinct(items.map((item) => item.productId)),
    distinctBookingIds: countDistinct(items.map(
      (item) => item.rawBooking?.bookingId ?? item.payload?.booking?.bookingId
    )),
    entries,
  };
}

export interface TripsBookingSummary {
  bookingId: string;
  pnr: string;
  origin: string;
  destination: string;
  journeys: number;
  segments: number;
  /** What our own parser made of the booking, so a miss is visible in the report. */
  parsedFlightNumber: string;
  parsedDate: string;
}

export interface TripsItemSummary {
  tripId: string;
  startDate: string;
  endDate: string;
  /** How many bookings the trip holds. Anything above 1 is what `/details` hides. */
  flights: number;
  bookings: TripsBookingSummary[];
}

export interface TripsSummary {
  items: number;
  distinctTripIds: number;
  totalBookings: number;
  entries: TripsItemSummary[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export async function summarizeTrips(trips: unknown[], hash: Hasher): Promise<TripsSummary> {
  const items = list(trips);

  const entries = await Promise.all(items.map(async (item): Promise<TripsItemSummary> => {
    const trip = record(item);
    const bookings = list(trip?.flights);

    return {
      tripId: await hash(scalar(trip?.tripId)),
      startDate: scalar(trip?.startDate),
      endDate: scalar(trip?.endDate),
      flights: bookings.length,
      bookings: await Promise.all(bookings.map(async (raw): Promise<TripsBookingSummary> => {
        const booking = record(raw);
        const journeys = list(booking?.journeys);
        const parsed = flightsFromTripBooking(raw)[0];

        return {
          bookingId: await hash(scalar(booking?.bookingId)),
          pnr: await hash(scalar(booking?.pnr)),
          origin: scalar(booking?.origin),
          destination: scalar(booking?.destination),
          journeys: journeys.length,
          segments: journeys.reduce<number>(
            (total, journey) => total + list(record(journey)?.segments).length,
            0
          ),
          parsedFlightNumber: parsed?.flightNumber ?? "",
          parsedDate: parsed?.date ?? "",
        };
      })),
    };
  }));

  return {
    items: items.length,
    distinctTripIds: countDistinct(items.map((item) => scalar(record(item)?.tripId))),
    totalBookings: entries.reduce((total, entry) => total + entry.flights, 0),
    entries,
  };
}

export interface MergeSummary {
  /** Distinct booking ids, which is what the two listings actually disagree about. */
  onlyInDetails: number;
  onlyInTrips: number;
  inBoth: number;
  /** Rows after the merge and the reconcile, and how many of them are ready. */
  total: number;
  ready: number;
  /** Distinct ids passes were actually asked for, before the reconcile. */
  readyBookingIds: number;
  /**
   * Trip-listing bookings the reconcile moved to upcoming because no pass came
   * back for them. A high count means the listing is handing us bookings that
   * cannot be turned into passes.
   */
  unconfirmed: number;
}

export function summarizeMerge(
  fromDetails: FlightSummary[],
  fromTrips: FlightSummary[],
  merged: FlightSummary[],
  readyBookingIds: number[]
): MergeSummary {
  const detailIds = new Set(fromDetails.map((flight) => flight.bookingId));
  const tripIds = new Set(fromTrips.map((flight) => flight.bookingId));

  return {
    onlyInDetails: [...detailIds].filter((id) => !tripIds.has(id)).length,
    onlyInTrips: [...tripIds].filter((id) => !detailIds.has(id)).length,
    inBoth: [...detailIds].filter((id) => tripIds.has(id)).length,
    total: merged.length,
    ready: merged.filter((flight) => flight.isReady).length,
    readyBookingIds: readyBookingIds.length,
    unconfirmed: merged.filter(
      (flight) => flight.checkinStatus === "unknown" && !flight.isReady
    ).length,
  };
}

export interface PassSummary {
  pnr: string;
  flight: string;
  departure: string;
  hasBarcode: boolean;
  paxType: string;
}

export async function summarizePasses(
  passes: BoardingPass[],
  hash: Hasher
): Promise<{ count: number; entries: PassSummary[] }> {
  const entries = await Promise.all(passes.map(async (pass): Promise<PassSummary> => ({
    pnr: await hash(pass.pnr),
    // The label, never the passenger: a flight number is not personal.
    flight: pass.flight?.label
      || `${pass.flight?.carrierCode ?? ""}${pass.flight?.number ?? ""}`,
    departure: pass.departure?.dateUTC || pass.departure?.date || "",
    hasBarcode: hasBarcode(pass),
    paxType: pass.paxType ?? "",
  })));

  return { count: passes.length, entries };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export interface DiagnosticEnvironment {
  extensionVersion: string;
  userAgent: string;
  target?: string;
}

export interface DiagnosticReport {
  generatedAt: string;
  extensionVersion: string;
  userAgent: string;
  target?: string;
  endpoints: {
    details: EndpointReport;
    trips: EndpointReport;
    boardingpasses: EndpointReport;
  };
  details: DetailsSummary;
  trips: TripsSummary;
  merge: MergeSummary;
  passes: { count: number; entries: PassSummary[] };
  /** First page of each response, with every value stripped out. */
  schema: {
    details?: unknown;
    trips?: unknown;
    boardingpasses?: unknown;
  };
}

export interface DiagnosticInput {
  environment: DiagnosticEnvironment;
  endpoints: {
    details: EndpointLog;
    trips: EndpointLog;
    boardingpasses: EndpointLog;
  };
  orders: OrderResponse | null;
  trips: unknown[];
  merge: {
    fromDetails: FlightSummary[];
    fromTrips: FlightSummary[];
    merged: FlightSummary[];
    readyBookingIds: number[];
  };
  passes: BoardingPass[];
  schema: { details?: unknown; trips?: unknown; boardingpasses?: unknown };
  /** Fixed by tests; a fresh random salt otherwise. */
  salt?: string;
  now?: Date;
}

export async function buildDiagnosticReport(input: DiagnosticInput): Promise<DiagnosticReport> {
  const hash = createHasher(input.salt ?? createSalt());

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    extensionVersion: input.environment.extensionVersion,
    userAgent: input.environment.userAgent,
    ...(input.environment.target ? { target: input.environment.target } : {}),
    endpoints: {
      details: summarizeEndpoint(input.endpoints.details),
      trips: summarizeEndpoint(input.endpoints.trips),
      boardingpasses: summarizeEndpoint(input.endpoints.boardingpasses),
    },
    details: await summarizeDetails(input.orders, hash),
    trips: await summarizeTrips(input.trips, hash),
    merge: summarizeMerge(
      input.merge.fromDetails,
      input.merge.fromTrips,
      input.merge.merged,
      input.merge.readyBookingIds
    ),
    passes: await summarizePasses(input.passes, hash),
    schema: input.schema,
  };
}
