// Fancy template — box drawing + full ANSI color, terminal-width aware
const R       = "\x1b[0m";
const BOLD    = "\x1b[1m";
const DIM     = "\x1b[2m";
const CYAN    = "\x1b[36m";
const BCYAN   = "\x1b[96m";
const GREEN   = "\x1b[32m";
const BGREEN  = "\x1b[92m";
const YELLOW  = "\x1b[33m";
const BLUE    = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const RED     = "\x1b[31m";

const cols = () => Math.min(process.stdout.columns || 80, 90);

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function boxLine(content, color, w) {
  const vlen = visible(content).length;
  const pad = " ".repeat(Math.max(0, w - 4 - vlen));
  return `${color}│${R} ${content}${pad} ${color}│${R}`;
}

function drawBox(lines, color) {
  const w = cols();
  const bar = "─".repeat(w - 2);
  process.stdout.write(`${color}╭${bar}╮${R}\n`);
  for (const line of lines) process.stdout.write(boxLine(line, color, w) + "\n");
  process.stdout.write(`${color}╰${bar}╯${R}\n`);
}

function fmtTime() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function statsLine(stats) {
  if (!stats) return "";
  const { promptTokens, completionTokens, totalTokens, elapsedMs, tokensPerSec } = stats;
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const tok = totalTokens ? `${promptTokens}↑ ${completionTokens}↓ = ${totalTokens} tok` : "";
  const tps = tokensPerSec ? `${tokensPerSec} tok/s` : "";
  return [tok, `${elapsed} s`, tps].filter(Boolean).join("  ·  ");
}

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1)     + "K";
  return String(n);
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

let spinnerInterval = null;

