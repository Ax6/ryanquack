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
import { buildPassBaseName, buildPassFilename, hasBarcode } from "../lib/ryanair";
import type { BoardingPass, DownloadPayload, FlightSummary } from "../lib/ryanair";
import type { CachedPasses, PassesResult, RyqMessage } from "../lib/messages";
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

  const toBigInt = (value: string) => BigInt(String(value));

  window.bcadd = (left, right) => String(toBigInt(left) + toBigInt(right));
  window.bcmul = (left, right) => String(toBigInt(left) * toBigInt(right));
  window.bcdiv = (left, right) => String(toBigInt(left) / toBigInt(right));
}

ensureBcMath();

function setStatus(text: string) {
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

// The API never says why the barcode is missing, so the copy names the usual
// cause and stops short of asserting it.
const NO_BARCODE_NOTICE =
  "No barcode yet. Ryanair hasn't issued a scannable code for this pass, usually because " +
  "travel documents still need to be checked. Check the booking on ryanair.com.";

function getRandomQuack() {
  return QUACKS[Math.floor(Math.random() * QUACKS.length)];
}

/** Greedily breaks `text` into lines that fit `maxWidth` under the context's current font. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line === "" ? word : `${line} ${word}`;
    // An over-long single word still gets its own line rather than being dropped.
    if (line !== "" && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line !== "") lines.push(line);
  return lines;
}

/** Fills the square the Aztec would have occupied with the missing-barcode notice. */
function drawNoBarcodeNotice(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number
) {
  // Plain rect: roundRect needs Firefox 112+, and the manifest allows 109.
  ctx.fillStyle = "#f2f2f2";
  ctx.fillRect(x, y, size, size);

  ctx.font = "normal 16px sans-serif";
  ctx.fillStyle = "#2b2b2b";
  ctx.textAlign = "center";

  const lineHeight = 22;
  const lines = wrapText(ctx, NO_BARCODE_NOTICE, size - 40);
  const firstBaseline = y + size / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, x + size / 2, firstBaseline + i * lineHeight));
}

async function drawTicketToCanvas(pass: BoardingPass): Promise<HTMLCanvasElement> {
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
  const drawField = (
    label: string,
    value: string,
    x: number,
    y: number,
    align: CanvasTextAlign = "left",
    // Condenses rather than overruns: long passenger names would otherwise
    // collide with the field opposite them.
    maxWidth?: number
  ) => {
    ctx.textAlign = align;

    ctx.font = "normal 14px sans-serif";
    ctx.fillStyle = "#666666";
    ctx.fillText(label.toUpperCase(), x, y, maxWidth);

    ctx.font = "bold 20px sans-serif";
    ctx.fillStyle = "#000000";
    ctx.fillText(value, x, y + 25, maxWidth);
  };

  // Row 1: Passenger / Booking ref
  // 323px is the gap to the booking reference opposite.
  drawField("Passenger", `${pass.name.first} ${pass.name.last}`, 40, 110, "left", 315);
  drawField("Booking ref", pass.pnr, width - 40, 110, "right");

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

  // Center the Aztec code
  const aztecSize = 300;
  const x = (width - aztecSize) / 2;
  const y = 350;
  const barcode = hasBarcode(pass) ? String(pass.barcode) : null;

  if (barcode === null) {
    // Still worth exporting: everything but the scannable code is on the image.
    drawNoBarcodeNotice(ctx, x, y, aztecSize);
  } else {
    // bwip-js renders to its own canvas, which we then draw into this one.
    const aztecCanvas = document.createElement("canvas");
    bwipjs.toCanvas(aztecCanvas, {
      bcid: "azteccode",
      text: barcode,
      scale: 4, // Higher scale for the large image
      backgroundcolor: "ffffff",
      includetext: false
    });
    ctx.drawImage(aztecCanvas, x, y, aztecSize, aztecSize);
  }

  // RyanQuack Branding
  ctx.font = "italic 14px sans-serif";
  ctx.fillStyle = "#999999";
  ctx.textAlign = "center";
  ctx.fillText("Generated with RyanQuack 🦆", width / 2, height - 30);

  return canvas;
}

