import { describe, it, expect, vi } from "vitest";
import { fetchBoardingPass, fetchGoogleWalletToken, BOARDINGPASSES_HEADERS } from "./api";

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
    const payload = {
      sequenceNumber: "10",
      lang: "en",
      arrivalStation: "STN",
      departureStation: "DUB",
      recordLocator: "MOCK01",
      isInfant: false,
    };
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
        headers: {
          "content-type": "application/json",
          "client": "android",
        },
        credentials: "include",
        body: JSON.stringify(payload),
      }
    );
  });

  it("should reject failed Google Wallet requests", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(
      fetchGoogleWalletToken({}, MOCK_URL, mockFetch as any)
    ).rejects.toThrow("google wallet boardingpass failed: 500");
  });

  it("should reject malformed Google Wallet JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("bad JSON"); },
    });

    await expect(
      fetchGoogleWalletToken({}, MOCK_URL, mockFetch as any)
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
      fetchGoogleWalletToken({}, MOCK_URL, mockFetch as any)
    ).rejects.toThrow("google wallet boardingpass returned no token");
  });
});
