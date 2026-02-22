import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PORT = 3000;
const DATA_DIR = new URL("data", import.meta.url).pathname;

let currentScenario = "MIXED";
let passesCount = 1;
let upcomingCount = 1;

function generateOrders(pCount, uCount) {
  const items = [];
  let idCounter = 1000;

  // Generate Passes (Checked In)
  for (let i = 0; i < pCount; i++) {
    const id = idCounter++;
    items.push({
      tripId: `trip-${id}`,
      productId: String(id),
      type: "flight",
      payload: { booking: { bookingId: id, pnr: `PASS${i+1}` } },
      rawBooking: {
        bookingId: id,
        recordLocator: `PASS${i+1}`,
        flights: [{ journeyNum: 0, origin: "STN", destination: "DUB", flightNumber: `FR${id}`, times: { departUTC: "2026-01-15T10:00:00Z" } }],
        checkins: [{ journeyNum: 0, status: "checkedin" }]
      }
    });
  }

  // Generate Upcoming (No Checkin)
  for (let i = 0; i < uCount; i++) {
    const id = idCounter++;
    items.push({
      tripId: `trip-${id}`,
      productId: String(id),
      type: "flight",
      payload: { booking: { bookingId: id, pnr: `NEXT${i+1}` } },
      rawBooking: {
        bookingId: id,
        recordLocator: `NEXT${i+1}`,
        flights: [{ journeyNum: 0, origin: "DUB", destination: "BER", flightNumber: `FR${id}`, times: { departUTC: "2026-05-20T10:00:00Z" } }],
        checkins: [{ journeyNum: 0, status: "nocheckin" }]
      }
    });
  }

  return { items };
}

const server = createServer(async (req, res) => {
  // ... CORS headers ...
  const origin = req.headers.origin;
  const requestHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
          </div>
          <div style="display: grid; gap: 10px; max-width: 300px;">
            <button onclick="set('LOGGED_OUT')">Logged Out (403)</button>
            <button onclick="set('NO_FLIGHTS')">No Flights (Empty)</button>
            <button onclick="set('MIXED')">Active (Uses Counts)</button>
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
         
         const MOCK_PASSENGERS = [
           { first: "Ryan",  last: "Quack",   seat: "1A",  sequence: 1,  priority: true  },
           { first: "John",  last: "Smith",   seat: "14C", sequence: 42, priority: false },
           { first: "Maria", last: "Garcia",  seat: "7B",  sequence: 18, priority: true  },
           { first: "Liam",  last: "Murphy",  seat: "22F", sequence: 67, priority: false },
         ];

         // Generate passes for requested IDs
         const passes = requestedIds.map((id, i) => {
            const p = MOCK_PASSENGERS[i % MOCK_PASSENGERS.length];
            return {
              passId: `PASS_${id}`,
              pnr: `PASS${id-1000+1}`,
              name: { first: p.first, last: p.last },
              barcode: `M1${p.last.toUpperCase()}/${p.first.toUpperCase()} EABCDEF STUBDUB FR ${String(id).padStart(4,'0')} 0151A${p.seat.padStart(4,' ')}100`,
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

    // Dynamic Generation
    const data = generateOrders(passesCount, upcomingCount);
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
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.writeHead(200);
    res.end("DUMMY_PKPASS_DATA");
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Test server running at http://localhost:${PORT}`);
});
