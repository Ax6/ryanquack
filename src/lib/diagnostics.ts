/**
 * A report the user can paste into a GitHub issue without handing over their
 * travel plans. The only way to tell what shape a reporter's account actually
 * gets back from Ryanair is to see it — so this describes the responses
 * (counts, keys, types) and never carries a value that identifies anyone.
 *
 * Nothing here touches a browser API: the background passes the environment in
 * and persists the result, which keeps every helper unit-testable.
 */
import type { BoardingPass, BookingSource, FlightSummary, OrderResponse } from "./ryanair";
import {
  bookingSource,
  classifyLeg,
  countBookings,
  extractFlightsFromOrders,
  hasBarcode,
  hasMatchingPass,
  indexPasses,
  legStatuses,
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
  bookingId: string;
  pnr: string;
  type: string;
  /** Where the flights were read from: `rawBooking`, or `payload` when Ryanair failed to load it. */
  source: BookingSource;
  /** Legs Ryanair sent, legs that have already flown, and legs the list shows. */
  legs: number;
  flownLegs: number;
  parsedLegs: number;
  checkins: string[];
}

/** Every item, counted. The rows below are examples; this is the whole listing. */
export interface DetailsTally {
  types: Record<string, number>;
  checkins: Record<string, number>;
  sources: Record<string, number>;
  processingStatuses: Record<string, number>;
  /** Items Ryanair itself could not load the booking for. */
  rawBookingFailures: number;
}

export interface DetailsSummary {
  items: number;
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

  const tallies: DetailsTally = {
    types: {}, checkins: {}, sources: {}, processingStatuses: {}, rawBookingFailures: 0,
  };
  for (const item of items) {
    tally(tallies.types, item.type);
    tally(tallies.sources, bookingSource(item));
    tally(tallies.processingStatuses, item.processingStatus?.code);
    if (item.rawBookingFailure != null) tallies.rawBookingFailures++;
    for (const checkin of item.rawBooking?.checkins ?? []) tally(tallies.checkins, checkin.status);
  }

  const all = await Promise.all(items.map(async (item): Promise<DetailsItemSummary> => {
    const raw = item.rawBooking;
    const bookingId = raw?.bookingId ?? item.payload?.booking?.bookingId;
    const pnr = raw?.recordLocator ?? item.payload?.booking?.pnr;
    const legs = raw?.flights ?? [];

    return {
      bookingId: await hash(bookingId),
      pnr: await hash(pnr),
      type: item.type ?? "",
      source: bookingSource(item),
      legs: legs.length,
      flownLegs: raw
        ? legs.filter((leg) => classifyLeg(legStatuses(raw, leg.journeyNum)).flown).length
        : 0,
      // A leg the parser cannot read is the difference between what Ryanair sent
      // and what the list shows, which is the only thing the report is here for.
      parsedLegs: extractFlightsFromOrders({ items: [item] })
        .filter((flight) => flight.date && flight.flightNumber).length,
      checkins: (raw?.checkins ?? []).map((checkin) => checkin.status ?? ""),
    };
  }));

  // A leg we could not read, or a booking read from the fallback, is what the
  // reader is looking for.
  const { kept, truncated } = retain(all, (entry) =>
    entry.source !== "rawBooking" || entry.legs !== entry.flownLegs + entry.parsedLegs);

  return {
    items: items.length,
    distinctBookingIds: countDistinct(items.map(
      (item) => item.rawBooking?.bookingId ?? item.payload?.booking?.bookingId
    )),
    tally: tallies,
    entries: kept,
    entriesTruncated: truncated,
  };
}

/* ------------------------------------------------------------------ *
 * The list the popup shows
 * ------------------------------------------------------------------ */

/**
 * The listing after it has been reconciled against the passes. These are the
 * numbers the popup's count line is built from, so a reporter's "it shows N"
 * can be checked against them.
 */
export interface ListSummary {
  /** Distinct bookings, and legs of them still to fly. */
  bookings: number;
  flights: number;
  /** Legs shown through a pass rather than as an upcoming row. */
  ready: number;
  upcoming: number;
  /** Bookings the pass endpoint was asked about, and how many it answered for. */
  readyBookingIds: number;
  bookingIdsWithPasses: number;
  /** A ready flight with no pass is in neither list. Must be zero. */
  renderedNowhere: number;
  /** Legs by check-in state, as the popup labels them. */
  statuses: Record<string, number>;
}

export function summarizeList(
  flights: FlightSummary[],
  readyBookingIds: number[],
  passes: BoardingPass[] = []
): ListSummary {
  const index = indexPasses(passes);
  const matched = flights.filter((flight) => hasMatchingPass(flight, index));
  const statuses: Record<string, number> = {};
  for (const flight of flights) tally(statuses, flight.checkinStatus);

  return {
    bookings: countBookings(flights),
    flights: flights.length,
    ready: flights.filter((flight) => flight.isReady).length,
    upcoming: flights.filter((flight) => !flight.isReady).length,
    readyBookingIds: readyBookingIds.length,
    bookingIdsWithPasses: new Set(matched.map((flight) => flight.bookingId)).size,
    renderedNowhere: flights.filter(
      (flight) => flight.isReady && !hasMatchingPass(flight, index)
    ).length,
    statuses,
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
    boardingpasses: EndpointReport;
  };
  details: DetailsSummary;
  list: ListSummary;
  passes: PassesSummary;
  /** First page of each response, with every value stripped out. */
  schema: {
    details?: unknown;
    boardingpasses?: unknown;
  };
}

export interface DiagnosticInput {
  environment: DiagnosticEnvironment;
  endpoints: {
    details: EndpointLog;
    boardingpasses: EndpointLog;
  };
  orders: OrderResponse | null;
  list: {
    /** The flights after `markUnconfirmedFlights`, which is what the popup gets. */
    flights: FlightSummary[];
    readyBookingIds: number[];
  };
  passes: BoardingPass[];
  schema: { details?: unknown; boardingpasses?: unknown };
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
      boardingpasses: summarizeEndpoint(input.endpoints.boardingpasses),
    },
    details: await summarizeDetails(input.orders, hash),
    list: summarizeList(input.list.flights, input.list.readyBookingIds, input.passes),
    passes: await summarizePasses(input.passes, hash),
    schema: input.schema,
  };
}
