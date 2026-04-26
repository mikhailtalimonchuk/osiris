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

// Strip ANSI codes to measure visible length
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
    ], CYAN);
    process.stdout.write("\n");
  },

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
    const w = cols();
    const argStr = JSON.stringify(args);
    const preview = result.length > 200 ? result.slice(0, 200) + "…" : result;
    drawBox([
      `${YELLOW}⚙${R} ${BOLD}${name}${R}  ${DIM}${argStr}${R}`,
      `${DIM}${"─".repeat(w - 6)}${R}`,
      ...preview.split("\n").slice(0, 12).map(l => `${DIM}${l}${R}`),
    ], YELLOW);
  },

  streamEnd(stats) {
    const w = cols();
    // cursor is already on a new line (chatOnce wrote os.EOL)
    process.stdout.write(`${BLUE}╰${"─".repeat(w - 2)}╯${R}\n`);
    const line = statsLine(stats);
    if (line) process.stdout.write(`  ${DIM}◦ ${line}${R}\n`);
    process.stdout.write("\n");
  },

  status({ sessionStart, sessionStats, model, baseUrl }) {
    const elapsedMs = Date.now() - sessionStart;
    const totalSec  = Math.floor(elapsedMs / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    const { requests, promptTokens, completionTokens, totalTokens } = sessionStats;
    const startStr = new Date(sessionStart).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    drawBox([
      `${BOLD}${BCYAN}Session Status${R}`,
      `${DIM}${"─".repeat(cols() - 6)}${R}`,
      `${DIM}started   ${R}${startStr}`,
      `${DIM}uptime    ${R}${h}:${m}:${s}`,
      `${DIM}model     ${R}${model}`,
      `${DIM}url       ${R}${baseUrl}`,
      `${DIM}${"─".repeat(cols() - 6)}${R}`,
      `${DIM}requests  ${R}${requests}`,
      `${DIM}tokens    ${R}${promptTokens}↑ ${completionTokens}↓ = ${BOLD}${totalTokens} total${R}`,
    ], MAGENTA);
    process.stdout.write("\n");
  },

  info(msg) {
    process.stdout.write(`  ${YELLOW}◦${R} ${DIM}${msg}${R}\n`);
  },

  error(msg) {
    process.stderr.write(`  ${RED}✖${R} ${msg}\n`);
  },
};
