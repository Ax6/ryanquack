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
import { downloadPass, fetchGoogleWalletToken } from "../lib/api";
import { mapWithConcurrency, retry } from "../lib/concurrency";
import { errorStatus, errorText } from "../lib/errors";
import { buildPassBaseName, buildPassFilename } from "../lib/ryanair";
import { buildZip } from "../lib/zip";
import "./popup.css";

const statusEl = document.getElementById("status") as HTMLElement;
const passesEl = document.getElementById("passes") as HTMLElement;
const bulkActionsEl = document.getElementById("bulk-actions") as HTMLElement;
const searchBarEl = document.getElementById("search-bar") as HTMLElement;
const progressEl = document.getElementById("progress") as HTMLElement;
const progressFillEl = document.getElementById("progress-fill") as HTMLElement;
const failuresEl = document.getElementById("failures") as HTMLElement;

const SEARCH_MIN_PASSES = 4;

// Ryanair rejects large bursts of downloadpass calls, so keep few in flight.
const BULK_CONCURRENCY = 4;
const BULK_ATTEMPTS = 3;

// Statuses seen when the endpoint is shedding load rather than refusing the pass itself.
const RETRYABLE_STATUSES = new Set([408, 422, 425, 429, 500, 502, 503, 504]);

// A bulk run owns the pass list and the bulk button until it finishes.
let bulkRunning = false;

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

function setProgress(done: number, total: number) {
  progressEl.hidden = false;
  progressFillEl.style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;
}