function startSpinner() {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  const t0 = Date.now();
  process.stdout.write(`\n${DIM}  thinking${R}`);
  spinnerInterval = setInterval(() => {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r${DIM}  ${frames[i++ % frames.length]} thinking  ${s}s${R}`);
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stdout.write("\r\x1b[2K");
  }
}

export default {
  get prompt() {
    return `${DIM}${fmtTime()}${R} ${BGREEN}◉${R} `;
  },

  welcome({ baseUrl, model }) {
    const w = cols();
    const title = `${BOLD}${BCYAN}⚡ OSIRIS${R}${CYAN}  —  LM Studio CLI Agent`;
    process.stdout.write("\n");
    drawBox([
      title,
      `${DIM}${"─".repeat(w - 6)}${R}`,
      `${DIM}url    ${R}${baseUrl}`,
      `${DIM}model  ${R}${model}`,
      `${DIM}${"─".repeat(w - 6)}${R}`,
      `${DIM}tip: type ${R}/  ${DIM}+ enter to pick a command  ·  tab to autocomplete${R}`,
      `${DIM}tip: start a message with ${R}#  ${DIM}to reset context${R}`,
    ], CYAN);
    process.stdout.write("\n");
  },

  thinking() { startSpinner(); },
  thinkingStop() { stopSpinner(); },

  response(text, stats) {
    const w = cols();
    const bar = "─".repeat(w - 2);
    process.stdout.write(`\n${BLUE}╭${bar}╮${R}\n`);
    for (const line of text.split("\n")) {
      process.stdout.write(boxLine(line, BLUE, w) + "\n");
    }
    process.stdout.write(`${BLUE}╰${bar}╯${R}\n`);
    const line = statsLine(stats);
    if (line) process.stdout.write(`  ${DIM}◦ ${line}${R}\n`);
    process.stdout.write("\n");
  },

  streamStart() {
    const w = cols();
    process.stdout.write(`\n${BLUE}╭${"─".repeat(w - 2)}╮${R}\n${BLUE}│${R} `);
  },

  streamCancel() {
    const w = cols();
    process.stdout.write(`${BLUE}╰${"─".repeat(w - 2)}╯${R}\n`);
  },

  toolCall({ name, args, result }) {
    const resultLines = result.split("\n").filter(Boolean);
    const preview = resultLines[0]?.slice(0, 60) ?? "";
    const more = resultLines.length > 1 ? `  ${DIM}+${resultLines.length - 1} lines${R}` : "";
    const argStr = Object.entries(args).map(([k, v]) =>
      `${DIM}${k}=${R}${JSON.stringify(v)}`
    ).join("  ");
    drawBox([
      `${YELLOW}⚙${R} ${BOLD}${name}${R}  ${argStr}`,
      `${DIM}→${R}  ${preview}${more}`,
    ], YELLOW);
  },

  streamEnd(stats) {
    const w = cols();
    process.stdout.write(`${BLUE}╰${"─".repeat(w - 2)}╯${R}\n`);
    const line = statsLine(stats);
    if (line) process.stdout.write(`  ${DIM}◦ ${line}${R}\n`);
    process.stdout.write("\n");
  },

  async status({ sessionStart, sessionStats, model, baseUrl, statusDir }) {
    const { aggregateStats } = await import("../modules/stats.js");
    const { readKey, parseKey } = await import("../modules/keyreader.js");

    const periods = ["session", "day", "week", "month", "all"];
    let current = 0;

    while (true) {
      const period = periods[current];

      let stats;
      if (period === "session") {
        stats = {
          totalRequests: sessionStats.requests,
          totalPromptTokens: sessionStats.promptTokens,
          totalCompletionTokens: sessionStats.completionTokens,
          totalTokens: sessionStats.totalTokens,
          totalElapsedMs: 0,
          avgTokensPerSec: 0,
          topModel: model,
          topModelCount: sessionStats.requests,
          dateRange: "current session",
        };
      } else {
        stats = aggregateStats(statusDir, period);
      }

      const w = cols();
      const elapsedMs = Date.now() - sessionStart;
      const totalSec  = Math.floor(elapsedMs / 1000);
      const h  = String(Math.floor(totalSec / 3600)).padStart(2, "0");
      const m  = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
      const s  = String(totalSec % 60).padStart(2, "0");
      const startStr = new Date(sessionStart).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      const lines = [
        `${BOLD}${BCYAN}Session Status${R}  ${DIM}(${period})${R}`,
        `${DIM}${"─".repeat(w - 6)}${R}`,
        `${DIM}started   ${R}${startStr}`,
        `${DIM}uptime    ${R}${h}:${m}:${s}`,
        `${DIM}model     ${R}${model}`,
        `${DIM}url       ${R}${baseUrl}`,
        `${DIM}${"─".repeat(w - 6)}${R}`,
        `${DIM}requests  ${R}${stats.totalRequests}`,
        `${DIM}tokens    ${R}${formatNumber(stats.totalPromptTokens)}↑ ${formatNumber(stats.totalCompletionTokens)}↓ = ${BOLD}${formatNumber(stats.totalTokens)}${R}`,
        `${DIM}${"─".repeat(w - 6)}${R}`,
      ];

      if (period !== "session") {
        lines.push(`${DIM}time      ${R}${formatDuration(stats.totalElapsedMs)}`);
        lines.push(`${DIM}avg spd   ${R}${stats.avgTokensPerSec.toFixed(1)} tok/s`);
        if (stats.topModel) lines.push(`${DIM}top mdl   ${R}${stats.topModel} (${stats.topModelCount} req)`);
        if (stats.dateRange) lines.push(`${DIM}range     ${R}${stats.dateRange}`);
      } else {
        lines.push(`${DIM}note      ${R}current session stats only`);
      }

      process.stdout.write("\x1b[2J\x1b[H");
      drawBox(lines, MAGENTA);
      process.stdout.write("\n");

      const tabBar = periods.map((p, i) =>
        i === current ? `${BOLD}${CYAN}[ ${p} ]${R}` : `${DIM}[ ${p} ]${R}`
      ).join(" ");
      process.stdout.write(`  ${tabBar}\n`);
      process.stdout.write(`  ${DIM}← → to switch  Esc to exit${R}\n`);

      const action = parseKey(await readKey());
      if (action === "left")  current = (current - 1 + periods.length) % periods.length;
      else if (action === "right") current = (current + 1) % periods.length;
      else if (action === "escape" || action === "up" || action === "down") break;
    }

    process.stdout.write("\n");
  },

  info(msg) {
    process.stdout.write(`  ${YELLOW}◦${R} ${DIM}${msg}${R}\n`);
  },

  error(msg) {
    process.stderr.write(`  ${RED}✖${R} ${msg}\n`);
  },
};
