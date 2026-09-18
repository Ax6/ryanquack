import type { BoardingPass, DownloadPayload, OrderItem, OrderResponse } from "./ryanair";

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
 * the first page. The cap is a circuit breaker: no real account reaches it, but a
 * server that keeps handing back a token must not spin the extension forever.
 */
const MAX_ORDER_PAGES = 50;

/**
 * Fetches every page of the customer's active flight orders and merges them.
 * `order=ASC` asks the server for soonest-first, the same way myRyanair does.
 */
export async function fetchOrders(
  customerId: string,
  xAuthToken: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<OrderResponse> {
  const headers = {
    ...BOARDINGPASSES_HEADERS,
    "x-auth-token": xAuthToken,
  };

  const url = `${baseUrl}/orders/v2/orders/${customerId}/details?type=flight&active=true&order=ASC`;
  const items: OrderItem[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | null | undefined;

  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
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
      throw httpError(`orders failed: ${response.status}`, response.status);
    }

    const body: OrderResponse = await response.json();
    if (body?.items) {
      items.push(...body.items);
    }

    nextToken = body?.nextToken;
    // A token we have already followed means the server is looping us.
    if (!nextToken || seenTokens.has(nextToken)) break;
    seenTokens.add(nextToken);
  }

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