function hideProgress() {
  progressEl.hidden = true;
  progressFillEl.style.width = "0%";
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
  drawField("Seat", pass.seat?.designator ?? "—", 40, 250, "left");
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

  // An image without a scannable barcode is not a boarding pass, so let this throw.
  if (!pass.barcode) throw new Error("No barcode on this pass");

  // bwip-js renders to its own canvas, which we then draw into this one.
  const aztecCanvas = document.createElement("canvas");
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
          <div class="ticket-value" style="font-size: 1.2em">${pass.seat?.designator ?? "—"}</div>
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

async function addToGoogleWallet(payload) {
  const token = await fetchGoogleWalletToken(payload, API_GOOGLE_WALLET_URL);
  const url = `${GOOGLE_WALLET_SAVE_URL}/${encodeURIComponent(token)}`;
  await browser.tabs.create({ url });
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
    id: "google",
    label: "Add to Google Wallet",
    handler: async (payload) => {
      await addToGoogleWallet(payload);
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

interface BulkJob {
  pass: any;
  payload: any;
  index: number;
}

type ZipEntry = { name: string; data: Uint8Array };

type PassBuild = { entries: ZipEntry[]; problem?: string };
type PassProblem = { job: BulkJob; note: string; partial: boolean };

function clearPassMarks() {
  passesEl.querySelectorAll<HTMLElement>(".pass-failed, .pass-partial").forEach((row) => {
    row.classList.remove("pass-failed", "pass-partial");
    delete row.dataset.error;
  });
}

function markPassRow(index: number, note: string, partial: boolean) {
  const row = passesEl.querySelector<HTMLElement>(`.pass[data-index="${index}"]`);
  if (!row) return;

  row.classList.add(partial ? "pass-partial" : "pass-failed");
  row.dataset.error = partial
    ? `Image skipped — ${note}`
    : `Not included in the zip — ${note}`;
}

// A missing status means the request never reached the endpoint, which is also worth a retry.
function isRetryable(error: any): boolean {
  const status = errorStatus(error);
  return status === null || RETRYABLE_STATUSES.has(status);
}

async function renderPassPng(pass): Promise<Uint8Array> {
  const canvas = await drawTicketToCanvas(pass);
  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error("Canvas export failed")), "image/png")
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    // Release the backing bitmap whether or not the encode worked.
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function buildPassFiles(job: BulkJob): Promise<PassBuild> {
  const base = buildPassBaseName(job.pass);

  // Fetch before drawing so a 13MB canvas is not held open across the network wait.
  const pkpassBlob = await retry(
    () => downloadPass(job.payload, API_DOWNLOAD_PASS_URL),
    { attempts: BULK_ATTEMPTS, shouldRetry: isRetryable }
  );

  const entries: ZipEntry[] = [
    { name: `${base}.pkpass`, data: new Uint8Array(await pkpassBlob.arrayBuffer()) },
  ];

  // The pkpass is already in hand, so a failed image costs the image and nothing else.
  try {
    entries.push({ name: `${base}.png`, data: await renderPassPng(job.pass) });
  } catch (error) {
    return { entries, problem: errorText(error) };
  }

  return { entries };
}

function renderProblems(problems: PassProblem[]) {
  failuresEl.innerHTML = "";
  failuresEl.hidden = problems.length === 0;

  problems.forEach(({ job, note, partial }) => {
    const item = document.createElement("button");
    item.className = partial ? "failure-item failure-item-partial" : "failure-item";
    item.title = "Jump to this pass";

    const who = document.createElement("span");
    who.className = "failure-who";
    who.textContent = buildPassTitle(job.pass);

    const why = document.createElement("span");
    why.className = "failure-why";
    why.textContent = partial ? `Image skipped — ${note}` : note;

    item.append(who, why);
    item.addEventListener("click", () => {
      passesEl
        .querySelector<HTMLElement>(`.pass[data-index="${job.index}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    failuresEl.appendChild(item);
  });
}

let hideProgressTimer: ReturnType<typeof setTimeout> | undefined;

async function downloadAllPasses(jobs: BulkJob[]) {
  if (bulkRunning || jobs.length === 0) return;

  const btn = document.getElementById("btn-download-all") as HTMLButtonElement;
  const originalLabel = btn?.textContent ?? "Download All Passes";
  const total = jobs.length;

  bulkRunning = true;
  clearTimeout(hideProgressTimer);
  clearPassMarks();
  renderProblems([]);

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Downloading...";
  }

  let done = 0;
  setProgress(0, total);
  setStatus(`Fetching passes... 0/${total}`);

  try {
    const results = await mapWithConcurrency(jobs, BULK_CONCURRENCY, async (job) => {
      try {
        return await buildPassFiles(job);
      } finally {
        done++;
        setProgress(done, total);
        setStatus(`Fetching passes... ${done}/${total}`);
      }
    });

    const files: ZipEntry[] = [];
    const problems: PassProblem[] = [];
    let failed = 0;

    results.forEach((result, i) => {
      const job = jobs[i];

      if (result.status === "rejected") {
        failed++;
        const note = errorText(result.reason);
        problems.push({ job, note, partial: false });
        markPassRow(job.index, note, false);
        // Row number only — a pass object carries the barcode and the passenger's details.
        console.error(`Pass download failed (row ${job.index})`, result.reason);
        return;
      }

      files.push(...result.value.entries);

      if (result.value.problem) {
        problems.push({ job, note: result.value.problem, partial: true });
        markPassRow(job.index, result.value.problem, true);
        console.error(`Pass image failed (row ${job.index}): ${result.value.problem}`);
      }
    });

    renderProblems(problems);

    if (files.length === 0) {
      setStatus(`All ${total} passes failed. Tap one to jump to it:`);
      return;
    }

    setStatus("Building zip...");
    const zip = buildZip(files);
    const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    try {
      await browser.downloads.download({ url, filename: "passes.zip", saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    if (failed > 0) {
      setStatus(
        `Saved ${total - failed} of ${total}. ` +
        `${failed} failed — tap one to jump to it:`
      );
    } else if (problems.length > 0) {
      setStatus(`Downloaded ${total} passes, ${problems.length} without an image:`);
    } else {
      setStatus(`Downloaded ${total} passes! ✅`);
    }
  } catch (error) {
    setStatus(`Download failed: ${errorText(error)}`);
  } finally {
    bulkRunning = false;
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
    hideProgressTimer = setTimeout(hideProgress, 1500);
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

    // A running bulk download owns the button's label and disabled state.
    const bulkBtn = document.getElementById("btn-download-all");
    if (bulkBtn && !bulkRunning) {
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
    const jobs = Array.from(passesEl.querySelectorAll<HTMLElement>(".pass"))
      .filter((row) => row.style.display !== "none")
      .map((row) => Number(row.dataset.index))
      .filter((i) => !Number.isNaN(i))
      .map((i) => ({ pass: passes[i], payload: payloads[i], index: i }));
    downloadAllPasses(jobs);
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

    // A bulk run holds row indexes into the list it started with, so leave the DOM alone.
    // The background script has already cached this response for the next open.
    if (bulkRunning) return;

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
    if (bulkRunning) return;

    const msg = errorText(error);
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
