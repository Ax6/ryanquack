import { createServer } from "node:http";
import { customAccount, reporterAccount, reporterPasses, reporterTally } from "./reporter.mjs";

const PORT = 3000;

let currentScenario = "REPORTER";
// "recordLocator|sequenceNumber" of every pass handed out without a barcode, so
// /v1/downloadpass can answer the way a real backend plausibly would.
const barcodelessPasses = new Set();
/** Adds one item Ryanair failed to load the booking for, to exercise the fallback. */
let withFailure = false;
/** Adds a booking whose outbound is checked in and whose return only has documents added. */
let withMixed = false;
/** Hands the second pass out without a barcode, the state the popup has to guard. */
let barcodeless = false;
/** The CUSTOM scenario: so many checked-in bookings, so many upcoming, one passenger each. */
let passesCount = 1;
let upcomingCount = 1;

// Ryanair pages `/details` at 25; the reporter's account came back as 25,25,25,25,25,3.
const ORDERS_PAGE_SIZE = 25;

/** Opaque cursor, like the real one: it only has to survive a round trip. */
function encodeNextToken(offset) {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64");
}

function decodeNextToken(token) {
  const offset = Number.parseInt(Buffer.from(token, "base64").toString("utf8").replace("offset:", ""), 10);
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

/**
 * The account is rebuilt per request from the clock, so the flown leg stays in
 * the past and tomorrow's seven bookings stay tomorrow however long the server runs.
 */
function account() {
  if (currentScenario === "CUSTOM") return customAccount({ passes: passesCount, upcoming: upcomingCount });
  return reporterAccount({ withFailure, withMixed });
}

/** Serves `all` one page at a time, the way Ryanair cursors the listing. */
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

  console.log(`${req.method} ${req.url} [Scenario: ${currentScenario}]${currentScenario === "CUSTOM" ? ` (P:${passesCount}, U:${upcomingCount})` : ""}${withFailure ? " +failure" : ""}${withMixed ? " +mixed" : ""}${barcodeless ? " +barcodeless" : ""}`);

  // Scenario Dashboard
  if (req.url === "/" && req.method === "GET") {
    const tally = reporterTally(account());
    res.setHeader("Content-Type", "text/html");
    res.writeHead(200);
    res.end(`
      <html>
        <head><title>Ryanquack Mock Server</title></head>
        <body style="font-family: sans-serif; padding: 20px;">
          <h1>Mock Scenario Control</h1>
          <p>Current: <strong>${currentScenario}</strong></p>
          <div style="margin-bottom: 20px; border: 1px solid #ccc; padding: 10px; max-width: 520px;">
            <p style="margin: 0 0 8px;"><strong>The issue #20 account</strong>, rebuilt from the reporter's diagnostic report:
            ${tally.bookings} bookings, ${tally.legs} legs (${tally.twoLeg} returns), served in pages of ${ORDERS_PAGE_SIZE}.
            Check-in records: ${Object.entries(tally.checkins).map(([k, v]) => `${k} ${v}`).join(", ")}.
            Seven bookings share flight FR2372 tomorrow morning, six with documents added.
            One booking is checked in with two passes; one leg flew yesterday.</p>
            <label><input type="checkbox" id="failure" ${withFailure ? "checked" : ""} onchange="postState({ withFailure: this.checked })">
              Add an item Ryanair failed to load the booking for (payload only)</label><br>
            <label><input type="checkbox" id="barcodeless" ${barcodeless ? "checked" : ""} onchange="postState({ barcodeless: this.checked })">
              Hand the second pass out without a barcode</label><br>
            <label><input type="checkbox" id="mixed" ${withMixed ? "checked" : ""} onchange="postState({ withMixed: this.checked })">
              Add a booking checked in for the outbound only, with documents added for the return</label>
          </div>
          <div style="margin-bottom: 20px; border: 1px solid #ccc; padding: 10px; max-width: 520px;">
            <p style="margin: 0 0 8px;"><strong>Tickets control.</strong> A plain account with as many checked-in and upcoming bookings as you like, one passenger each.</p>
            <label>Passes: <input type="number" id="pCount" value="${passesCount}" min="0" style="width: 60px;"></label>
            <label>Upcoming: <input type="number" id="uCount" value="${upcomingCount}" min="0" style="width: 60px;"></label>
            <button onclick="updateCounts()">Use these counts</button>
          </div>
          <div style="display: grid; gap: 10px; max-width: 300px;">
            <button onclick="set('REPORTER')">The reporter's account</button>
            <button onclick="set('CUSTOM')">Tickets control (uses counts)</button>
            <button onclick="set('LOGGED_OUT')">Logged Out (403)</button>
            <button onclick="set('NO_FLIGHTS')">No Flights (Empty)</button>
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
              postState({ passesCount: p, upcomingCount: u, scenario: 'CUSTOM' });
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
        if (payload.withFailure !== undefined) withFailure = Boolean(payload.withFailure);
        if (payload.withMixed !== undefined) withMixed = Boolean(payload.withMixed);
        if (payload.barcodeless !== undefined) barcodeless = Boolean(payload.barcodeless);
        if (Number.isInteger(payload.passesCount)) passesCount = Math.max(0, payload.passesCount);
        if (Number.isInteger(payload.upcomingCount)) upcomingCount = Math.max(0, payload.upcomingCount);
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

  // Boarding Passes: one per passenger who has checked in on the requested
  // bookings, nothing for the rest — which is what a real account answered for
  // 13 requested bookings (2 passes).
  if (req.url === "/v1/boardingpasses" && req.method === "POST") {
    if (req.headers["client"] !== "ios") {
      res.writeHead(403); res.end(); return;
    }

    if (currentScenario === "NO_FLIGHTS") {
      res.writeHead(403); res.end(); return;
    }

    let requestBody = "";
    for await (const chunk of req) {
      requestBody += chunk;
    }

    let requestedIds = [];
    try {
      requestedIds = JSON.parse(requestBody).bookingIds ?? [];
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    const passes = reporterPasses(account(), requestedIds);
    if (barcodeless && passes[1]) passes[1].barcode = null;
    passes.forEach((p) => {
      if (!p.barcode) barcodelessPasses.add(`${p.pnr}|${p.sequence}`);
    });

    console.log(`  -> ${passes.length} passes for ${requestedIds.length} requested bookings`);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(passes));
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

    // Served one page at a time so the client has to follow nextToken to see
    // every booking.
    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const all = account().items;
    const { data, offset, nextOffset } = pageOf(all, query.get("nextToken"));

    console.log(`  -> orders ${offset}-${Math.min(nextOffset, all.length)} of ${all.length}${data.nextToken ? " (more)" : ""}`);
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
