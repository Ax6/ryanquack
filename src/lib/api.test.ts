import { describe, it, expect, vi } from "vitest";
import { fetchBoardingPass, BOARDINGPASSES_HEADERS } from "./api";

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
});
