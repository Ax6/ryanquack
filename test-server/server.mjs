import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PORT = 3000;
const DATA_DIR = new URL("data", import.meta.url).pathname;

let currentScenario = "MIXED";
let passesCount = 1;
// "recordLocator|sequenceNumber" of every pass handed out without a barcode, so
// /v1/downloadpass can answer the way a real backend plausibly would.
const barcodelessPasses = new Set();
let upcomingCount = 1;

// Ryanair pages this list; 30 is what a real account gets back per request.
const ORDERS_PAGE_SIZE = 30;

/** Opaque cursor, like the real one: it only has to survive a round trip. */
function encodeNextToken(offset) {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64");
}

function decodeNextToken(token) {
  const offset = Number.parseInt(Buffer.from(token, "base64").toString("utf8").replace("offset:", ""), 10);
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

/**
 * Departure dates scattered rather than ascending, so the extension's own sort
 * has something to do. The stride is coprime with the cycle, so days repeat only
 * after 37 bookings.
 */
function departureAt(baseISO, index) {
  const departure = new Date(baseISO);
  departure.setUTCDate(departure.getUTCDate() + ((index * 13) % 37));
  return departure.toISOString().replace(".000Z", "Z");
}

/**
 * Ryanair groups several bookings into one trip, and `/details` answers with one
 * entry per trip — so the other six are invisible there. That is issue #20 seen
 * from the server side, and the trip listing below is the only place they exist.
 */
const HIDDEN_BOOKINGS_PER_TRIP = 6;
/** Well clear of the 1000-range ids, so a hidden booking is obvious in a log. */
const HIDDEN_ID_BASE = 9000;

/** One source of truth for both listings, so the union is exactly the hidden six. */
function generateBookings(pCount, uCount) {
  const bookings = [];
  let idCounter = 1000;

  // Passes (Checked In)
  for (let i = 0; i < pCount; i++) {
    const id = idCounter++;
    bookings.push({
      id,
      pnr: `PASS${i+1}`,
      origin: "STN",
      destination: "DUB",
      flightNumber: `FR${id}`,
      departUTC: departureAt("2026-01-15T10:00:00Z", i),
      status: "checkedin",
    });
  }

  // Upcoming (No Checkin)
  for (let i = 0; i < uCount; i++) {
    const id = idCounter++;
    bookings.push({
      id,
      pnr: `NEXT${i+1}`,
      origin: "DUB",
      destination: "BER",
      flightNumber: `FR${id}`,
      departUTC: departureAt("2026-05-20T10:00:00Z", i),
      status: "nocheckin",
    });
  }

  return bookings;
}

/** The six travelling companions the first trip hides: same flight, same day. */
function hiddenBookingsFor(booking) {
  return Array.from({ length: HIDDEN_BOOKINGS_PER_TRIP }, (_, i) => ({
    ...booking,
    id: HIDDEN_ID_BASE + i + 1,
    pnr: `GROUP${i+1}`,
  }));
}

function generateOrders(pCount, uCount) {
  const items = generateBookings(pCount, uCount).map((booking) => ({
    tripId: `trip-${booking.id}`,
    productId: String(booking.id),
    type: "flight",
    payload: { booking: { bookingId: booking.id, pnr: booking.pnr } },
    rawBooking: {
      bookingId: booking.id,
      recordLocator: booking.pnr,
      flights: [{
        journeyNum: 0,
        origin: booking.origin,
        destination: booking.destination,
        flightNumber: booking.flightNumber,
        times: { departUTC: booking.departUTC },
      }],
      checkins: [{ journeyNum: 0, status: booking.status }],
    },
  }));

  return { items };
}

/** A booking as the trip listing nests it: journeys, each holding its segments. */
function tripBooking(booking) {
  return {
    bookingId: booking.id,
    pnr: booking.pnr,
    origin: booking.origin,
    destination: booking.destination,
    journeys: [{
      journeyNum: 0,
      segments: [{
        origin: booking.origin,
        destination: booking.destination,
        flightNumber: booking.flightNumber,
        departureDateUTC: booking.departUTC,
        arrivalDateUTC: booking.departUTC,
      }],
    }],
    passengers: [{ first: "Ryan", last: "Quack" }],
    arrivalDate: booking.departUTC,
    linkedBookings: [],
  };
}

/**
 * The same booking in a shape nobody guessed at: the id under `id` and written
 * as digits rather than a number, the locator under `recordLocator`, the legs a
 * level deeper than `journeys[].segments[]`. The bookings the extension is
 * missing are the ones it has never seen the shape of, so a mock that answers in
 * the shape the parser looks for proves nothing about the bug it is here to
 * catch. `linkedBookings` holds an id the harvest must not mistake for a booking
 * of this trip.
 */
function hiddenTripBooking(booking) {
  return {
    id: String(booking.id),
    recordLocator: booking.pnr,
    passengers: [{ id: 1, first: "Ryan", last: "Quack" }],
    itinerary: {
      journeys: [{
        journeyNum: 0,
        sectors: [{
          segments: [{
            origin: booking.origin,
            destination: booking.destination,
            flightNumber: booking.flightNumber,
            departureDateUTC: booking.departUTC,
          }],
        }],
      }],
    },
    linkedBookings: [{ id: 424242, pnr: "NOTYRS" }],
  };
}

/**
 * `GET /orders/v2/orders/{cid}` — what myRyanair itself lists. One item per trip,
 * with every booking of that trip in `flights`; the first trip carries seven, one
 * in the obvious shape and six in the unfamiliar one, so both paths are exercised.
 */
function generateTrips(pCount, uCount) {
  const items = generateBookings(pCount, uCount).map((booking, index) => ({
    tripId: `trip-${booking.id}`,
    startDate: booking.departUTC,
    endDate: booking.departUTC,
    flights: index === 0
      ? [tripBooking(booking), ...hiddenBookingsFor(booking).map(hiddenTripBooking)]
      : [tripBooking(booking)],
    cars: [],
    rooms: [],
    events: [],
    primeBooking: false,
  }));

  return { items };
}

/**
 * The pnr the listings handed out for this booking. A pass carries no booking id,
 * so the extension matches passes to flights by pnr: hand back a pnr that belongs
 * to some other booking and it looks like the pass never arrived.
 */
function pnrForBookingId(id) {
  const bookings = generateBookings(passesCount, upcomingCount);
  const all = bookings.length > 0 ? [...bookings, ...hiddenBookingsFor(bookings[0])] : [];
  const found = all.find((booking) => booking.id === id);
  return found ? found.pnr : `PASS${id - 1000 + 1}`;
}

/** Serves `all` one page at a time, the way Ryanair cursors both listings. */
function pageOf(all, token) {
  const offset = token ? decodeNextToken(token) : 0;
  const nextOffset = offset + ORDERS_PAGE_SIZE;

  const data = { items: all.slice(offset, nextOffset) };
  if (nextOffset < all.length) data.nextToken = encodeNextToken(nextOffset);

  return { data, offset, nextOffset };
}

const server = createServer(async (req, res) => {
  // ... CORS headers ...
  const origin = req.headers.origin;
  const requestHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", requestHeaders || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`${req.method} ${req.url} [Scenario: ${currentScenario}] (P:${passesCount}, U:${upcomingCount})`);

  // Scenario Dashboard
  if (req.url === "/" && req.method === "GET") {
    res.setHeader("Content-Type", "text/html");
    res.writeHead(200);
    res.end(`
      <html>
        <head><title>Ryanquack Mock Server</title></head>
        <body style="font-family: sans-serif; padding: 20px;">
          <h1>Mock Scenario Control</h1>
          <p>Current: <strong>${currentScenario}</strong></p>
          <div style="margin-bottom: 20px; border: 1px solid #ccc; padding: 10px;">
            <label>Passes Count: <input type="number" id="pCount" value="${passesCount}" style="width: 50px;"></label>
            <label>Upcoming Count: <input type="number" id="uCount" value="${upcomingCount}" style="width: 50px;"></label>
            <button onclick="updateCounts()">Update Counts</button>
            <p style="margin: 8px 0 0; font-size: 12px; color: #666;">
              Passes Count &ge; 2 includes a pass with no barcode.
              More than ${ORDERS_PAGE_SIZE} bookings in total are served in pages, so the extension has to follow nextToken.
              The first trip holds ${HIDDEN_BOOKINGS_PER_TRIP + 1} bookings on one flight, and only the first of them
              appears in /details — the rest exist solely in the trip listing, in a different shape from it.
            </p>
          </div>
          <div style="display: grid; gap: 10px; max-width: 300px;">
            <button onclick="set('LOGGED_OUT')">Logged Out (403)</button>
            <button onclick="set('NO_FLIGHTS')">No Flights (Empty)</button>
            <button onclick="set('MIXED')">Active (Uses Counts)</button>
            <button onclick="set('WALLET_ERROR')">Google Wallet Error (500)</button>
            <button onclick="set('WALLET_NO_TOKEN')">Google Wallet Missing Token</button>
            <button onclick="set('WALLET_DELAY')">Google Wallet Delayed (6 seconds)</button>
          </div>
          <script>
            function set(s) {
              postState({ scenario: s });
            }
            function updateCounts() {
              const p = parseInt(document.getElementById('pCount').value);
              const u = parseInt(document.getElementById('uCount').value);
              postState({ passesCount: p, upcomingCount: u, scenario: 'MIXED' });
            }
            function postState(data) {
              fetch('/test-server/scenario', {
                method: 'POST',
                body: JSON.stringify(data),
                headers: { 'Content-Type': 'application/json' }
              }).then(() => location.reload());
            }
          </script>
        </body>
      </html>
    `);
    return;
  }

  // Set Scenario
  if (req.url === "/test-server/scenario" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        if (payload.scenario) currentScenario = payload.scenario;
        if (payload.passesCount !== undefined) passesCount = payload.passesCount;
        if (payload.upcomingCount !== undefined) upcomingCount = payload.upcomingCount;
        res.writeHead(200);
        res.end();
      } catch (e) {
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }

  // Simulate 403 for Logged Out
  if (currentScenario === "LOGGED_OUT") {
    res.writeHead(403);
    res.end();
    return;
  }

  if (req.url === "/v1/boardingpass" && req.method === "PUT") {
    if (req.headers["client"] !== "android") {
      res.writeHead(403);
      res.end();
      return;
    }

    let requestBody = "";
    for await (const chunk of req) {
      requestBody += chunk;
    }

    try {
      const payload = JSON.parse(requestBody);
      const requiredFields = [
        "sequenceNumber",
        "lang",
        "arrivalStation",
        "departureStation",
        "recordLocator",
        "isInfant",
      ];
      if (requiredFields.some((field) => !(field in payload))) {
        res.writeHead(400);
        res.end("Invalid Google Wallet payload");
        return;
      }
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    if (currentScenario === "WALLET_ERROR") {
      res.writeHead(500);
      res.end("Google Wallet failed");
      return;
    }

    if (currentScenario === "WALLET_DELAY") {
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }

    const response = currentScenario === "WALLET_NO_TOKEN"
      ? {}
      : { Token: "mock-google-wallet-token" };
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(response));
    return;
  }

  if (req.url?.startsWith("/google-wallet/save/") && req.method === "GET") {
    const token = decodeURIComponent(req.url.slice("/google-wallet/save/".length));
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.writeHead(200);
    res.end(`Mock Google Wallet opened successfully.\nToken: ${token}\n`);
    return;
  }

  // Boarding Passes
  if (req.url === "/v1/boardingpasses" && req.method === "POST") {
    if (req.headers["client"] !== "ios") {
      res.writeHead(403); res.end(); return;
    }
    
    // If we are simulating "No Flights" or "Upcoming Only" (via counts),
    // the app logic should theoretically filter them out before calling this.
    // But if it does call this, we can return the mock passes data.
    // However, if we want to be strict:
    if (currentScenario === "NO_FLIGHTS") {
       res.writeHead(403); res.end(); return;
    }

    // Dynamic generation for boarding passes? 
    // The current 'boardingpasses.json' only has ONE pass.
    // To support multiple passes, we would need to generate this dynamically too.
    // For now, let's just return the static file but maybe duplicate the item if passesCount > 1?
    // Let's keep it simple: The app requests passes for SPECIFIC IDs.
    // If we return the static JSON, it might contain IDs that match or don't match.
    // Ideally, we should generate this response to match the 'bookingIds' in the request body.
    
    let requestBody = "";
    req.on("data", chunk => { requestBody += chunk; });
    req.on("end", async () => {
       try {
         const body = JSON.parse(requestBody);
         const requestedIds = body.bookingIds || [];
         
         // `barcode: null` reproduces a pass Ryanair has issued no scannable code for.
         // Mirrors the second entry in data/boardingpasses.json, which is only served
         // as the parse-failure fallback below. Second in the list so a Passes Count
         // of 2 is enough to see the state.
         const MOCK_PASSENGERS = [
           { first: "Ryan",  last: "Quack",    seat: "1A",  sequence: 1,  priority: true  },
           { first: "Sofia", last: "Lindqvist", seat: "12B", sequence: 11, priority: false, barcode: null },
           { first: "John",  last: "Smith",    seat: "14C", sequence: 42, priority: false },
           { first: "Maria", last: "Garcia",   seat: "7B",  sequence: 18, priority: true  },
           { first: "Ryan",  last: "O'Brien",  seat: "9D",  sequence: 27, priority: false },
           { first: "Liam",  last: "Murphy",   seat: "22F", sequence: 67, priority: false },
         ];

         // Generate passes for requested IDs
         const passes = requestedIds.map((id, i) => {
            const p = MOCK_PASSENGERS[i % MOCK_PASSENGERS.length];
            return {
              passId: `PASS_${id}`,
              pnr: pnrForBookingId(id),
              name: { first: p.first, last: p.last },
              barcode: p.barcode === null
                ? null
                : `M1${p.last.toUpperCase()}/${p.first.toUpperCase()} EABCDEF STUBDUB FR ${String(id).padStart(4,'0')} 0151A${p.seat.padStart(4,' ')}100`,
              departure: { code: "STN", name: "London Stansted", date: "2026-01-15T10:00:00" },
              arrival: { code: "DUB", name: "Dublin", date: "2026-01-15T11:15:00" },
              flight: { carrierCode: "FR", number: `${id}` },
              seat: { designator: p.seat },
              sequence: p.sequence,
              boardingTime: "2026-01-15T09:30:00",
              priority: p.priority,
              paxType: "ADT",
            };
         });

         passes.forEach((p) => {
           if (!p.barcode) barcodelessPasses.add(`${p.pnr}|${p.sequence}`);
         });

         res.setHeader("Content-Type", "application/json");
         res.writeHead(200);
         res.end(JSON.stringify(passes));
       } catch (e) {
         // Fallback to static file if parsing fails
         const data = await readFile(join(DATA_DIR, "boardingpasses.json"), "utf8");
         res.setHeader("Content-Type", "application/json");
         res.writeHead(200);
         res.end(data);
       }
    });
    return;
  }

  // Orders Details
  if (req.url.match(/^\/orders\/v2\/orders\/[^\/]+\/details/) && req.method === "GET") {
    if (req.headers["client"] !== "ios") {
      res.writeHead(403); res.end(); return;
    }

    if (currentScenario === "NO_FLIGHTS") {
       res.setHeader("Content-Type", "application/json");
       res.writeHead(200);
       res.end(JSON.stringify({ items: [] }));
       return;
    }

    // Dynamic Generation, served one page at a time so the client has to follow
    // nextToken to see every booking.
    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const all = generateOrders(passesCount, upcomingCount).items;
    const { data, offset, nextOffset } = pageOf(all, query.get("nextToken"));

    console.log(`  -> orders ${offset}-${Math.min(nextOffset, all.length)} of ${all.length}${data.nextToken ? " (more)" : ""}`);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(data));
    return;
  }

  // Trip listing. Declared after the details route so it cannot shadow it: the
  // pattern stops at the id, where a `?` or the end of the url must follow.
  if (req.url.match(/^\/orders\/v2\/orders\/[^\/?]+(\?|$)/) && req.method === "GET") {
    if (req.headers["client"] !== "ios") {
      res.writeHead(403); res.end(); return;
    }

    if (currentScenario === "NO_FLIGHTS") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ items: [] }));
      return;
    }

    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const all = generateTrips(passesCount, upcomingCount).items;
    const { data, offset, nextOffset } = pageOf(all, query.get("nextToken"));

    const bookings = data.items.reduce((total, trip) => total + trip.flights.length, 0);
    console.log(`  -> trips ${offset}-${Math.min(nextOffset, all.length)} of ${all.length} (${bookings} bookings)${data.nextToken ? " (more)" : ""}`);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(data));
    return;
  }

  // Download Pass
  if (req.url === "/v1/downloadpass" && req.method === "POST") {
    if (req.headers["client"] !== "ios") {
      res.writeHead(403); res.end(); return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      // A pass with no barcode has no wallet file behind it. 422 is the guess at
      // what Ryanair answers here; the extension should not be asking at all.
      try {
        const payload = JSON.parse(body);
        if (barcodelessPasses.has(`${payload.recordLocator}|${payload.sequenceNumber}`)) {
          console.log(`  -> 422: no barcode for ${payload.recordLocator}/${payload.sequenceNumber}`);
          res.writeHead(422);
          res.end();
          return;
        }
      } catch (e) {
        // Fall through to the normal response.
      }

      res.setHeader("Content-Type", "application/vnd.apple.pkpass");
      res.writeHead(200);
      res.end("DUMMY_PKPASS_DATA");
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Test server running at http://localhost:${PORT}`);
});
