import type { BoardingPass, DownloadPayload, OrderItem, OrderResponse } from "./ryanair";
import { redactCustomerId } from "./diagnostics";
import { errorText } from "./errors";

// Define headers as constants to be reused and tested
export const BOARDINGPASSES_HEADERS = {
  "content-type": "application/json",
  "accept": "*/*",
  "client": "ios",
};

export const DOWNLOADPASS_HEADERS = {
  "content-type": "application/json",
  "accept": "application/vnd.apple.pkpass",
  "client": "ios",
};

export const GOOGLE_WALLET_HEADERS = {
  "content-type": "application/json",
  "accept": "*/*",
  "client": "android",
};

/** Error carrying the response status, so callers can tell transient failures from permanent ones. */
function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Ryanair occasionally accepts a connection and then never answers. The popup
 * used to hide that behind a spinner the user clicked away; the tab view stays
 * open, so without a deadline it sits on its loading state forever.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** Fetches with a deadline. A timeout is reported as 408, which callers already retry. */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
      throw httpError("Ryanair took too long to answer", 408);
    }
    throw error;
  }
}

/**
 * Ryanair pages the orders list, so a customer with many bookings only ever saw
 * the first page. The cap is a circuit breaker: at 25 bookings a page no real
 * account reaches it, but a server that keeps handing back a token must not spin
 * the extension forever. Reaching it is an error, not a shorter list.
 */
export const MAX_ORDER_PAGES = 50;

/** What one request cost and answered. Diagnostics records these; nothing else needs them. */
export interface PageVisit {
  status: number;
  durationMs: number;
  items: number;
  /** The raw body, so a caller can take a schema skeleton of it. Never persisted as-is. */
  body: unknown;
}

export type PageListener = (visit: PageVisit) => void;

/** One page of the listing: its items plus the cursor to the next one. */
interface PagedBody<T> {
  items?: T[];
  nextToken?: string | null;
}

/**
 * Follows `nextToken` from `url` until the server stops handing one back, merging
 * every page's items. `url` must already carry a query string: the cursor is
 * appended with `&`.
 */
async function fetchAllPages<T>(
  url: string,
  headers: Record<string, string>,
  label: string,
  fetchImpl: typeof fetch,
  onPage?: PageListener
): Promise<T[]> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | null | undefined;

  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(
      fetchImpl,
      nextToken ? `${url}&nextToken=${encodeURIComponent(nextToken)}` : url,
      {
        method: "GET",
        headers,
        credentials: "include",
      }
    );

    if (!response.ok) {
      if (response.status === 403) {
        throw httpError("LOGIN_REQUIRED", response.status);
      }
      throw httpError(`${label} failed: ${response.status}`, response.status);
    }

    let body: PagedBody<T>;
    try {
      body = await response.json();
    } catch {
      // The parser's own message quotes the body, and the report is meant to be postable.
      throw httpError(`${label} returned something other than JSON`, response.status);
    }
    if (body?.items) {
      items.push(...body.items);
    }

    onPage?.({
      status: response.status,
      durationMs: Date.now() - startedAt,
      items: body?.items?.length ?? 0,
      body,
    });

    nextToken = body?.nextToken;
    // A token we have already followed means the server is looping us.
    if (!nextToken || seenTokens.has(nextToken)) return items;
    seenTokens.add(nextToken);
  }

  throw new Error(`${label} did not end after ${MAX_ORDER_PAGES} pages`);
}

/** The `/details` listing, with the customer id blanked so it can be shared. */
export function ordersUrl(customerId: string, baseUrl: string): string {
  return `${baseUrl}/orders/v2/orders/${customerId}/details?type=flight&active=true&order=ASC`;
}

/**
 * Fetches every page of the customer's active flight orders and merges them.
 * `order=ASC` asks the server for soonest-first, the same way myRyanair does.
 */
export async function fetchOrders(
  customerId: string,
  xAuthToken: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  onPage?: PageListener
): Promise<OrderResponse> {
  const items = await fetchAllPages<OrderItem>(
    ordersUrl(customerId, baseUrl),
    { ...BOARDINGPASSES_HEADERS, "x-auth-token": xAuthToken },
    "orders",
    fetchImpl,
    onPage
  );

  return { items };
}

