import { describe, it, expect, vi } from "vitest";
import { fetchBoardingPass, fetchBoardingPassesInChunks, fetchGoogleWalletToken, downloadPass, fetchOrders, chunkIds, BOARDINGPASSES_HEADERS, BOARDING_PASS_REQUEST_BUDGET, GOOGLE_WALLET_HEADERS } from "./api";
import type { ChunkVisit, PageVisit } from "./api";
import type { DownloadPayload } from "./ryanair";

const WALLET_PAYLOAD: DownloadPayload = {
  sequenceNumber: "10",
  lang: "en",
  arrivalStation: "STN",
  departureStation: "DUB",
  recordLocator: "MOCK01",
  isInfant: false,
};

describe("API Logic", () => {
  const MOCK_URL = "http://mock-api";

  it("should include correct headers including 'client: ios'", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await fetchBoardingPass(
      { customerId: "123", bookingIds: [], xAuthToken: "token" },
      MOCK_URL,
      mockFetch as any
    );

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/boardingpasses"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "client": "ios",
          "x-auth-token": "token",
        }),
      })
    );
  });

  it("should throw LOGIN_REQUIRED when 403 and no token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    await expect(
      fetchBoardingPass(
        { customerId: "123", bookingIds: [], xAuthToken: null },
        MOCK_URL,
        mockFetch as any
      )
    ).rejects.toThrow("LOGIN_REQUIRED");
  });

  it("should throw NO_PASSES when 403 and token present", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    await expect(
      fetchBoardingPass(
        { customerId: "123", bookingIds: [], xAuthToken: "some-token" },
        MOCK_URL,
        mockFetch as any
      )
    ).rejects.toThrow("NO_PASSES");
  });

  it("should throw generic error for other statuses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(
      fetchBoardingPass(
        { customerId: "123", bookingIds: [], xAuthToken: "token" },
        MOCK_URL,
        mockFetch as any
      )
    ).rejects.toThrow("boardingpasses failed: 500");
  });

  it("should request and return a Google Wallet token", async () => {
    const payload = WALLET_PAYLOAD;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ Token: "wallet-token" }),
    });

    await expect(
      fetchGoogleWalletToken(payload, MOCK_URL, mockFetch as any)
    ).resolves.toBe("wallet-token");

    expect(mockFetch).toHaveBeenCalledWith(
      `${MOCK_URL}/v1/boardingpass`,
      {
        method: "PUT",
        headers: GOOGLE_WALLET_HEADERS,
        credentials: "include",
        body: JSON.stringify(payload),
        signal: expect.any(AbortSignal),
      }
    );
    expect(GOOGLE_WALLET_HEADERS).toMatchObject({ "client": "android" });
  });

  it("should reject failed Google Wallet requests", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(
      fetchGoogleWalletToken(WALLET_PAYLOAD, MOCK_URL, mockFetch as any)
    ).rejects.toThrow("google wallet boardingpass failed: 500");
  });

  it("should reject malformed Google Wallet JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("bad JSON"); },
    });

    await expect(
      fetchGoogleWalletToken(WALLET_PAYLOAD, MOCK_URL, mockFetch as any)
    ).rejects.toThrow("google wallet boardingpass returned invalid JSON");
  });

  it.each([
    {},
    { Token: "" },
    { Token: "   " },
    { Token: 123 },
  ])("should reject a Google Wallet response without a valid token", async (body) => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    });

    await expect(
      fetchGoogleWalletToken(WALLET_PAYLOAD, MOCK_URL, mockFetch as any)
    ).rejects.toThrow("google wallet boardingpass returned no token");
  });
});

