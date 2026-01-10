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

export async function fetchOrders(
  customerId: string,
  xAuthToken: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
) {
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
      throw new Error("LOGIN_REQUIRED");
    }
    throw new Error(`orders failed: ${response.status}`);
  }

  return response.json();
}

export async function fetchBoardingPass(
  payload: { customerId: string; bookingIds: number[]; xAuthToken: string | null },
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
) {
  const headers = {
    ...BOARDINGPASSES_HEADERS,
    "x-auth-token": payload ? payload.xAuthToken : null,
  };

  const response = await fetchImpl(`${baseUrl}/v1/boardingpasses`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    if (response.status === 403) {
      if (!payload.xAuthToken) {
        throw new Error("LOGIN_REQUIRED");
      } else {
        throw new Error("NO_PASSES");
      }
    }
    throw new Error(`boardingpasses failed: ${response.status}`);
  }

  return response.json();
}

export async function downloadPass(
  payload: any,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
) {
  const response = await fetchImpl(`${baseUrl}/v1/downloadpass`, {
    method: "POST",
    headers: DOWNLOADPASS_HEADERS,
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`downloadpass failed: ${response.status}`);
  }

  return response.blob();
}
