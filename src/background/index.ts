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
import { buildDownloadPayload, decodeCustomerId, extractFlightsFromOrders, filterReadyBookings } from "../lib/ryanair";
import type { BoardingPass, DownloadPayload } from "../lib/ryanair";
import type { CachedPasses, PassesResult, Tokens } from "../lib/messages";
import { readMessageType } from "../lib/messages";
import { fetchBoardingPass, fetchOrders } from "../lib/api";

async function getTokens(): Promise<Tokens> {
  const cookie = await browser.cookies.get({
    url: "https://www.ryanair.com",
    name: "SESSION_COOKIE"
  });

  return {
    xAuthToken: cookie ? cookie.value : null
  };
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const type = readMessageType(message);
  if (!type) {
    return;
  }

  if (type === "RYQ_GET_TOKENS") {
    return getTokens();
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

      // 1. Fetch Orders
      const orders = await fetchOrders(customerId, token, API_ORDERS_URL);
      
      // 2. Extract Flights
      const flights = extractFlightsFromOrders(orders);
      const bookingIds = filterReadyBookings(flights);

      let passes: BoardingPass[] = [];
      let downloadPayloads: DownloadPayload[] = [];

      // 3. Fetch Boarding Passes ONLY if we have ready bookings
      if (bookingIds.length > 0) {
        passes = await fetchBoardingPass({
          customerId,
          bookingIds,
          xAuthToken: token,
        }, API_BOARDING_PASS_URL);
        downloadPayloads = passes.map(buildDownloadPayload);
      }

      const result: PassesResult = {
        flights,
        passes,
        downloadPayloads
      };

      // Cache for offline support
      const cached: CachedPasses = { ...result, cachedAt: Date.now() };
      browser.storage.local.set({ cachedPasses: cached });

      return result;
    });
  }

});