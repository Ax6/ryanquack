/**
 * RyanQuack - Ryanair Boarding Pass Helper
 * Copyright (C) 2026 Aaron Russo
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
import browser from "webextension-polyfill";
import {
  buildDownloadPayload,
  decodeCustomerId,
  extractFlightsFromOrders,
  filterReadyBookings,
  markUnconfirmedFlights,
  sortPassesByDeparture,
} from "../lib/ryanair";
import type { BoardingPass, DownloadPayload, FlightSummary, OrderResponse } from "../lib/ryanair";
import type { CachedPasses, PassesResult, Tokens } from "../lib/messages";
import { readMessageType } from "../lib/messages";
import { fetchBoardingPassesInChunks, fetchOrders, ordersUrl } from "../lib/api";
import type { ChunkVisit, PageVisit } from "../lib/api";
import {
  DIAGNOSTICS_STORAGE_KEY,
  buildDiagnosticReport,
  newEndpointLog,
  redactCustomerId,
  skeleton,
} from "../lib/diagnostics";
import type { DiagnosticEnvironment, DiagnosticReport, EndpointLog } from "../lib/diagnostics";
import { errorText } from "../lib/errors";

async function getTokens(): Promise<Tokens> {
  const cookie = await browser.cookies.get({
    url: "https://www.ryanair.com",
    name: "SESSION_COOKIE"
  });

  return {
    xAuthToken: cookie ? cookie.value : null
  };
}

/** Only Firefox serves extension pages from `moz-extension:`. */
function detectTarget(): string {
  try {
    return browser.runtime.getURL("").startsWith("moz-extension://") ? "firefox" : "chrome";
  } catch {
    return "unknown";
  }
}

function readEnvironment(): DiagnosticEnvironment {
  return {
    extensionVersion: browser.runtime.getManifest().version,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    target: detectTarget(),
  };
}

async function saveDiagnostics(report: DiagnosticReport): Promise<void> {
  await browser.storage.local.set({ [DIAGNOSTICS_STORAGE_KEY]: report });
}

async function readDiagnostics(): Promise<DiagnosticReport | null> {
  const stored = await browser.storage.local.get(DIAGNOSTICS_STORAGE_KEY);
  return (stored?.[DIAGNOSTICS_STORAGE_KEY] as DiagnosticReport | undefined) ?? null;
}

/**
 * Fetches everything the popup shows, and writes a diagnostic report on the way
 * out whether or not it worked — a failed fetch is exactly when the report is
 * worth having.
 */
async function fetchPasses(customerId: string, token: string): Promise<PassesResult> {
  const endpoints = {
    details: newEndpointLog(ordersUrl(customerId, API_ORDERS_URL), customerId),
    boardingpasses: newEndpointLog(
      redactCustomerId(`${API_BOARDING_PASS_URL}/v1/boardingpasses`, customerId),
      customerId
    ),
  };
  const schema: { details?: unknown; boardingpasses?: unknown } = {};

  /** A thrown url carries the customer id, and the report is meant to be postable. */
  const reportableError = (error: unknown) => redactCustomerId(errorText(error), customerId);

  /** Logs the page and keeps a value-free skeleton of the first body it sees. */
  const recordPage = (visit: PageVisit) => {
    if (endpoints.details.requests.length === 0) schema.details = skeleton(visit.body);
    endpoints.details.requests.push({ status: visit.status, durationMs: visit.durationMs, items: visit.items });
  };

  const recordChunk = (visit: ChunkVisit) => {
    if (endpoints.boardingpasses.requests.length === 0 && visit.body !== undefined) {
      schema.boardingpasses = skeleton(visit.body);
    }
    endpoints.boardingpasses.requests.push({
      status: visit.status,
      durationMs: visit.durationMs,
      items: visit.items,
      ...(visit.error ? { error: visit.error } : {}),
    });
  };

  let orders: OrderResponse = { items: [] };
  let flights: FlightSummary[] = [];
  let bookingIds: number[] = [];
  let passes: BoardingPass[] = [];
  let downloadPayloads: DownloadPayload[] = [];

  try {
    try {
      orders = await fetchOrders(customerId, token, API_ORDERS_URL, fetch, recordPage);
    } catch (error) {
      endpoints.details.error = reportableError(error);
      throw error;
    }

    flights = extractFlightsFromOrders(orders);

    // A booking with two legs is two rows; asking for its passes twice would
    // hand the popup every pass on it twice.
    bookingIds = [...new Set(filterReadyBookings(flights))];

    if (bookingIds.length > 0) {
      // Sorted before the payloads are built: the popup pairs the two by index.
      passes = sortPassesByDeparture(await fetchBoardingPassesInChunks({
        customerId,
        bookingIds,
        xAuthToken: token,
      }, API_BOARDING_PASS_URL, fetch, recordChunk));
      downloadPayloads = passes.map(buildDownloadPayload);
    }

    // A booking that produced no pass belongs in the upcoming list, whatever its
    // status said. Reconciled before the result is built, so the cache holds the
    // same answer.
    flights = markUnconfirmedFlights(flights, passes);

    const result: PassesResult = { flights, passes, downloadPayloads };

    // Cache for offline support
    const cached: CachedPasses = { ...result, cachedAt: Date.now() };
    browser.storage.local.set({ cachedPasses: cached });

    return result;
  } finally {
    try {
      await saveDiagnostics(await buildDiagnosticReport({
        environment: readEnvironment(),
        endpoints,
        orders,
        list: { flights, readyBookingIds: bookingIds },
        passes,
        schema,
      }));
    } catch (error) {
      // A report we could not write must never be why the refresh failed.
      console.error("Diagnostics failed", error);
    }
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const type = readMessageType(message);
  if (!type) {
    return;
  }

  if (type === "RYQ_GET_TOKENS") {
    return getTokens();
  }

  if (type === "RYQ_GET_DIAGNOSTICS") {
    return readDiagnostics().catch(() => null);
  }

  if (type === "RYQ_FETCH_BOARDING_PASSES") {
    return getTokens().then(async (tokens) => {
      const token = tokens.xAuthToken;
      if (!token) {
        throw new Error("LOGIN_REQUIRED");
      }

      const customerId = decodeCustomerId(token);
      if (!customerId) {
        throw new Error("LOGIN_REQUIRED");
      }

      return fetchPasses(customerId, token);
    });
  }

});