function renderTicketDetails(container: HTMLElement, pass: BoardingPass) {
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

      <div class="ticket-section">
        <div>
          <div class="ticket-label">Booking ref</div>
          <div class="ticket-value">${pass.pnr}</div>
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
  const btnCopy = container.querySelector("#btn-copy") as HTMLButtonElement;
  const btnSave = container.querySelector("#btn-save") as HTMLButtonElement;

  const handleExport = async (action: "copy" | "save") => {
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
            await downloadBlob(blob, buildPassFilename(pass, "png"));

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
      // The bulk path names the reason a render failed, so this one should too.
      setStatus(`Export failed 🦆 ${errorText(err)}`);
    }
  };

  btnCopy.addEventListener("click", () => handleExport("copy"));
  btnSave.addEventListener("click", () => handleExport("save"));

  const canvasContainer = container.querySelector(".aztec-canvas") as HTMLElement;
  const barcode = hasBarcode(pass) ? String(pass.barcode) : null;

  // The details are the point of this view, so keep them and explain the gap.
  if (barcode === null) {
    const notice = document.createElement("div");
    notice.className = "aztec-missing";
    notice.textContent = NO_BARCODE_NOTICE;
    canvasContainer.appendChild(notice);
    return;
  }

  const canvas = document.createElement("canvas");
  bwipjs.toCanvas(canvas, {
    bcid: "azteccode",
    text: barcode,
    scale: 3,
    backgroundcolor: "ffffff",
    includetext: false
  });

  canvasContainer.appendChild(canvas);
}

