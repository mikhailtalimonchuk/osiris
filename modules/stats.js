import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { safeSync, safeAsync } from "./errorHandler.js";

const DEFAULT_STATUS_DIR = path.join(os.homedir(), ".osiris", "status");

export function getStatusDir(customDir) {
  return customDir ?? DEFAULT_STATUS_DIR;
}

function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

function dayFile(statusDir, date) {
  return path.join(statusDir, `${date}.jsonl`);
}

// ── In-memory buffer to reduce disk I/O ──────────────────────────────────────
// Entries are buffered in memory and flushed to disk periodically (every 5s)
// or when explicitly flushed. This avoids read-modify-write on every request.

const statBuffer = [];
const FLUSH_INTERVAL_MS = 5_000;
let _flushTimer = null;
let _pendingFlush = null;

function scheduleFlush() {
  if (_flushTimer) return; // already scheduled
  _flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
  // Use unref so the timer doesn't keep the process alive on exit
  if (_flushTimer.unref) _flushTimer.unref();
}

async function flushBuffer() {
  _flushTimer = null;
  if (statBuffer.length === 0) return;

  const entries = statBuffer.splice(0);
  if (!entries.length) return;

  // Group entries by date so we can append to the right file
  const byDate = new Map();
  for (const entry of entries) {
    const date = dayKey(entry.timestamp);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(entry);
  }

  // Write all entries as JSONL (one JSON object per line) — append-only, no read
  const writes = [];
  for (const [date, dayEntries] of byDate) {
    const file = dayFile(getStatusDir(), date);
    const lines = dayEntries.map(e => JSON.stringify(e));
    const content = lines.join("\n") + "\n";
    writes.push(
      fsPromises.mkdir(getStatusDir(), { recursive: true }).then(
        () => fsPromises.appendFile(file, content, "utf8")
      )
    );
  }

  try {
    await Promise.all(writes);
  } catch (e) {
    // Non-fatal: log but don't crash
    console.error(`[stats] flush failed: ${e.message}`);
  }
}

/**
 * Flush any buffered stat entries to disk.
 * Call this before exit to ensure no data is lost.
 */
export async function flushStats() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await flushBuffer();
}

function loadDayEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }
    return entries;
  } catch { return []; }
}

export function appendStat(statusDir, entry) {
  const normalized = {
    timestamp: Date.now(),
    model: entry.model ?? "",
    promptTokens: entry.promptTokens ?? 0,
    completionTokens: entry.completionTokens ?? 0,
    totalTokens: entry.totalTokens ?? 0,
    elapsedMs: entry.elapsedMs ?? 0,
    tokensPerSec: entry.tokensPerSec ?? 0,
  };

  // Buffer in memory instead of writing immediately
  statBuffer.push(normalized);
  scheduleFlush();
}

/**
 * Append a stat entry without throwing — logs errors instead.
 * Use this for non-critical background stat tracking.
 */
export function appendStatSafe(statusDir, entry) {
  // Buffering is inherently non-blocking; just push to buffer
  appendStat(statusDir, entry);
}

function daysBack(n) {
  const dates = [];
  for (let i = 0; i < n; i++) dates.push(dayKey(Date.now() - i * 86_400_000));
  return dates;
}

function loadEntries(statusDir, period) {
  if (!fs.existsSync(statusDir)) return [];
  let dates;
  if (period === "day") {
    dates = daysBack(1);
  } else if (period === "week") {
    dates = daysBack(7);
  } else if (period === "month") {
    dates = daysBack(30);
  } else { // "all"
    try {
      dates = fs.readdirSync(statusDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map(f => f.slice(0, 10));
    } catch { return []; }
  }
  return dates.flatMap(date => loadDayEntries(dayFile(statusDir, date)));
}

export function aggregateStats(statusDir, period = "all") {
  const filtered = loadEntries(statusDir, period);

  const totalRequests = filtered.length;
  const totalPromptTokens = filtered.reduce((s, e) => s + (e.promptTokens ?? 0), 0);
  const totalCompletionTokens = filtered.reduce((s, e) => s + (e.completionTokens ?? 0), 0);
  const totalTokens = filtered.reduce((s, e) => s + (e.totalTokens ?? 0), 0);
  const totalElapsedMs = filtered.reduce((s, e) => s + (e.elapsedMs ?? 0), 0);
  const avgTokensPerSec = totalRequests > 0
    ? filtered.reduce((s, e) => s + (e.tokensPerSec ?? 0), 0) / totalRequests
    : 0;

  const modelCounts = {};
  for (const e of filtered) {
    if (e.model) modelCounts[e.model] = (modelCounts[e.model] ?? 0) + 1;
  }
  let topModel = "—";
  let topModelCount = 0;
  for (const [m, c] of Object.entries(modelCounts)) {
    if (c > topModelCount) { topModel = m; topModelCount = c; }
  }

  let dateRange = "—";
  if (filtered.length > 0) {
    const sorted = [...filtered].sort((a, b) => a.timestamp - b.timestamp);
    const first = new Date(sorted[0].timestamp).toLocaleDateString();
    const last  = new Date(sorted[sorted.length - 1].timestamp).toLocaleDateString();
    dateRange = sorted.length === 1 ? first : `${first} → ${last}`;
  }

  return {
    period,
    totalRequests,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalElapsedMs,
    avgTokensPerSec,
    topModel,
    topModelCount,
    dateRange,
  };
}

export function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1)     + "K";
  return String(n);
}

export function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
