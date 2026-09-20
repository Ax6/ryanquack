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
import type { BoardingPass, FlightSummary, OrderResponse, TripBookingTrace } from "./ryanair";
import {
  UNPARSED_TRIP_BOOKING,
  extractFlightsFromOrders,
  hasBarcode,
  hasMatchingPass,
  indexPasses,
  parseTripBookings,
} from "./ryanair";

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

/** Longer than any field name Ryanair uses, so anything longer is a value. */
const MAX_KEY_LENGTH = 40;
/** A key that reads as an identifier: a record locator, or a numeric id. */
const IDENTIFIER_KEY = [/^[A-Z0-9]{6}$/, /^\d{4,}$/];

/** This endpoint is undocumented, so a map keyed by pnr has to be assumed possible. */
function maskKey(key: string): string {
  return key.length > MAX_KEY_LENGTH || IDENTIFIER_KEY.some((pattern) => pattern.test(key))
    ? "<id>"
    : key;
}

/**
 * The shape of a response with every value removed: keys survive and primitives
 * become their type. String lengths go with the strings — a name's length is the
 * passenger's business, and the boarding pass skeleton would otherwise carry one
 * per passenger.
 *
 * The elements of an array are described together rather than sampled, and each
 * key says how many of them carried it (`bookingId: "number ×90/135"`). Sampling
 * element zero would hide exactly the heterogeneity we are looking for: a
 * listing that parses for nine bookings in ten looks perfect from the first one.
 */
export function skeleton(value: unknown, maxDepth: number = SKELETON_MAX_DEPTH): unknown {
  return shapeOf([value], maxDepth, new Set());
}

/** `path` holds the ancestors of `values`, so a body that points at itself terminates. */
function shapeOf(values: unknown[], depth: number, path: Set<unknown>): unknown {
  const tokens = new Set<string>();
  const records: Array<Record<string, unknown>> = [];
  const arrays: unknown[][] = [];

  for (const value of values) {
    if (value === null) tokens.add("null");
    // number, boolean, undefined, bigint, symbol, function.
    else if (typeof value !== "object") tokens.add(typeof value);
    else if (path.has(value)) tokens.add("…circular");
    else if (Array.isArray(value)) arrays.push(value);
    else records.push(value as Record<string, unknown>);
  }

  if (records.length === 0 && arrays.length === 0) return [...tokens].join("|");
  if (depth <= 0) return "…";

  const structured = [...records, ...arrays];
  for (const value of structured) path.add(value);
  try {
    // An array costs no depth: `flights[0]` is the same level as `flights`, and
    // charging for both would cut the nesting we are here to look at in half.
    // Objects win a level that holds both: their keys are what we came to read.
    return records.length === 0
      ? arrayShape(arrays, depth, path)
      : recordShape(records, values.length, depth, path);
  } finally {
    for (const value of structured) path.delete(value);
  }
}

/** Sibling arrays are described as one, so every element is accounted for. */
function arrayShape(arrays: unknown[][], depth: number, path: Set<unknown>): unknown {
  const elements = arrays.flat();
  if (elements.length === 0) return [];

  const lengths = arrays.map((array) => array.length);
  const shortest = Math.min(...lengths);
  const longest = Math.max(...lengths);

  return [
    shapeOf(elements, depth, path),
    `…×${shortest === longest ? longest : `${shortest}–${longest}`}`,
  ];
}

/**
 * The union of the keys across `records`, each carrying how many of the `total`
 * values had it. A key missing from half the elements is the whole finding, so
 * it is on the type where the shape is a leaf and on the key where it is not.
 */
function recordShape(
  records: Array<Record<string, unknown>>,
  total: number,
  depth: number,
  path: Set<unknown>
): Record<string, unknown> {
  const byKey = new Map<string, unknown[]>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      const masked = maskKey(key);
      const seen = byKey.get(masked);
      if (seen) seen.push(value);
      else byKey.set(masked, [value]);
    }
  }

  const shape: Record<string, unknown> = {};
  for (const [key, values] of byKey) {
    const inner = shapeOf(values, depth - 1, path);
    // One value describes itself; a fraction of one says nothing.
    const presence = total > 1 ? ` ×${values.length}/${total}` : "";

    if (!presence) shape[key] = inner;
    else if (typeof inner === "string") shape[key] = `${inner}${presence}`;
    else if (values.length === total) shape[key] = inner;
    else shape[`${key}${presence}`] = inner;
  }
  return shape;
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
 *
 * Tallies first, rows second. An account with 135 bookings writes a row per
 * booking three times over, which is more than a GitHub comment holds — and the
 * rows say nothing the tallies do not, since every value on them is one of a
 * handful of constants of ours. So the tallies count everything and the rows are
 * kept as examples.
 * ------------------------------------------------------------------ */

