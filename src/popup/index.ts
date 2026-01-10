import bwipjs from "bwip-js";
import browser from "webextension-polyfill";
import "./popup.css";

const statusEl = document.getElementById("status") as HTMLElement;
const passesEl = document.getElementById("passes") as HTMLElement;

function ensureBcMath() {
  if (typeof window.bcadd === "function") {
    return;
  }

  const toBigInt = (value) => BigInt(String(value));

  window.bcadd = (left, right) => String(toBigInt(left) + toBigInt(right));
  window.bcmul = (left, right) => String(toBigInt(left) * toBigInt(right));
  window.bcdiv = (left, right) => String(toBigInt(left) / toBigInt(right));
}

ensureBcMath();

function setStatus(text) {
  statusEl.textContent = text;
}

const QUACKS = [
  "Quack!", 
  "Quack quack! 🦆", 
  "Honk!", 
  "Waddle waddle...",
  "Quacking..."
];

const READY_QUACK = "Ready to quack...";

function getRandomQuack() {
  return QUACKS[Math.floor(Math.random() * QUACKS.length)];
}

async function drawTicketToCanvas(pass): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context not supported");

  // Logical dimensions
  const width = 500;
  const height = 740;
  
  // High-resolution scaling (3x)
  const resScale = 3;
  canvas.width = width * resScale;
  canvas.height = height * resScale;
  
  // Ensure all subsequent drawing is scaled up
  ctx.scale(resScale, resScale);

  // Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // Styles
  ctx.fillStyle = "#000000";
  ctx.font = "bold 24px sans-serif";
  ctx.textAlign = "center";

  // Header (Route)
  ctx.fillText(`${pass.departure.code} ✈ ${pass.arrival.code}`, width / 2, 50);

  // Line
  ctx.strokeStyle = "#eeeeee";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(40, 70);
  ctx.lineTo(width - 40, 70);
  ctx.stroke();

  // Helper to draw label/value pairs
  const drawField = (label, value, x, y, align = "left") => {
    ctx.textAlign = align;
    
    ctx.font = "normal 14px sans-serif";
    ctx.fillStyle = "#666666";
    ctx.fillText(label.toUpperCase(), x, y);

    ctx.font = "bold 20px sans-serif";
    ctx.fillStyle = "#000000";
    ctx.fillText(value, x, y + 25);
  };

  // Row 1: Passenger
  drawField("Passenger", `${pass.name.first} ${pass.name.last}`, 40, 110, "left");
  
  // Row 2: Flight / Date
  drawField("Flight", `${pass.flight.carrierCode} ${pass.flight.number}`, 40, 180, "left");
  const flightDate = new Date(pass.departure.date);
  drawField("Date", flightDate.toLocaleDateString("en-GB", { day: '2-digit', month: 'short' }), width - 40, 180, "right");

  // Row 3: Seat / Seq
  drawField("Seat", pass.seat.designator, 40, 250, "left");
  drawField("Seq", String(pass.sequence), width - 40, 250, "right");

  // Row 4: Boarding
  const timeStr = new Date(pass.boardingTime).toLocaleTimeString("en-GB", { hour: '2-digit', minute: '2-digit' });
  drawField("Boarding", timeStr, width / 2, 250, "center");

  // Priority
  if (pass.priority) {
    ctx.textAlign = "center";
    ctx.font = "bold 18px sans-serif";
    ctx.fillStyle = "#073590";
    ctx.fillText("PRIORITY BOARDING ⚡", width / 2, 320);
  }

  // Aztec Code (Draw onto this canvas)
  // We use a temporary canvas for bwip-js to render to, then draw that image here
  const aztecCanvas = document.createElement("canvas");
  try {
    bwipjs.toCanvas(aztecCanvas, {
      bcid: "azteccode",
      text: pass.barcode,
      scale: 4, // Higher scale for the large image
      backgroundcolor: "ffffff",
      includetext: false
    });
    
    // Center the Aztec code
    const aztecSize = 300;
    const x = (width - aztecSize) / 2;
    const y = 350;
    ctx.drawImage(aztecCanvas, x, y, aztecSize, aztecSize);
  } catch (e) {
    console.error("Failed to draw Aztec on image", e);
  }

  // RyanQuack Branding
  ctx.font = "italic 14px sans-serif";
  ctx.fillStyle = "#999999";
  ctx.textAlign = "center";
  ctx.fillText("Generated with RyanQuack 🦆", width / 2, height - 30);

  return canvas;
}