function renderAztec(container: HTMLElement, text: string | null | undefined) {
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

/** Saves a blob through the downloads API, releasing the object URL once the download has started. */
async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({ url, filename, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function downloadWalletPass(payload: DownloadPayload, pass: BoardingPass) {
  const blob = await downloadPass(payload, API_DOWNLOAD_PASS_URL);
  await downloadBlob(blob, buildPassFilename(pass, "pkpass"));
}

async function addToGoogleWallet(payload: DownloadPayload) {
  const token = await fetchGoogleWalletToken(payload, API_GOOGLE_WALLET_URL);
  const url = `${GOOGLE_WALLET_SAVE_URL}/${encodeURIComponent(token)}`;
  await browser.tabs.create({ url });
}

interface PassActionElements {
  outputBox: HTMLElement;
}

interface PassAction {
  id: string;
  label: string;
  handler: (
    payload: DownloadPayload,
    pass: BoardingPass,
    elements: PassActionElements
  ) => Promise<void>;
}

const passActions: PassAction[] = [
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
  pass: BoardingPass;
  payload: DownloadPayload;
  index: number;
}

type ZipEntry = { name: string; data: Uint8Array<ArrayBuffer> };

type PassBuild = { entries: ZipEntry[]; problem?: string };
const NO_WALLET_PASS_NOTE = "No wallet pass — Ryanair hasn't issued a barcode yet";
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
  row.dataset.error = partial ? note : `Not included in the zip — ${note}`;
}

// A missing status means the request never reached the endpoint, which is also worth a retry.
function isRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || RETRYABLE_STATUSES.has(status);
}

async function renderPassPng(pass: BoardingPass): Promise<Uint8Array<ArrayBuffer>> {
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
  const entries: ZipEntry[] = [];

  // A wallet pass is only a container for the barcode, so there is nothing to
  // fetch here and the row's wallet buttons are disabled for the same reason.
  if (hasBarcode(job.pass)) {
    // Fetch before drawing so a 13MB canvas is not held open across the network wait.
    const pkpassBlob = await retry(
      () => downloadPass(job.payload, API_DOWNLOAD_PASS_URL),
      { attempts: BULK_ATTEMPTS, shouldRetry: isRetryable }
    );
    entries.push({ name: `${base}.pkpass`, data: new Uint8Array(await pkpassBlob.arrayBuffer()) });
  }

  // The pkpass is already in hand, so a failed image costs the image and nothing else.
  try {
    entries.push({ name: `${base}.png`, data: await renderPassPng(job.pass) });
  } catch (error) {
    return { entries, problem: `Image skipped — ${errorText(error)}` };
  }

  return hasBarcode(job.pass) ? { entries } : { entries, problem: NO_WALLET_PASS_NOTE };
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
    why.textContent = note;

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

// A fetchPasses result that arrived while a bulk run owned the DOM, applied once the run ends.
let pendingRender: { apply: (deferred: boolean) => void; replacesList: boolean } | null = null;

function whenBulkIdle(apply: (deferred: boolean) => void, { replacesList = false } = {}) {
  if (bulkRunning) pendingRender = { apply, replacesList };
  else apply(false);
}

/** Gives the entry a distinct name inside the zip; duplicates would silently overwrite each other. */
function uniqueEntryName(name: string, used: Set<string>, suffix: number): string {
  const unique = used.has(name) ? name.replace(/(\.[^.]+)$/, `_${suffix}$1`) : name;
  used.add(unique);
  return unique;
}

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

  // Below the concurrency cap every job starts at once, so the bar would only
  // flicker. The status line carries the count either way.
  const showProgress = total > BULK_CONCURRENCY;

  let done = 0;
  let hadProblems = false;
  // Clearing the pending hide above would otherwise strand a full bar from a larger run.
  if (showProgress) setProgress(0, total); else hideProgress();
  setStatus(`Fetching passes... 0/${total}`);

  try {
    const results = await mapWithConcurrency(jobs, BULK_CONCURRENCY, async (job) => {
      try {
        return await buildPassFiles(job);
      } finally {
        done++;
        if (showProgress) setProgress(done, total);
        setStatus(`Fetching passes... ${done}/${total}`);
      }
    });

    const files: ZipEntry[] = [];
    const usedNames = new Set<string>();
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

      for (const entry of result.value.entries) {
        files.push({ ...entry, name: uniqueEntryName(entry.name, usedNames, job.index) });
      }

      if (result.value.problem) {
        problems.push({ job, note: result.value.problem, partial: true });
        markPassRow(job.index, result.value.problem, true);
        console.error(`Pass incomplete (row ${job.index}): ${result.value.problem}`);
      }
    });

    renderProblems(problems);
    hadProblems = problems.length > 0;

    if (files.length === 0) {
      setStatus(`All ${total} passes failed. Tap one to jump to it:`);
      return;
    }

    setStatus("Building zip...");
    const zip = buildZip(files);
    await downloadBlob(new Blob([zip], { type: "application/zip" }), "passes.zip");

    if (failed > 0) {
      setStatus(
        `Saved ${total - failed} of ${total}. ` +
        `${failed} failed — tap one to jump to it:`
      );
    } else if (problems.length > 0) {
      setStatus(`Downloaded ${total} passes, ${problems.length} with missing files — see details:`);
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
      // The search handler left the button alone during the run, so re-sync it with the current query.
      searchBarEl.querySelector("input")?.dispatchEvent(new Event("input"));
    }
    hideProgressTimer = setTimeout(hideProgress, 1500);

    // Replacing the list would wipe the failure marks the user is about to act on,
    // so a run with problems keeps its list; status-only updates always apply.
    if (pendingRender && !(pendingRender.replacesList && hadProblems)) {
      pendingRender.apply(true);
    }
    pendingRender = null;
  }
}