describe("Request deadlines", () => {
  const MOCK_URL = "http://mock-api";

  // What AbortSignal.timeout makes fetch reject with once the deadline passes.
  const timeoutFetch = vi.fn().mockRejectedValue(
    Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })
  ) as unknown as typeof fetch;

  it.each([
    ["fetchOrders", () => fetchOrders("123", "token", MOCK_URL, timeoutFetch)],
    ["fetchBoardingPass", () => fetchBoardingPass({ customerId: "123", bookingIds: [1], xAuthToken: "t" }, MOCK_URL, timeoutFetch)],
    ["downloadPass", () => downloadPass(WALLET_PAYLOAD, MOCK_URL, timeoutFetch)],
    ["fetchGoogleWalletToken", () => fetchGoogleWalletToken(WALLET_PAYLOAD, MOCK_URL, timeoutFetch)],
  ])("should report a stalled %s as a retryable 408", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({
      message: "Ryanair took too long to answer",
      status: 408,
    });
  });

  it("should attach an abort signal to every request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });

    await fetchOrders("123", "token", MOCK_URL, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("Order paging", () => {
  const MOCK_URL = "http://mock-api";

  /** Answers each call with the next body in the list, the way a paged server would. */
  function pagedFetch(pages: Array<Record<string, unknown>>) {
    const mockFetch = vi.fn();
    for (const page of pages) {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => page });
    }
    return mockFetch;
  }

  function requestedUrls(mockFetch: ReturnType<typeof vi.fn>): string[] {
    return mockFetch.mock.calls.map((call) => call[0] as string);
  }

  it("should follow nextToken across pages and merge the items in order", async () => {
    const mockFetch = pagedFetch([
      { items: [{ rawBooking: { bookingId: 1 } }], nextToken: "page 2" },
      { items: [{ rawBooking: { bookingId: 2 } }], nextToken: "page/3" },
      { items: [{ rawBooking: { bookingId: 3 } }] },
    ]);

    const orders = await fetchOrders("123", "token", MOCK_URL, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(orders.items.map((item) => item.rawBooking?.bookingId)).toEqual([1, 2, 3]);
    expect(orders.nextToken).toBeUndefined();
  });

  it("should ask for ascending order and send the encoded token only after the first page", async () => {
    const mockFetch = pagedFetch([
      { items: [], nextToken: "page 2" },
      { items: [], nextToken: "page/3" },
      { items: [] },
    ]);

    await fetchOrders("123", "token", MOCK_URL, mockFetch as any);

    const urls = requestedUrls(mockFetch);
    expect(urls.every((url) => url.includes("order=ASC"))).toBe(true);
    expect(urls[0]).toContain("/orders/v2/orders/123/details?type=flight&active=true");
    expect(urls[0]).not.toContain("nextToken");
    expect(urls[1]).toContain("&nextToken=page%202");
    expect(urls[2]).toContain("&nextToken=page%2F3");
  });

  it("should keep the headers and credentials of a single-page request", async () => {
    const mockFetch = pagedFetch([{ items: [], nextToken: "t2" }, { items: [] }]);

    await fetchOrders("123", "token", MOCK_URL, mockFetch as any);

    for (const call of mockFetch.mock.calls) {
      expect(call[1]).toMatchObject({
        method: "GET",
        credentials: "include",
        headers: { ...BOARDINGPASSES_HEADERS, "x-auth-token": "token" },
      });
    }
  });

  it("should stop when a page carries no nextToken", async () => {
    const mockFetch = pagedFetch([{ items: [{ rawBooking: { bookingId: 1 } }] }]);

    const orders = await fetchOrders("123", "token", MOCK_URL, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(orders.items).toHaveLength(1);
  });

  it("should stop when the server repeats a token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ rawBooking: { bookingId: 1 } }], nextToken: "stuck" }),
    });

    const orders = await fetchOrders("123", "token", MOCK_URL, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(orders.items).toHaveLength(2);
  });

  it("should give up after the page cap when the server never stops", async () => {
    let page = 0;
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ items: [], nextToken: `page-${page++}` }),
    }));

    await fetchOrders("123", "token", MOCK_URL, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(50);
  });

  it("should surface a 403 on a later page as LOGIN_REQUIRED", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [], nextToken: "t2" }) })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    await expect(
      fetchOrders("123", "token", MOCK_URL, mockFetch as any)
    ).rejects.toThrow("LOGIN_REQUIRED");
  });

  it("should surface any other failure on a later page", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [], nextToken: "t2" }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      fetchOrders("123", "token", MOCK_URL, mockFetch as any)
    ).rejects.toThrow("orders failed: 500");
  });
});

describe("Page listener", () => {
  const MOCK_URL = "http://mock-api";

  function pagedFetch(pages: Array<Record<string, unknown>>) {
    const mockFetch = vi.fn();
    for (const page of pages) {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => page });
    }
    return mockFetch;
  }

  it("should report every page to the listener, with the raw body for a schema sample", async () => {
    const mockFetch = pagedFetch([
      { items: [{ tripId: "a" }], nextToken: "t2" },
      { items: [] },
    ]);
    const visits: PageVisit[] = [];

    await fetchOrders("123", "token", MOCK_URL, mockFetch as any, (visit) => visits.push(visit));

    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({ status: 200, items: 1, body: { items: [{ tripId: "a" }], nextToken: "t2" } });
    expect(visits[1]).toMatchObject({ status: 200, items: 0 });
    expect(typeof visits[0].durationMs).toBe("number");
  });
});