/** Example rows kept per section. */
export const MAX_ENTRIES = 20;

/**
 * At most `MAX_ENTRIES` rows: the ones worth reading first, then the earliest of
 * the rest. Kept in the order they arrived, so an index still means something.
 */
function retain<T>(
  entries: T[],
  interesting: (entry: T) => boolean
): { kept: T[]; truncated: number } {
  if (entries.length <= MAX_ENTRIES) return { kept: entries, truncated: 0 };

  const chosen = new Set<number>();
  entries.forEach((entry, index) => {
    if (chosen.size < MAX_ENTRIES && interesting(entry)) chosen.add(index);
  });
  for (let index = 0; index < entries.length && chosen.size < MAX_ENTRIES; index++) {
    chosen.add(index);
  }

  return {
    kept: entries.filter((_, index) => chosen.has(index)),
    truncated: entries.length - chosen.size,
  };
}

/** One more of `key`. A key of null is a finding too: nothing we know of answered. */
function tally(counts: Record<string, number>, key: string | null | undefined): void {
  const name = key || "none";
  counts[name] = (counts[name] ?? 0) + 1;
}

export interface DetailsItemSummary {
  tripId: string;
  productId: string;
  bookingId: string;
  pnr: string;
  type: string;
  /** Legs Ryanair sent, and legs our own parser got a usable row out of. */
  legs: number;
  parsedLegs: number;
  checkins: string[];
}

/** Every item, counted. The rows below are examples; this is the whole listing. */
export interface DetailsTally {
  types: Record<string, number>;
  checkins: Record<string, number>;
}

export interface DetailsSummary {
  items: number;
  /** A trip id shared by several items is the bug we are chasing, so count them. */
  distinctTripIds: number;
  distinctProductIds: number;
  distinctBookingIds: number;
  tally: DetailsTally;
  entries: DetailsItemSummary[];
  /** Rows the cap left out, so nobody reads `entries.length` as the real count. */
  entriesTruncated: number;
}

function countDistinct(values: Array<string | number | undefined>): number {
  return new Set(values.filter((value) => value !== undefined && value !== "")).size;
}

export async function summarizeDetails(
  orders: OrderResponse | null | undefined,
  hash: Hasher
): Promise<DetailsSummary> {
  const items = orders?.items ?? [];

  const tallies: DetailsTally = { types: {}, checkins: {} };
  for (const item of items) {
    tally(tallies.types, item.type);
    for (const checkin of item.rawBooking?.checkins ?? []) tally(tallies.checkins, checkin.status);
  }

  const all = await Promise.all(items.map(async (item): Promise<DetailsItemSummary> => {
    const raw = item.rawBooking;
    const bookingId = raw?.bookingId ?? item.payload?.booking?.bookingId;
    const pnr = raw?.recordLocator ?? item.payload?.booking?.pnr;

    return {
      tripId: await hash(item.tripId),
      productId: await hash(item.productId),
      bookingId: await hash(bookingId),
      pnr: await hash(pnr),
      type: item.type ?? "",
      legs: (raw?.flights ?? []).length,
      // A leg the parser cannot read is the difference between what Ryanair sent
      // and what the list shows, which is the only thing the report is here for.
      parsedLegs: extractFlightsFromOrders({ items: [item] })
        .filter((flight) => flight.date && flight.flightNumber).length,
      checkins: (raw?.checkins ?? []).map((checkin) => checkin.status ?? ""),
    };
  }));

  // A leg we could not read is what the reader is looking for.
  const { kept, truncated } = retain(all, (entry) => entry.legs !== entry.parsedLegs);

  return {
    items: items.length,
    distinctTripIds: countDistinct(items.map((item) => item.tripId)),
    distinctProductIds: countDistinct(items.map((item) => item.productId)),
    distinctBookingIds: countDistinct(items.map(
      (item) => item.rawBooking?.bookingId ?? item.payload?.booking?.bookingId
    )),
    tally: tallies,
    entries: kept,
    entriesTruncated: truncated,
  };
}