function renderSearchBar(passes: BoardingPass[]) {
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
    const bulkBtn = document.getElementById("btn-download-all") as HTMLButtonElement | null;
    if (bulkBtn && !bulkRunning) {
      bulkBtn.textContent = query === ""
        ? "Download All Passes"
        : `Download Results (${visible.length})`;
      bulkBtn.disabled = visible.length === 0;
    }

    const printBtn = document.getElementById("btn-print-all") as HTMLButtonElement | null;
    if (printBtn) {
      printBtn.textContent = query === "" ? "Print all" : `Print Results (${visible.length})`;
      printBtn.disabled = visible.length === 0;
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

function renderBulkActions(passes: BoardingPass[], payloads: DownloadPayload[]) {
  bulkActionsEl.innerHTML = "";
  if (passes.length === 0) return;

  // Printing is worth offering for a single pass; a zip of one is not.
  if (passes.length <= 1) {
    bulkActionsEl.appendChild(buildPrintAllButton(passes));
    return;
  }

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
  bulkActionsEl.appendChild(buildPrintAllButton(passes));
}

function buildPassTitle(pass: BoardingPass) {
  return `${pass.pnr} · ${pass.departure.code} → ${pass.arrival.code} · ${pass.name.first} ${pass.name.last}`;
}

function buildPassSearchHaystack(pass: BoardingPass): string {
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

function renderPasses(passes: BoardingPass[], payloads: DownloadPayload[]) {
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
    row.appendChild(header);

    if (!hasBarcode(pass)) {
      row.classList.add("pass-no-barcode");

      const notice = document.createElement("div");
      notice.className = "pass-notice";
      notice.textContent = NO_BARCODE_NOTICE;
      row.appendChild(notice);
    }

    const actions = document.createElement("div");
    actions.className = "pass-actions";

    const outputBox = document.createElement("div");
    outputBox.className = "pass-qr";

    passActions.forEach((action) => {
      const button = document.createElement("button");
      button.textContent = action.label;
      button.dataset.action = action.id;
      // A wallet pass is only a container for the barcode, so without one there
      // is nothing usable to hand out. Show Ticket stays: the details are.
      if (action.id !== "qr" && !hasBarcode(pass)) {
        button.disabled = true;
        button.title = "No barcode yet, so there is no wallet pass to download";
      }
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
            setStatus(`Error: ${errorText(error)}`);
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
          setStatus(`Error: ${errorText(error)}`);
        } finally {
          button.disabled = false;
        }
      });
      actions.appendChild(button);
    });

    row.appendChild(actions);
    row.appendChild(outputBox);
    passesEl.appendChild(row);
  });
}