describe("Boarding pass chunking", () => {
  const MOCK_URL = "http://mock-api";

  const ids = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

  /** The bookingIds of each POST the chunker made. */
  function postedIds(mockFetch: ReturnType<typeof vi.fn>): number[][] {
    return mockFetch.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).bookingIds);
  }

  it("should split the ids into chunks of 20", () => {
    expect(chunkIds(ids(45)).map((chunk) => chunk.length)).toEqual([20, 20, 5]);
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds(ids(20))).toHaveLength(1);
  });

  it("should ask for each chunk in turn and concatenate the passes", async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return { ok: true, status: 200, json: async () => body.bookingIds.map((id: number) => ({ pnr: `P${id}` })) };
    });

    const passes = await fetchBoardingPassesInChunks(
      { customerId: "123", bookingIds: ids(45), xAuthToken: "token" },
      MOCK_URL,
      mockFetch as any
    );

    expect(postedIds(mockFetch).map((chunk) => chunk.length)).toEqual([20, 20, 5]);
    expect(passes).toHaveLength(45);
    expect(passes[44]).toEqual({ pnr: "P45" });
  });

  it("should keep the other chunks when one fails for a reason other than 403", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ pnr: "A" }] })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ pnr: "C" }] });
    const visits: ChunkVisit[] = [];

    const passes = await fetchBoardingPassesInChunks(
      { customerId: "123", bookingIds: [1, 2, 3], xAuthToken: "token" },
      MOCK_URL,
      mockFetch as any,
      (visit) => visits.push(visit),
      1
    );

    expect(passes).toEqual([{ pnr: "A" }, { pnr: "C" }]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(visits.map((visit) => visit.status)).toEqual([200, 500, 200]);
    expect(visits[1].error).toContain("boardingpasses failed: 500");
  });

  it("should give up on a 403, because the session is what failed", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ pnr: "A" }] })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    await expect(fetchBoardingPassesInChunks(
      { customerId: "123", bookingIds: [1, 2, 3], xAuthToken: null },
      MOCK_URL,
      mockFetch as any,
      undefined,
      1
    )).rejects.toThrow("LOGIN_REQUIRED");

    // The third chunk was never asked for.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should halve a failed chunk and keep the passes of the ids that work", async () => {
    // Only booking 3 is refused; the other five must not pay for it.
    const mockFetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const bookingIds: number[] = JSON.parse(init.body as string).bookingIds;
      return bookingIds.includes(3)
        ? { ok: false, status: 500 }
        : { ok: true, status: 200, json: async () => bookingIds.map((id) => ({ pnr: `P${id}` })) };
    });
    const visits: ChunkVisit[] = [];

    const passes = await fetchBoardingPassesInChunks(
      { customerId: "123", bookingIds: ids(12), xAuthToken: "token" },
      MOCK_URL,
      mockFetch as any,
      (visit) => visits.push(visit),
      6
    );

    // Every booking but the one Ryanair refuses.
    expect(passes).toHaveLength(11);
    expect(passes.map((pass) => (pass as { pnr: string }).pnr)).not.toContain("P3");
    // Halved down to the single booking that fails, and no further.
    expect(postedIds(mockFetch)).toEqual([
      [1, 2, 3, 4, 5, 6], [1, 2, 3], [1, 2], [3], [4, 5, 6], [7, 8, 9, 10, 11, 12],
    ]);
    const failures = visits.filter((visit) => visit.error);
    expect(failures.map((visit) => visit.bookingIds)).toEqual([6, 3, 1]);
  });

  it("should report the single booking that failed, so diagnostics can name it", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const visits: ChunkVisit[] = [];

    await fetchBoardingPassesInChunks(
      { customerId: "123", bookingIds: [1, 2], xAuthToken: "token" },
      MOCK_URL,
      mockFetch as any,
      (visit) => visits.push(visit),
      2
    );

    expect(visits.map((visit) => visit.bookingIds)).toEqual([2, 1, 1]);
    expect(visits.every((visit) => visit.error?.includes("boardingpasses failed: 500"))).toBe(true);
  });

  it("should cap the requests an endpoint that fails for everything can cost", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const visits: ChunkVisit[] = [];

    const passes = await fetchBoardingPassesInChunks(
      { customerId: "123", bookingIds: ids(40), xAuthToken: "token" },
      MOCK_URL,
      mockFetch as any,
      (visit) => visits.push(visit),
      20
    );

    // Two chunks, four requests each, rather than a request per booking.
    expect(passes).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2 * BOARDING_PASS_REQUEST_BUDGET);
    expect(visits.filter((visit) => visit.error?.includes("gave up"))).toHaveLength(1);
  });

  it("should still give up on a 403 in the middle of a bisection", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    await expect(fetchBoardingPassesInChunks(
      { customerId: "123", bookingIds: [1, 2, 3, 4], xAuthToken: null },
      MOCK_URL,
      mockFetch as any,
      undefined,
      4
    )).rejects.toThrow("LOGIN_REQUIRED");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should keep the customer id out of the error it reports", async () => {
    const customerId = "cust-0d41d8cd98f0";
    const mockFetch = vi.fn().mockRejectedValue(
      new Error(`NetworkError fetching https://api/orders/${customerId}/passes`)
    );
    const visits: ChunkVisit[] = [];

    await fetchBoardingPassesInChunks(
      { customerId, bookingIds: [1], xAuthToken: "token" },
      MOCK_URL,
      mockFetch as any,
      (visit) => visits.push(visit)
    );

    expect(visits[0].error).toBe("NetworkError fetching https://api/orders/<cid>/passes");
  });
});