/**
 * What our own parser made of one booking: whether it found it at all, and which
 * key it read each field out of. Every key is a constant of ours, so this
 * describes the parser rather than the traveller.
 */
export interface TripsBookingSummary extends TripBookingTrace {
  bookingId: string;
  pnr: string;
  journeys: number;
  segments: number;
}

export interface TripsItemSummary {
  tripId: string;
  /** How many bookings the trip holds. Anything above 1 is what `/details` hides. */
  flights: number;
  /** How many of them the parser found. The gap is the bug, when there is one. */
  parsedBookings: number;
  bookings: TripsBookingSummary[];
  bookingsTruncated: number;
}

/**
 * Every booking of every trip, counted by the key each lookup answered on. This
 * is the diagnosis in full: 90 ids under `bookingId` and 45 under `id` says what
 * a listing of 135 rows would, in four lines.
 */
export interface TripsParseTally {
  bookingIdKeys: Record<string, number>;
  pnrKeys: Record<string, number>;
  dateKeys: Record<string, number>;
  flightNumberKeys: Record<string, number>;
  routeKeys: Record<string, number>;
  parsed: number;
  unparsed: number;
  /** Of the parsed: an id that was a number, and one written as digits. An
   *  unparsed booking has no id at all, so it is in neither. */
  numericBookingIds: number;
  stringBookingIds: number;
}

export interface TripsSummary {
  items: number;
  distinctTripIds: number;
  totalBookings: number;
  totalParsedBookings: number;
  tally: TripsParseTally;
  entries: TripsItemSummary[];
  /** Rows the cap left out, so nobody reads `entries.length` as the real count. */
  entriesTruncated: number;
}

function tallyBookings(bookings: TripsBookingSummary[]): TripsParseTally {
  const counts: TripsParseTally = {
    bookingIdKeys: {}, pnrKeys: {}, dateKeys: {}, flightNumberKeys: {}, routeKeys: {},
    parsed: 0, unparsed: 0, numericBookingIds: 0, stringBookingIds: 0,
  };

  for (const booking of bookings) {
    tally(counts.bookingIdKeys, booking.bookingIdKey);
    tally(counts.pnrKeys, booking.pnrKey);
    tally(counts.dateKeys, booking.dateKey);
    tally(counts.flightNumberKeys, booking.flightNumberKey);
    tally(counts.routeKeys, booking.routeKey);

    if (!booking.parsed) {
      counts.unparsed++;
      continue;
    }
    counts.parsed++;
    if (booking.bookingIdNumeric) counts.numericBookingIds++;
    else counts.stringBookingIds++;
  }

  return counts;
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

  const built = await Promise.all(items.map(async (item) => {
    const trip = record(item);
    const bookings = list(trip?.flights);

    const rows = await Promise.all(bookings.map(async (raw): Promise<TripsBookingSummary> => {
        const booking = record(raw);
        const journeys = list(booking?.journeys);
        const [parsed] = parseTripBookings(raw);
        const flight = parsed?.flights[0];

      return {
        ...(parsed?.trace ?? UNPARSED_TRIP_BOOKING),
        bookingId: await hash(flight ? String(flight.bookingId) : ""),
        pnr: await hash(flight?.pnr ?? ""),
        journeys: journeys.length,
        segments: journeys.reduce<number>(
          (total, journey) => total + list(record(journey)?.segments).length,
          0
        ),
      };
    }));

    // A booking the parser could not read is the one worth showing.
    const { kept, truncated } = retain(rows, (booking) => !booking.parsed);

    return {
      rows,
      entry: {
        tripId: await hash(scalar(trip?.tripId)),
        flights: bookings.length,
        // Harvested from the whole trip, so a listing that keeps its bookings
        // somewhere other than `flights` is still counted here.
        parsedBookings: parseTripBookings(item).length,
        bookings: kept,
        bookingsTruncated: truncated,
      },
    };
  }));

  const entries = built.map((trip) => trip.entry);
  // A trip holding more than one booking is what `/details` hides, so show those.
  const { kept, truncated } = retain(entries, (entry) => entry.flights > 1);

  return {
    items: items.length,
    distinctTripIds: countDistinct(items.map((item) => scalar(record(item)?.tripId))),
    totalBookings: entries.reduce((total, entry) => total + entry.flights, 0),
    totalParsedBookings: entries.reduce((total, entry) => total + entry.parsedBookings, 0),
    tally: tallyBookings(built.flatMap((trip) => trip.rows)),
    entries: kept,
    entriesTruncated: truncated,
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
  /** Distinct bookings a returned pass could actually be matched to. */
  bookingIdsWithPasses: number;
  /**
   * Bookings that are neither in the pass list nor the upcoming one. Zero by
   * construction, and here to prove it: this is the count that was the bug.
   */
  renderedNowhere: number;
}

export function summarizeMerge(
  fromDetails: FlightSummary[],
  fromTrips: FlightSummary[],
  merged: FlightSummary[],
  readyBookingIds: number[],
  passes: BoardingPass[] = []
): MergeSummary {
  const detailIds = new Set(fromDetails.map((flight) => flight.bookingId));
  const tripIds = new Set(fromTrips.map((flight) => flight.bookingId));
  const index = indexPasses(passes);
  const matched = merged.filter((flight) => hasMatchingPass(flight, index));

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
    bookingIdsWithPasses: new Set(matched.map((flight) => flight.bookingId)).size,
    // Ready means "a pass will speak for it", so a ready flight with no pass is
    // in neither list.
    renderedNowhere: merged.filter(
      (flight) => flight.isReady && !hasMatchingPass(flight, index)
    ).length,
  };
}