function renderFlights(flights: FlightSummary[]) {
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
  let cachedData: CachedPasses | null = null;
  try {
    const cache = await browser.storage.local.get("cachedPasses");
    if (cache && cache.cachedPasses) {
      // storage.local hands back `unknown`; this is the shape the background wrote.
      cachedData = cache.cachedPasses as CachedPasses;
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
    // The fields are read defensively below, so the response is typed as partial.
    const res = (await browser.runtime.sendMessage<RyqMessage, PassesResult>({
      type: "RYQ_FETCH_BOARDING_PASSES",
    })) as Partial<PassesResult> | undefined;

    const passes = res && res.passes ? res.passes : [];
    const payloads = res && res.downloadPayloads ? res.downloadPayloads : [];
    const flights = res && res.flights ? res.flights : [];

    // A bulk run holds row indexes into the list it started with, so a run in
    // progress owns the DOM; the fresh list is applied once it finishes.
    whenBulkIdle((deferred) => {
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

      // Only the completed refresh can trigger automatic printing. The
      // optimistic cache may still contain an old seat or barcode.
      maybeAutoPrint(passes);

      // A late render keeps the bulk run's result in the status line.
      if (deferred) return;
      if (passes.length === 0 && upcoming.length === 0) {
        setStatus("Nothing to quack.");
      } else if (passes.length > 0) {
        setStatus(READY_QUACK);
      } else {
        setStatus("Too early to fly! 🐣  No tickets found, they will appear once you check-in.");
      }
    }, { replacesList: true });

  } catch (error) {
    const msg = errorText(error);
    if (msg.includes("LOGIN_REQUIRED")) {
      // Still worth showing after a bulk run: an expired session is why its passes 403'd.
      whenBulkIdle(() => setStatus("Please log in to Ryanair.com 🔒"));
    } else if (msg.includes("NO_PASSES")) {
      whenBulkIdle(() => setStatus("Nothing to quack."));
    } else if (bulkRunning) {
      // The cached list the run started from is already on screen.
      return;
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
      if (autoPrintPending) {
        autoPrintPending = false;
        restorePrintQuery();
        setStatus("Offline (Cached) ☁️ Review the cached passes, then choose Print all to print them.");
      } else {
        setStatus("Offline (Cached) ☁️");
      }
    } else {
      setStatus(`Error: ${msg}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Full-tab view
 * ------------------------------------------------------------------ */

/** Runtime path of the popup document, as the build emits it (dist/<target>/src/popup/popup.html). */
const POPUP_PAGE_PATH = "src/popup/popup.html";

const TAB_VIEW_QUERY = "?view=tab";

function isTabView(): boolean {
  return new URLSearchParams(window.location.search).get("view") === "tab";
}

/** Tab-only styling hangs off this class, so it has to land before the first render. */
function applyViewMode() {
  if (isTabView()) document.body.classList.add("view-tab");
}

/** An extension page opened by its own extension needs no extra permission. */
function renderOpenInTabControl() {
  if (isTabView()) return;

  const header = document.querySelector(".app-header");
  if (!header) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "btn-open-tab";
  button.className = "btn-open-tab";
  button.title = "Open RyanQuack in a full browser tab";
  button.textContent = "Open in tab ↗";

  button.addEventListener("click", () => {
    const url = browser.runtime.getURL(POPUP_PAGE_PATH) + TAB_VIEW_QUERY;
    browser.tabs.create({ url }).catch((error) => {
      setStatus(`Could not open a tab: ${errorText(error)}`);
    });
  });

  header.appendChild(button);
}

/* ------------------------------------------------------------------ *
 * Print sheet
 * ------------------------------------------------------------------ */

const PRINT_SHEET_ID = "print-sheet";

/** Aztec modules stay crisp well past this; the card's CSS scales the canvas down. */
const PRINT_AZTEC_SCALE = 3;

/** Some browsers never fire `afterprint`, so the sheet is swept up on a timer too. */
const PRINT_CLEANUP_MS = 60_000;
/** Three 80mm rows of three cards fill an A4 page; each page carries its own margins. */
const PRINT_CARDS_PER_PAGE = 9;

function buildPrintField(label: string, value: string): HTMLElement {
  const field = document.createElement("div");
  field.className = "print-field";

  const labelEl = document.createElement("span");
  labelEl.className = "print-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "print-value";
  valueEl.textContent = value;

  field.append(labelEl, valueEl);
  return field;
}

function renderPrintAztec(slot: HTMLElement, pass: BoardingPass) {
  if (!hasBarcode(pass)) {
    slot.classList.add("print-aztec-missing");
    slot.textContent = "No barcode issued for this pass";
    return;
  }

  try {
    const canvas = document.createElement("canvas");
    bwipjs.toCanvas(canvas, {
      bcid: "azteccode",
      text: String(pass.barcode),
      scale: PRINT_AZTEC_SCALE,
      backgroundcolor: "ffffff",
      includetext: false
    });
    slot.appendChild(canvas);
  } catch (error) {
    // One unprintable barcode should not cost the user the rest of the sheet.
    console.error("Print barcode failed", error);
    slot.classList.add("print-aztec-missing");
    slot.textContent = "Barcode could not be rendered";
  }
}

function buildPrintCard(pass: BoardingPass): HTMLElement {
  const card = document.createElement("div");
  card.className = "print-card";

  const route = document.createElement("div");
  route.className = "print-route";
  route.textContent = `${pass.departure.code} ✈ ${pass.arrival.code}`;

  const name = document.createElement("div");
  name.className = "print-name";
  name.textContent = `${pass.name.first} ${pass.name.last}`;

  const grid = document.createElement("div");
  grid.className = "print-grid";

  const dateStr = new Date(pass.departure.date)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const timeStr = new Date(pass.boardingTime)
    .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  grid.append(
    buildPrintField("Flight", `${pass.flight.carrierCode} ${pass.flight.number}`),
    buildPrintField("Date", dateStr),
    buildPrintField("Boarding", timeStr),
    buildPrintField("Seat", pass.seat?.designator ?? "—"),
    buildPrintField("Seq", String(pass.sequence)),
    buildPrintField("Ref", pass.pnr),
  );

  card.append(route, name, grid);

  if (pass.priority) {
    const priority = document.createElement("div");
    priority.className = "print-priority";
    priority.textContent = "PRIORITY BOARDING";
    card.appendChild(priority);
  }

  const aztec = document.createElement("div");
  aztec.className = "print-aztec";
  renderPrintAztec(aztec, pass);
  card.appendChild(aztec);

  return card;
}

/** The passes the user can currently see — the same visibility rule the bulk button uses. */
function visiblePasses(passes: BoardingPass[]): BoardingPass[] {
  return Array.from(passesEl.querySelectorAll<HTMLElement>(".pass"))
    .filter((row) => row.style.display !== "none")
    .map((row) => Number(row.dataset.index))
    .filter((index) => !Number.isNaN(index) && passes[index] !== undefined)
    .map((index) => passes[index]);
}

/** Builds an off-screen sheet of cards, prints it, and takes it back down after. */
function printPasses(passes: BoardingPass[]) {
  // A sheet stranded by a missed `afterprint` would otherwise print twice.
  document.getElementById(PRINT_SHEET_ID)?.remove();

  const sheet = document.createElement("div");
  sheet.id = PRINT_SHEET_ID;
  // Explicit pages, so every page (not just the first) gets the same padding.
  for (let start = 0; start < passes.length; start += PRINT_CARDS_PER_PAGE) {
    const page = document.createElement("div");
    page.className = "print-page";
    passes.slice(start, start + PRINT_CARDS_PER_PAGE)
      .forEach((pass) => page.appendChild(buildPrintCard(pass)));
    sheet.appendChild(page);
  }
  document.body.appendChild(sheet);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    window.removeEventListener("afterprint", cleanup);
    sheet.remove();
  };

  window.addEventListener("afterprint", cleanup);
  timer = setTimeout(cleanup, PRINT_CLEANUP_MS);

  window.print();
}

function printVisiblePasses(passes: BoardingPass[]) {
  const selected = visiblePasses(passes);
  if (selected.length === 0) {
    setStatus("Nothing to print 🦆");
    return;
  }

  setStatus(`Printing ${selected.length} ${selected.length === 1 ? "pass" : "passes"}...`);
  printPasses(selected);
}

function currentSearchQuery(): string {
  return searchBarEl.querySelector<HTMLInputElement>("input")?.value.trim() ?? "";
}

/**
 * Hands the print job to the tab view, carrying the search filter across.
 * Chrome tears the action popup down as soon as the print dialog takes focus,
 * which would leave the user with a dialog and no document behind it.
 */
function openPrintTab() {
  const query = currentSearchQuery();
  const url = browser.runtime.getURL(POPUP_PAGE_PATH)
    + "?view=tab&print=1"
    + (query ? `&q=${encodeURIComponent(query)}` : "");

  browser.tabs.create({ url }).catch((error) => {
    setStatus(`Could not open a tab: ${errorText(error)}`);
  });
}

/** `print=1` is honoured once per page load; a later re-render must not reprint. */
let autoPrintPending = isTabView()
  && new URLSearchParams(window.location.search).get("print") === "1";

/**
 * Replays a "Print all" click only after the network result has been rendered.
 * Cached data stays available for manual printing if the refresh fails.
 */
function maybeAutoPrint(passes: BoardingPass[]) {
  if (!autoPrintPending) return;
  autoPrintPending = false;

  setTimeout(() => {
    restorePrintQuery();
    printVisiblePasses(passes);
  }, 0);
}

function restorePrintQuery() {
  const query = new URLSearchParams(window.location.search).get("q");
  const input = searchBarEl.querySelector<HTMLInputElement>("input");
  if (query && input) {
    input.value = query;
    input.dispatchEvent(new Event("input"));
  }
}

function buildPrintAllButton(passes: BoardingPass[]): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "btn-print-all";
  button.className = "btn-print-all";
  button.textContent = "Print all";
  button.title = isTabView()
    ? "Lay every visible pass out as a wallet-size card and open the print dialog"
    : "Open the full-tab view and print every visible pass as a wallet-size card";

  button.addEventListener("click", () => {
    if (!isTabView()) {
      openPrintTab();
      return;
    }

    printVisiblePasses(passes);
  });

  return button;
}

applyViewMode();
renderOpenInTabControl();

fetchPasses();