export async function fetchBoardingPass(
  payload: { customerId: string; bookingIds: number[]; xAuthToken: string | null },
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<BoardingPass[]> {
  const headers = {
    ...BOARDINGPASSES_HEADERS,
    // Deliberately sent even when there is no token: the endpoint answers 403 and
    // the caller turns that into LOGIN_REQUIRED. fetch stringifies it to "null".
    "x-auth-token": payload ? payload.xAuthToken : null,
  } as Record<string, string>;

  const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/v1/boardingpasses`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    if (response.status === 403) {
      if (!payload.xAuthToken) {
        throw httpError("LOGIN_REQUIRED", response.status);
      } else {
        throw httpError("NO_PASSES", response.status);
      }
    }
    throw httpError(`boardingpasses failed: ${response.status}`, response.status);
  }

  return response.json();
}

/**
 * Ryanair answers a request for every booking at once with a single failure, and
 * an account can now carry far more bookings than before, so the ids are asked
 * for in batches small enough that one bad booking only costs its own batch.
 */
export const BOARDING_PASS_CHUNK_SIZE = 20;

export function chunkIds(ids: number[], size = BOARDING_PASS_CHUNK_SIZE): number[][] {
  const chunks: number[][] = [];
  for (let start = 0; start < ids.length; start += Math.max(1, size)) {
    chunks.push(ids.slice(start, start + Math.max(1, size)));
  }
  return chunks;
}

/** What one chunk cost and answered, for diagnostics. */
export interface ChunkVisit {
  bookingIds: number;
  status: number | null;
  durationMs: number;
  items: number;
  error?: string;
  body?: unknown;
}

/**
 * Asks for the passes chunk by chunk and concatenates them. A 403 with a token
 * is Ryanair saying these bookings have no passes, which is an answer, not a
 * failure; without a token it is the session, and the whole fetch stops. Any
 * other failure stops it too: a partial answer would pass for a full one and
 * overwrite the cached passes, and the popup falls back to that cache on an error.
 * Sequential rather than concurrent — Ryanair sheds bursts of these.
 */
export async function fetchBoardingPassesInChunks(
  payload: { customerId: string; bookingIds: number[]; xAuthToken: string | null },
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  onChunk?: (visit: ChunkVisit) => void,
  size = BOARDING_PASS_CHUNK_SIZE
): Promise<BoardingPass[]> {
  const passes: BoardingPass[] = [];

  for (const bookingIds of chunkIds(payload.bookingIds, size)) {
    const startedAt = Date.now();
    try {
      const chunk = await fetchBoardingPass({ ...payload, bookingIds }, baseUrl, fetchImpl);
      passes.push(...chunk);
      onChunk?.({
        bookingIds: bookingIds.length,
        status: 200,
        durationMs: Date.now() - startedAt,
        items: chunk.length,
        body: chunk,
      });
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      onChunk?.({
        bookingIds: bookingIds.length,
        status: typeof status === "number" ? status : null,
        durationMs: Date.now() - startedAt,
        items: 0,
        // The id is not in this url, but it can be in whatever the network threw.
        error: redactCustomerId(errorText(error), payload.customerId),
      });

      if (status !== 403 || !payload.xAuthToken) throw error;
    }
  }

  return passes;
}

export async function downloadPass(
  payload: DownloadPayload,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<Blob> {
  const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/v1/downloadpass`, {
    method: "POST",
    headers: DOWNLOADPASS_HEADERS,
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw httpError(`downloadpass failed: ${response.status}`, response.status);
  }

  return response.blob();
}

export async function fetchGoogleWalletToken(
  payload: DownloadPayload,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/v1/boardingpass`, {
    method: "PUT",
    headers: GOOGLE_WALLET_HEADERS,
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw httpError(`google wallet boardingpass failed: ${response.status}`, response.status);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("google wallet boardingpass returned invalid JSON");
  }

  if (!data || typeof data.Token !== "string" || !data.Token.trim()) {
    throw new Error("google wallet boardingpass returned no token");
  }

  return data.Token;
}
