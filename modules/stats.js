import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_STATUS_DIR = path.join(os.homedir(), ".osiris", "status");

export function getStatusDir(customDir) {
  return customDir ?? DEFAULT_STATUS_DIR;
}

function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

function dayFile(statusDir, date) {
  return path.join(statusDir, `${date}.json`);
}

function loadDayEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

export function appendStat(statusDir, entry) {
  const file = dayFile(statusDir, dayKey());
  const entries = loadDayEntries(file);
  entries.push({
    timestamp: Date.now(),
    model: entry.model ?? "",
    promptTokens: entry.promptTokens ?? 0,
    completionTokens: entry.completionTokens ?? 0,
    totalTokens: entry.totalTokens ?? 0,
    elapsedMs: entry.elapsedMs ?? 0,
    tokensPerSec: entry.tokensPerSec ?? 0,
  });
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
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
        .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
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
