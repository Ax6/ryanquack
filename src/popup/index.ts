/**
 * RyanQuack - Ryanair Boarding Pass Helper
 * Copyright (C) 2026 Aaron Russo
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
import bwipjs from "bwip-js";
import browser from "webextension-polyfill";
import { downloadPass } from "../lib/api";
import { buildZip } from "../lib/zip";
import "./popup.css";

const statusEl = document.getElementById("status") as HTMLElement;
const passesEl = document.getElementById("passes") as HTMLElement;
const bulkActionsEl = document.getElementById("bulk-actions") as HTMLElement;
const searchBarEl = document.getElementById("search-bar") as HTMLElement;

const SEARCH_MIN_PASSES = 4;

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
  "Top quack! 🦆",
  "Mighty quack!",
  "Quackity quack!",
  "Splash! 🦆",
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
            btnCopy.textContent = getRandomQuack();
            setStatus("Copied to clipboard! 📋");
            setTimeout(() => { btnCopy.textContent = original; }, 2000);
          } catch (err) {
            console.error("Clipboard write failed", err);
            setStatus("Copy failed 🦆");
          }
        } else {
          try {
            const url = URL.createObjectURL(blob);
            await browser.downloads.download({
              url,
              filename: buildPassFilename(pass, "png"),
              saveAs: false
            });
            // Give some time for the download to start before revoking
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            const original = btnSave.textContent;
            btnSave.textContent = getRandomQuack();
            setStatus("Image saved! 🖼️");
            setTimeout(() => { btnSave.textContent = original; }, 2000);
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

function buildPassBaseName(pass): string {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const first = normalize(pass.name.first);
  const last = normalize(pass.name.last);
  const seat = pass.seat.designator.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${first}_${last}_${seat}`;
}

function buildPassFilename(pass, ext: string): string {
  return `${buildPassBaseName(pass)}.${ext}`;
}


async function downloadWalletPass(payload, pass) {
  const blob = await downloadPass(payload, API_DOWNLOAD_PASS_URL);
  const url = URL.createObjectURL(blob);
  await browser.downloads.download({
    url,
    filename: buildPassFilename(pass, "pkpass"),
    saveAs: false,
  });
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const passActions = [
  {
    id: "apple",
    label: "Download Apple Wallet Pass",
    handler: async (payload, pass) => {
      await downloadWalletPass(payload, pass);
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

async function downloadAllPasses(passes, payloads) {
  const btn = document.getElementById("btn-download-all") as HTMLButtonElement;
  const originalLabel = btn?.textContent ?? "Download All Passes";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Downloading...";
  }
  setStatus("Preparing passes...");
  try {
    const fileEntries = await Promise.all(
      passes.map(async (pass, i) => {
        const base = buildPassBaseName(pass);
        const [pkpassBlob, canvas] = await Promise.all([
          downloadPass(payloads[i], API_DOWNLOAD_PASS_URL),
          drawTicketToCanvas(pass),
        ]);
        const pngBlob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(b => b ? resolve(b) : reject(new Error("Canvas export failed")), "image/png")
        );
        return [
          { name: `${base}.pkpass`, data: new Uint8Array(await pkpassBlob.arrayBuffer()) },
          { name: `${base}.png`,    data: new Uint8Array(await pngBlob.arrayBuffer()) },
        ];
      })
    );

    const zip = buildZip(fileEntries.flat());
    const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    await browser.downloads.download({ url, filename: "passes.zip", saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Downloaded ${passes.length} passes! ✅`);
  } catch (error) {
    setStatus(`Download failed: ${error.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

function renderSearchBar(passes) {
  searchBarEl.innerHTML = "";
  if (passes.length < SEARCH_MIN_PASSES) return;

  const input = document.createElement("input");
  input.type = "search";
  input.className = "search-input";
  input.placeholder = "Search by name or reference...";
  input.autocomplete = "off";
  input.spellcheck = false;

  const emptyHint = document.createElement("div");
  emptyHint.className = "search-empty";
  emptyHint.textContent = "No passes match your search 🦆";
  emptyHint.style.display = "none";

  const autoOpened = new Set<HTMLButtonElement>();

  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const rows = passesEl.querySelectorAll<HTMLElement>(".pass");
    const visible: HTMLElement[] = [];

    rows.forEach((row) => {
      const haystack = row.dataset.search || "";
      const match = tokens.length === 0 || tokens.every((t) => haystack.includes(t));
      row.style.display = match ? "" : "none";
      if (match) visible.push(row);
    });

    emptyHint.style.display = query !== "" && visible.length === 0 ? "" : "none";

    const bulkBtn = document.getElementById("btn-download-all");
    if (bulkBtn) {
      bulkBtn.textContent = query === ""
        ? "Download All Passes"
        : `Download Results (${visible.length})`;
      (bulkBtn as HTMLButtonElement).disabled = visible.length === 0;
    }

    const isSingleMatch = query !== "" && visible.length === 1;

    if (isSingleMatch) {
      const showBtn = visible[0].querySelector<HTMLButtonElement>(
        'button[data-action="qr"]'
      );
      if (showBtn && showBtn.textContent === "Show Ticket") {
        autoOpened.add(showBtn);
        showBtn.click();
      }
    } else {
      autoOpened.forEach((btn) => {
        if (btn.textContent === "Hide Ticket") {
          btn.click();
        }
      });
      autoOpened.clear();
    }
  });

  searchBarEl.appendChild(input);
  searchBarEl.appendChild(emptyHint);
}

function renderBulkActions(passes, payloads) {
  bulkActionsEl.innerHTML = "";
  if (passes.length <= 1) return;

  const btn = document.createElement("button");
  btn.id = "btn-download-all";
  btn.className = "btn-download-all";
  btn.textContent = "Download All Passes";
  btn.addEventListener("click", () => {
    const indices = Array.from(passesEl.querySelectorAll<HTMLElement>(".pass"))
      .filter((row) => row.style.display !== "none")
      .map((row) => Number(row.dataset.index))
      .filter((i) => !Number.isNaN(i));
    const selectedPasses = indices.map((i) => passes[i]);
    const selectedPayloads = indices.map((i) => payloads[i]);
    downloadAllPasses(selectedPasses, selectedPayloads);
  });
  bulkActionsEl.appendChild(btn);
}

function buildPassTitle(pass) {
  return `${pass.pnr} · ${pass.departure.code} → ${pass.arrival.code} · ${pass.name.first} ${pass.name.last}`;
}

function buildPassSearchHaystack(pass): string {
  return [
    pass.pnr,
    pass.name.first,
    pass.name.last,
    pass.departure.code,
    pass.arrival.code,
    pass.flight.carrierCode,
    pass.flight.number,
  ].join(" ").toLowerCase();
}

function renderPasses(passes, payloads) {
  passes.forEach((pass, index) => {
    const payload = payloads[index];
    const row = document.createElement("div");
    row.className = "pass";
    row.dataset.search = buildPassSearchHaystack(pass);
    row.dataset.index = String(index);

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
      button.dataset.action = action.id;
      button.addEventListener("click", async () => {
        // Toggle logic for "Show Ticket"
        if (action.id === "qr") {
          const isShowing = button.textContent === "Hide Ticket";
          if (isShowing) {
            outputBox.innerHTML = "";
            button.textContent = action.label;
            return;
          }

          try {
            renderTicketDetails(outputBox, pass);
            button.textContent = "Hide Ticket";
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
    
    if (flight.checkinStatus === "nocheckin") {
      const now = new Date();
      const open = flight.checkInOpenUTC ? new Date(flight.checkInOpenUTC) : null;
      const close = flight.checkInCloseUTC ? new Date(flight.checkInCloseUTC) : null;

      if (open && now >= open && (!close || now <= close)) {
        meta.textContent = "Check-in open";
      } else {
        meta.textContent = "Check-in not open";
      }
    } else {
      meta.textContent = flight.checkinStatus;
    }
    
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

  // 1. Read cache up front (used for optimistic pre-load AND as offline fallback)
  let cachedData: { passes: any[]; downloadPayloads: any[]; flights: any[]; cachedAt?: number } | null = null;
  try {
    const cache = await browser.storage.local.get("cachedPasses");
    if (cache && cache.cachedPasses) {
      cachedData = cache.cachedPasses;
    }
  } catch (e) {
    console.error("Cache read error", e);
  }

  // 2. Optimistic pre-load: only show cache if within TTL
  if (cachedData) {
    const isFresh = cachedData.cachedAt && (Date.now() - cachedData.cachedAt) < CACHE_TTL_MS;
    if (isFresh) {
      passesEl.innerHTML = "";
      bulkActionsEl.innerHTML = "";
      searchBarEl.innerHTML = "";

      if (cachedData.passes.length > 0) {
        renderPasses(cachedData.passes, cachedData.downloadPayloads);
        renderBulkActions(cachedData.passes, cachedData.downloadPayloads);
        renderSearchBar(cachedData.passes);
      }
      const upcoming = cachedData.flights.filter(f => !f.isReady);
      if (upcoming.length > 0) {
        renderFlights(upcoming);
      }

      setStatus("Offline Mode ☁️");
    }
  }

  // 3. Network Fetch (always)
  try {
    const res = (await browser.runtime.sendMessage({
      type: "RYQ_FETCH_BOARDING_PASSES",
    })) as any;

    const passes = res && res.passes ? res.passes : [];
    const payloads = res && res.downloadPayloads ? res.downloadPayloads : [];
    const flights = res && res.flights ? res.flights : [];

    passesEl.innerHTML = "";
    bulkActionsEl.innerHTML = "";
    searchBarEl.innerHTML = "";

    if (passes.length > 0) {
      renderPasses(passes, payloads);
      renderBulkActions(passes, payloads);
      renderSearchBar(passes);
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
      setStatus("Nothing to quack.");
    } else if (cachedData) {
      // Network failed but we have a cache — render it regardless of TTL
      if (passesEl.innerHTML === "") {
        passesEl.innerHTML = "";
        bulkActionsEl.innerHTML = "";
        searchBarEl.innerHTML = "";

        if (cachedData.passes.length > 0) {
          renderPasses(cachedData.passes, cachedData.downloadPayloads);
          renderBulkActions(cachedData.passes, cachedData.downloadPayloads);
          renderSearchBar(cachedData.passes);
        }
        const upcoming = cachedData.flights.filter(f => !f.isReady);
        if (upcoming.length > 0) {
          renderFlights(upcoming);
        }
      }
      setStatus("Offline (Cached) ☁️");
    } else {
      setStatus(`Error: ${msg}`);
    }
  }
}

fetchPasses();
