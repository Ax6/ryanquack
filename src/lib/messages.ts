import type { BoardingPass, DownloadPayload, FlightSummary } from "./ryanair";

/** Auth material the background reads out of the Ryanair session cookie. */
export interface Tokens {
  xAuthToken: string | null;
}

/** Messages the popup and the content script send to the background. */
export type RyqMessageType = "RYQ_GET_TOKENS" | "RYQ_FETCH_BOARDING_PASSES";

export interface RyqMessage {
  type: RyqMessageType;
}

/** Answer to `RYQ_FETCH_BOARDING_PASSES`. */
export interface PassesResult {
  passes: BoardingPass[];
  downloadPayloads: DownloadPayload[];
  flights: FlightSummary[];
}

/** The same result kept in `browser.storage.local` under `cachedPasses`. */
export interface CachedPasses extends PassesResult {
  cachedAt: number;
}

/**
 * Reads the `type` off an incoming message, which the runtime hands over as
 * `unknown`. Returns null for anything without a non-empty string type, which is
 * what the listeners treat as "not for me".
 */
export function readMessageType(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;

  const type = (message as { type?: unknown }).type;
  return typeof type === "string" && type ? type : null;
}