/**
 * A pass row says whether it arrived and whether it was scannable, and nothing
 * else. The flight and the departure time used to be here, which made the report
 * the reporter's itinerary written out a third time.
 */
export interface PassSummary {
  pnr: string;
  hasBarcode: boolean;
}

export interface PassesSummary {
  count: number;
  /** One tally for the account instead of a passenger type per row. */
  paxTypes: Record<string, number>;
  entries: PassSummary[];
  /** Rows the cap left out, so nobody reads `entries.length` as the real count. */
  entriesTruncated: number;
}

export async function summarizePasses(
  passes: BoardingPass[],
  hash: Hasher
): Promise<PassesSummary> {
  const paxTypes: Record<string, number> = {};
  for (const pass of passes) {
    const paxType = pass.paxType || "unknown";
    paxTypes[paxType] = (paxTypes[paxType] ?? 0) + 1;
  }

  const all = await Promise.all(passes.map(async (pass): Promise<PassSummary> => ({
    pnr: await hash(pass.pnr),
    hasBarcode: hasBarcode(pass),
  })));

  // A pass with no scannable code is the one worth showing.
  const { kept, truncated } = retain(all, (entry) => !entry.hasBarcode);

  return { count: passes.length, paxTypes, entries: kept, entriesTruncated: truncated };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export interface DiagnosticEnvironment {
  extensionVersion: string;
  userAgent: string;
  target?: string;
}

/** Ordered: an Edge or Opera string also claims to be Chrome. */
const BROWSERS: Array<[string, RegExp]> = [
  ["Firefox", /Firefox\/(\d+)/],
  ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
  ["Opera", /OPR\/(\d+)/],
  ["Chrome", /Chrome\/(\d+)/],
  ["Safari", /Version\/(\d+).*Safari/],
];

/** Ordered too: an iPhone is "like Mac OS X" and an Android is a Linux. */
const SYSTEMS: Array<[string, RegExp]> = [
  ["Android", /Android/],
  ["iOS", /iPhone|iPad|iPod/],
  ["ChromeOS", /CrOS/],
  ["Windows", /Windows/],
  ["macOS", /Macintosh|Mac OS X/],
  ["Linux", /Linux/],
];

/**
 * Browser, major version and OS family. Which bug a build has is all we ever act
 * on; the rest of the string is a fingerprint, and the minor version is enough
 * to single a reporter out.
 */
export function summarizeUserAgent(userAgent: string): string {
  const browser = BROWSERS.find(([, pattern]) => pattern.test(userAgent));
  const system = SYSTEMS.find(([, pattern]) => pattern.test(userAgent));

  const name = browser
    ? `${browser[0]} ${userAgent.match(browser[1])?.[1] ?? ""}`.trim()
    : "unknown browser";

  return system ? `${name} on ${system[0]}` : name;
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
  passes: PassesSummary;
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
    userAgent: summarizeUserAgent(input.environment.userAgent),
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
      input.merge.readyBookingIds,
      input.passes
    ),
    passes: await summarizePasses(input.passes, hash),
    schema: input.schema,
  };
}
