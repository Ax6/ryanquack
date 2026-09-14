import { describe, it, expect, vi } from "vitest";
import { mapWithConcurrency, retry } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and keeps input order", async () => {
    const items = Array.from({ length: 76 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;

    const results = await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });

    expect(peak).toBe(4);
    expect(results.map((r) => r.status === "fulfilled" && r.value)).toEqual(
      items.map((n) => n * 2)
    );
  });

  it("settles rejections at their own index without losing the rest", async () => {
    const items = [0, 1, 2, 3, 4, 5];

    const results = await mapWithConcurrency(items, 2, async (n) => {
      if (n % 3 === 0) throw new Error(`boom ${n}`);
      return n;
    });

    expect(results.map((r) => r.status)).toEqual([
      "rejected", "fulfilled", "fulfilled",
      "rejected", "fulfilled", "fulfilled",
    ]);
    expect((results[3] as PromiseRejectedResult).reason.message).toBe("boom 3");
    expect((results[4] as PromiseFulfilledResult<number>).value).toBe(4);
  });

  it("returns immediately on an empty list", async () => {
    const worker = vi.fn();
    await expect(mapWithConcurrency([], 4, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("still runs every item when the limit is not positive", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (n) => n);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  });
});

describe("retry", () => {
  const noSleep = async () => {};

  it("returns the first success without retrying", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    await expect(retry(op, { sleep: noSleep })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries up to the attempt cap, then rethrows", async () => {
    const op = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(retry(op, { attempts: 3, sleep: noSleep })).rejects.toThrow("nope");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("stops early when the error is not retryable", async () => {
    const op = vi.fn().mockRejectedValue(Object.assign(new Error("bad"), { status: 400 }));

    await expect(
      retry(op, { attempts: 3, sleep: noSleep, shouldRetry: (e) => e.status !== 400 })
    ).rejects.toThrow("bad");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially from the base delay", async () => {
    const delays: number[] = [];
    const op = vi.fn().mockRejectedValue(new Error("nope"));

    await expect(
      retry(op, {
        attempts: 4,
        baseDelayMs: 100,
        sleep: async (ms) => { delays.push(ms); },
      })
    ).rejects.toThrow("nope");

    expect(delays).toEqual([100, 200, 400]);
  });
});
