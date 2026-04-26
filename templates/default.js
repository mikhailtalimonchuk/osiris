// Clean template — subtle ANSI color, no box drawing
const R = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

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

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
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

function visibleLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function cols() {
  return Math.min(process.stdout.columns || 80, 120);
}

export default {
  prompt: `${CYAN}›${R} `,

  welcome({ baseUrl, model }) {
    const sep = `${DIM}${"─".repeat(52)}${R}`;
    process.stdout.write(`\n${BOLD}  osiris${R}  ${DIM}LM Studio CLI Agent${R}\n`);
    process.stdout.write(`${sep}\n`);
    process.stdout.write(`  ${DIM}url  ${R}${baseUrl}\n`);
    process.stdout.write(`  ${DIM}mdl  ${R}${model}\n`);
    process.stdout.write(`${sep}\n`);
    process.stdout.write(`  ${DIM}tip: type ${R}/  ${DIM}+ enter to pick a command  ·  tab to autocomplete${R}\n`);
    process.stdout.write(`  ${DIM}tip: start a message with ${R}#  ${DIM}to reset context${R}\n`);
  },

  thinking() {
    startSpinner();
  },

  thinkingStop() {
    stopSpinner();
  },

  response(text, stats) {
    process.stdout.write(`\n${GREEN}${text}${R}\n\n`);
  },

  streamStart() {
    process.stdout.write(`\n${GREEN}`);
  },

  streamEnd() {
    process.stdout.write(`${R}\n`);
  },

  /** Legacy toolCall — used in "full" mode to show entire result */
  toolCall({ name, args, result }) {
    const argStr = JSON.stringify(args);
    const preview = result.length > 200 ? result.slice(0, 200) + "…" : result;
    process.stdout.write(`\n${YELLOW}⚙ Tool: ${BOLD}${name}${R}${DIM}(${argStr})${R}\n`);
    process.stdout.write(`${DIM}  Result:${R}\n`);
    for (const line of preview.split("\n").slice(0, 12)) {
      process.stdout.write(`    ${line}\n`);
    }
    process.stdout.write("\n");
  },

  /** Render the collapsed 1-line summary for interactive tool results */
  renderToolCollapsed({ name, args, result, header, meta, hint }) {
    const w = cols();
    const content = `${header}  ${meta}  ${hint}`;
    const pad = Math.max(0, w - 4 - visibleLen(content));
    process.stdout.write(`${DIM}┌${R} ${content}${" ".repeat(pad)} ${DIM}┐${R}\n`);
  },

  /** Render the expanded view content (called per-page) */
  renderToolExpanded({ name, args, result, pageLines, page, totalPages, pageSize }) {
    const w = cols();
    for (const line of pageLines) {
      const pad = Math.max(0, w - 6 - visibleLen(line));
      process.stdout.write(`  ${DIM}│${R} ${CYAN}${line}${R}${" ".repeat(pad)}\n`);
    }
    const remaining = pageSize - pageLines.length;
    for (let i = 0; i < remaining; i++) {
      process.stdout.write(`  ${DIM}│${R}\n`);
    }
  },

  info(msg) {
    process.stdout.write(`${DIM}  ${msg}${R}\n`);
  },

  error(msg) {
    process.stderr.write(`${RED}  ✖ ${msg}${R}\n`);
  },

  async status({ sessionStart, sessionStats, model, baseUrl, statusDir }) {
    const { aggregateStats } = await import("../modules/stats.js");
    const { readKey, parseKey } = await import("../modules/keyreader.js");
    
    const periods = ["session", "day", "week", "month", "all"];
    let current = 0;
    
    while (true) {
      const period = periods[current];
      
      // Get stats for the selected period
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
      
      const sep = `${DIM}${"─".repeat(52)}${R}`;
      
      // Session info header
      const elapsedMs = Date.now() - sessionStart;
      const totalSec = Math.floor(elapsedMs / 1000);
      const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
      const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
      const s = String(totalSec % 60).padStart(2, "0");
      const startStr = new Date(sessionStart).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      
      let lines = [];
      lines.push(`${BOLD}  Session Status${R}  ${DIM}(${period})${R}`);
      lines.push(sep);
      lines.push(`  ${DIM}started   ${R}${startStr}`);
      lines.push(`  ${DIM}uptime    ${R}${h}:${m}:${s}`);
      lines.push(`  ${DIM}model     ${R}${model}`);
      lines.push(`  ${DIM}url       ${R}${baseUrl}`);
      lines.push(sep);
      lines.push(`  ${DIM}requests  ${R}${stats.totalRequests}`);
      lines.push(`  ${DIM}tokens    ${R}${formatNumber(stats.totalPromptTokens)}↑ ${formatNumber(stats.totalCompletionTokens)}↓ = ${BOLD}${formatNumber(stats.totalTokens)}${R}`);
      lines.push(sep);
      if (period !== "session") {
        lines.push(`  ${DIM}time      ${R}${formatDuration(stats.totalElapsedMs)}`);
        lines.push(`  ${DIM}avg spd   ${R}${stats.avgTokensPerSec.toFixed(1)} tok/s`);
        if (stats.topModel) {
          lines.push(`  ${DIM}top mdl   ${R}${stats.topModel} (${stats.topModelCount} req)`);
        }
        if (stats.dateRange) {
          lines.push(`  ${DIM}range     ${R}${stats.dateRange}`);
        }
      } else {
        lines.push(`  ${DIM}note      ${R}current session stats only`);
      }
      lines.push(sep);
      
      // Clear and render
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(lines.join("\n") + "\n\n");
      
      // Tab bar
      const tabBar = periods.map((p, i) => {
        if (i === current) return `${BOLD}${CYAN}[ ${p} ]${R}`;
        return `${DIM}[ ${p} ]${R}`;
      }).join(" ");
      process.stdout.write(`  ${tabBar}\n`);
      process.stdout.write(`  ${DIM}← → to switch  Esc to exit${R}\n`);
      
      // Wait for keypress
      const key = await readKey();
      const action = parseKey(key);
      
      if (action === "left") {
        current = (current - 1 + periods.length) % periods.length;
      } else if (action === "right") {
        current = (current + 1) % periods.length;
      } else if (action === "escape" || action === "up" || action === "down") {
        break;
      }
    }
    
    process.stdout.write("\n");
  },
};