function renderTicketDetails(container, pass) {
  container.innerHTML = "";
  
  const flightDate = new Date(pass.departure.date);
  const dateStr = flightDate.toLocaleDateString("en-GB", { day: '2-digit', month: 'short' });
  const timeStr = new Date(pass.boardingTime).toLocaleTimeString("en-GB", { hour: '2-digit', minute: '2-digit' });

  const html = `
    <div class="ticket-actions">
      <button id="btn-copy">Copy Image</button>
      <button id="btn-save">Save Image</button>
    </div>

    <div class="ticket-detail">
      <div class="ticket-route">
        ${pass.departure.code} <span style="color:#666">✈</span> ${pass.arrival.code}
      </div>
      
      <div class="ticket-section">
        <div>
          <div class="ticket-label">Passenger</div>
          <div class="ticket-value">${pass.name.first} ${pass.name.last}</div>
        </div>
        <div style="text-align: right">
          <div class="ticket-label">Flight</div>
          <div class="ticket-value">${pass.flight.carrierCode} ${pass.flight.number}</div>
        </div>
      </div>

      <div class="ticket-section">
        <div>
          <div class="ticket-label">Date</div>
          <div class="ticket-value">${dateStr}</div>
        </div>
        <div style="text-align: right">
          <div class="ticket-label">Boarding</div>
          <div class="ticket-value">${timeStr}</div>
        </div>
      </div>

      <div class="ticket-section">
        <div>
          <div class="ticket-label">Seat</div>
          <div class="ticket-value" style="font-size: 1.2em">${pass.seat.designator}</div>
        </div>
        <div style="text-align: right">
          <div class="ticket-label">Seq</div>
          <div class="ticket-value">${pass.sequence}</div>
        </div>
      </div>
      
      <div style="text-align: center; margin-top: 8px;">
        <span class="ticket-label">Priority: </span>
        <span class="ticket-value">${pass.priority ? "YES ⚡" : "No"}</span>
      </div>
    </div>

    <div class="aztec-canvas"></div>
  `;

  container.innerHTML = html;
  
  // Handlers for the new buttons
  const btnCopy = container.querySelector("#btn-copy");
  const btnSave = container.querySelector("#btn-save");

  const handleExport = async (action) => {
    try {
      const canvas = await drawTicketToCanvas(pass);
      
      canvas.toBlob(async (blob) => {
        if (!blob) {
          setStatus("Export failed 🦆");
          return;
        }

        if (action === "copy") {
          try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            const original = btnCopy.textContent;
            btnCopy.textContent = "Copied! ✅";
            setTimeout(() => { btnCopy.textContent = original; }, 2000);
            setStatus("Copied to clipboard! 📋");
          } catch (err) {
            console.error("Clipboard write failed", err);
            setStatus("Copy failed 🦆");
          }
        } else {
          try {
            const url = URL.createObjectURL(blob);
            await browser.downloads.download({
              url,
              filename: `ryanair-pass-${pass.pnr}.png`,
              saveAs: false
            });
            // Give some time for the download to start before revoking
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            
            const original = btnSave.textContent;
            btnSave.textContent = "Saved! ✅";
            setTimeout(() => { btnSave.textContent = original; }, 2000);
            setStatus("Image saved! 🖼️");
          } catch (err) {
            console.error("Download failed", err);
            setStatus("Save failed 🦆");
          }
        }
      }, "image/png");
    } catch (err) {
      console.error(err);
      setStatus("Export failed 🦆");
    }
  };

  btnCopy.addEventListener("click", () => handleExport("copy"));
  btnSave.addEventListener("click", () => handleExport("save"));

  const canvasContainer = container.querySelector(".aztec-canvas");
  const canvas = document.createElement("canvas");
  
  bwipjs.toCanvas(canvas, {
    bcid: "azteccode",
    text: pass.barcode,
    scale: 3,
    backgroundcolor: "ffffff",
    includetext: false
  });

  canvasContainer.appendChild(canvas);
}

function renderAztec(container, text) {
  if (!text) {
    container.textContent = "No barcode available.";
    return;
  }

  const canvas = document.createElement("canvas");
  bwipjs.toCanvas(canvas, {
    bcid: "azteccode",
    text,
    scale: 3,
    backgroundcolor: "ffffff",
    includetext: false
  });

  container.innerHTML = "";
  container.appendChild(canvas);
}

const passActions = [
  {
    id: "apple",
    label: "Download Apple Wallet Pass",
    handler: async (payload) => {
      await browser.runtime.sendMessage({
        type: "RYQ_DOWNLOAD_PASS",
        payload
      });
    }
  },
  {
    id: "qr",
    label: "Show Ticket",
    handler: async (_payload, pass, elements) => {
      renderAztec(elements.outputBox, pass.barcode);
      elements.outputBox.classList.remove("pass-barcode");
    }
  }
];

function buildPassTitle(pass) {
  return `${pass.pnr} · ${pass.departure.code} → ${pass.arrival.code} · ${pass.name.first} ${pass.name.last}`;
}

