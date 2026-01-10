import browser from "webextension-polyfill";
import { buildDownloadPayload, decodeCustomerId, extractFlightsFromOrders, filterReadyBookings } from "../lib/ryanair";
import { fetchBoardingPass, downloadPass, fetchOrders } from "../lib/api";

async function getTokens() {
  const cookie = await browser.cookies.get({
    url: "https://www.ryanair.com",
    name: "SESSION_COOKIE"
  });

  return {
    xAuthToken: cookie ? cookie.value : null
  };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "RYQ_GET_TOKENS") {
    return getTokens();
  }

  if (message.type === "RYQ_FETCH_BOARDING_PASSES") {
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

      let passes: any[] = [];
      let downloadPayloads: any[] = [];

      // 3. Fetch Boarding Passes ONLY if we have ready bookings
      if (bookingIds.length > 0) {
        passes = await fetchBoardingPass({
          customerId,
          bookingIds,
          xAuthToken: token,
        }, API_BOARDING_PASS_URL);
        downloadPayloads = passes.map(buildDownloadPayload);
      }

      const result = {
        flights,
        passes,
        downloadPayloads
      };

      // Cache for offline support
      browser.storage.local.set({ cachedPasses: result });

      return result;
    });
  }

  if (message.type === "RYQ_DOWNLOAD_PASS") {
    return downloadPass(message.payload, API_DOWNLOAD_PASS_URL)
      .then(async (blob) => {
        const url = URL.createObjectURL(blob);
        await browser.downloads.download({
          url,
          filename: "boarding-pass.pkpass",
          saveAs: false,
        });
        URL.revokeObjectURL(url);
      });
  }
});