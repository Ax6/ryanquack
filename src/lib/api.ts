import type { BoardingPass, DownloadPayload, OrderResponse } from "./ryanair";

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

  const response = await fetchImpl(
    `${baseUrl}/orders/v2/orders/${customerId}/details?type=flight&active=true`,
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

  return response.json();
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

  const response = await fetchImpl(`${baseUrl}/v1/boardingpasses`, {
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
  const response = await fetchImpl(`${baseUrl}/v1/downloadpass`, {
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
  const response = await fetchImpl(`${baseUrl}/v1/boardingpass`, {
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