function renderPasses(passes, payloads) {
  passes.forEach((pass, index) => {
    const payload = payloads[index];
    const row = document.createElement("div");
    row.className = "pass";

    const header = document.createElement("div");
    header.className = "pass-header";

    const title = document.createElement("div");
    title.className = "pass-title";
    title.textContent = buildPassTitle(pass);

    header.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "pass-actions";

    const outputBox = document.createElement("div");
    outputBox.className = "pass-qr";

    passActions.forEach((action) => {
      const button = document.createElement("button");
      button.textContent = action.label;
      button.addEventListener("click", async () => {
        // Toggle logic for "Show Ticket"
        if (action.id === "qr") {
          const isShowing = button.textContent === "Hide Ticket";
          if (isShowing) {
            outputBox.innerHTML = "";
            button.textContent = action.label;
            return;
          }
          
          button.textContent = "Quack! 🦆";
          // Render immediately
          try {
            renderTicketDetails(outputBox, pass);
            setStatus(getRandomQuack());
            
            // Wait 1s while showing "Quack!" label
            await new Promise(resolve => setTimeout(resolve, 1000));
            button.textContent = "Hide Ticket";
            setStatus(READY_QUACK);
          } catch (error) {
            setStatus(`Error: ${error.message}`);
            button.textContent = action.label;
          }
          return;
        }

        // Other actions (Download)
        button.disabled = true;
        setStatus("Grabbing pass...");
        try {
          await action.handler(payload, pass, { outputBox });
          setStatus(READY_QUACK);
        } catch (error) {
          setStatus(`Error: ${error.message}`);
        } finally {
          button.disabled = false;
        }
      });
      actions.appendChild(button);
    });

    row.appendChild(header);
    row.appendChild(actions);
    row.appendChild(outputBox);
    passesEl.appendChild(row);
  });
}

function renderFlights(flights) {
  flights.forEach((flight) => {
    const row = document.createElement("div");
    row.className = "flight-summary"; 

    const header = document.createElement("div");
    header.className = "pass-header";

    const title = document.createElement("div");
    title.className = "pass-title";
    title.textContent = `${flight.pnr} · ${flight.origin} → ${flight.destination}`;

    header.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "pass-meta";
    meta.style.marginTop = "2px";
    meta.textContent = flight.checkinStatus === "nocheckin" ? "Check-in not open" : flight.checkinStatus;
    
    const details = document.createElement("div");
    details.style.fontSize = "11px";
    details.style.marginTop = "4px";
    const flightDate = new Date(flight.date);
    const dateStr = flightDate.toLocaleDateString("en-GB");
    const timeStr = flightDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    details.textContent = `${flight.flightNumber} · ${dateStr} ${timeStr}`;

    row.appendChild(header);
    row.appendChild(meta);
    row.appendChild(details);
    passesEl.appendChild(row);
  });
}

async function fetchPasses() {
  setStatus("Paddling to Ryanair...");

  // 1. Try Cache First (Offline Mode)
  try {
    const cache = await browser.storage.local.get("cachedPasses");
    if (cache && cache.cachedPasses) {
      const { passes, downloadPayloads, flights } = cache.cachedPasses;
      
      // Clear before rendering cache
      passesEl.innerHTML = "";
      
      if (passes.length > 0) {
        renderPasses(passes, downloadPayloads);
      }
      const upcoming = flights.filter(f => !f.isReady);
      if (upcoming.length > 0) {
        renderFlights(upcoming);
      }
      
      setStatus("Offline Mode ☁️");
    }
  } catch (e) {
    console.error("Cache read error", e);
  }

  // 2. Network Fetch
  try {
    const res = (await browser.runtime.sendMessage({
      type: "RYQ_FETCH_BOARDING_PASSES",
    })) as any;
    
    const passes = res && res.passes ? res.passes : [];
    const payloads = res && res.downloadPayloads ? res.downloadPayloads : [];
    const flights = res && res.flights ? res.flights : [];

    passesEl.innerHTML = "";

    if (passes.length > 0) {
      renderPasses(passes, payloads);
    }

    const upcoming = flights.filter(f => !f.isReady);
    if (upcoming.length > 0) {
      renderFlights(upcoming);
    }

    if (passes.length === 0 && upcoming.length === 0) {
      setStatus("Nothing to quack.");
    } else if (passes.length > 0) {
      setStatus(READY_QUACK);
    } else {
      setStatus("Too early to fly! 🐣  No tickets found, they will appear once you check-in.");
    }

  } catch (error) {
    const msg = error.message;
    if (msg.includes("LOGIN_REQUIRED")) {
      setStatus("Please log in to Ryanair.com 🔒");
    } else if (msg.includes("NO_PASSES")) {
      // This case is largely handled by the flight check above, but as a fallback:
      setStatus("Nothing to quack.");
    } else {
      // If we have content (cached), show a friendly offline message instead of the error
      if (passesEl.innerHTML !== "") {
        setStatus("Offline (Cached) ☁️");
      } else {
        setStatus(`Error: ${msg}`);
      }
    }
  }
}

fetchPasses();
