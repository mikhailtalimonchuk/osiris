// Minimal template — plain text with green request time
const GREEN = "\x1b[32m";
const R = "\x1b[0m";

let spinnerInterval = null;

function startSpinner() {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  const t0 = Date.now();
  process.stdout.write("\n  thinking");
  spinnerInterval = setInterval(() => {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r  ${frames[i++ % frames.length]} thinking  ${s}s`);
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

export default {
  prompt: "> ",

  welcome({ baseUrl, model }) {
    process.stdout.write(`osiris | ${baseUrl} | ${model}\n\n`);
  },

  thinking() { startSpinner(); },
  thinkingStop() { stopSpinner(); },

  response(text, stats) {
    process.stdout.write(text + "\n");
    if (stats) {
      const elapsed = (stats.elapsedMs / 1000).toFixed(2);
      process.stdout.write(`${GREEN}${elapsed}s${R}\n`);
    }
  },

  streamStart() {},

  streamEnd(stats) {
    if (stats) {
      const elapsed = (stats.elapsedMs / 1000).toFixed(2);
      process.stdout.write(`${GREEN}${elapsed}s${R}\n`);
    }
  },

  info(msg) {
    process.stdout.write(msg + "\n");
  },

  error(msg) {
    process.stderr.write("Error: " + msg + "\n");
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

      const elapsedMs = Date.now() - sessionStart;
      const totalSec  = Math.floor(elapsedMs / 1000);
      const h  = String(Math.floor(totalSec / 3600)).padStart(2, "0");
      const m  = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
      const s  = String(totalSec % 60).padStart(2, "0");
      const startStr = new Date(sessionStart).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(`Session Status (${period})\n`);
      process.stdout.write(`started   ${startStr}\n`);
      process.stdout.write(`uptime    ${h}:${m}:${s}\n`);
      process.stdout.write(`model     ${model}\n`);
      process.stdout.write(`url       ${baseUrl}\n\n`);
      process.stdout.write(`requests  ${stats.totalRequests}\n`);
      process.stdout.write(`tokens    ${formatNumber(stats.totalPromptTokens)}↑ ${formatNumber(stats.totalCompletionTokens)}↓ = ${formatNumber(stats.totalTokens)}\n\n`);
      if (period !== "session") {
        process.stdout.write(`time      ${formatDuration(stats.totalElapsedMs)}\n`);
        process.stdout.write(`avg spd   ${stats.avgTokensPerSec.toFixed(1)} tok/s\n`);
        if (stats.topModel) process.stdout.write(`top mdl   ${stats.topModel} (${stats.topModelCount} req)\n`);
        if (stats.dateRange) process.stdout.write(`range     ${stats.dateRange}\n`);
      } else {
        process.stdout.write(`note      current session stats only\n`);
      }
      process.stdout.write("\n");

      const tabBar = periods.map((p, i) => i === current ? `[ ${p} ]` : `(${p})`).join(" ");
      process.stdout.write(`  ${tabBar}\n`);
      process.stdout.write(`  <- -> to switch  Esc to exit\n`);

      const action = parseKey(await readKey());
      if (action === "left")  current = (current - 1 + periods.length) % periods.length;
      else if (action === "right") current = (current + 1) % periods.length;
      else if (action === "escape" || action === "up" || action === "down") break;
    }

    process.stdout.write("\n");
  },
};
