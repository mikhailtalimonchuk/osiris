import { parseKey } from "./keyreader.js";

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const R       = "\x1b[0m";
const BOLD    = "\x1b[1m";
const DIM     = "\x1b[2m";
const CYAN    = "\x1b[36m";
const YELLOW  = "\x1b[33m";
const GREEN   = "\x1b[32m";

function visibleLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function cols() {
  return Math.min(process.stdout.columns || 80, 120);
}

function rows() {
  return Math.max(12, process.stdout.rows || 24);
}

// ── Mouse tracking ───────────────────────────────────────────────────────────

function enableMouse()  { process.stdout.write("\x1b[?1000h\x1b[?1006h"); }
function disableMouse() { process.stdout.write("\x1b[?1000l\x1b[?1006l"); }

function parseMouseEvent(str) {
  const m = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!m) return null;
  return {
    button: parseInt(m[1]) & 0x43,
    col:    parseInt(m[2]),
    row:    parseInt(m[3]),
    type:   m[4] === "M" ? "press" : "release",
  };
}

/**
 * Read one input event from stdin — either a mouse click or a keypress.
 * Returns { type: 'click' } for left-button press, { type: 'key', key: string } for keypresses,
 * or { type: 'timeout' } if timeoutMs elapses.
 */
async function waitForInput(timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const wasRaw    = process.stdin.isRaw;
    const wasPaused = !process.stdin.readableFlowing && process.stdin.isPaused?.();
    if (!wasRaw) process.stdin.setRawMode(true);
    process.stdin.resume();

    let timer = null;

    function cleanup(result) {
      clearTimeout(timer);
      disableMouse();
      process.stdin.removeListener("data", onData);
      if (!wasRaw) process.stdin.setRawMode(false);
      if (wasPaused) process.stdin.pause();
      resolve(result);
    }

    function onData(buf) {
      const str = buf.toString("utf8");

      // Ctrl+C — pass through as key so caller can handle exit
      if (str === "\x03") { cleanup({ type: "key", key: str }); return; }

      const mouse = parseMouseEvent(str);
      if (mouse) {
        if (mouse.button === 0 && mouse.type === "press") {
          cleanup({ type: "click" });
        }
        // ignore releases and other buttons
        return;
      }

      cleanup({ type: "key", key: str });
    }

    enableMouse();
    process.stdin.on("data", onData);

    if (timeoutMs > 0) {
      timer = setTimeout(() => cleanup({ type: "timeout" }), timeoutMs);
    }
  });
}

// ── Summary helpers ──────────────────────────────────────────────────────────

export function buildSummary(name, args, result) {
  const argPairs = Object.entries(args)
    .slice(0, 4)
    .map(([k, v]) => {
      const val = typeof v === "string" && v.length > 40
        ? `"${v.slice(0, 37)}…"`
        : JSON.stringify(v);
      return `${DIM}${k}${R}=${val}`;
    })
    .join(", ");

  const lineCount = result.split("\n").length;
  const charCount = result.length;
  const moreArgs  = Object.entries(args).length > 4 ? `, ${DIM}…${R}` : "";

  return { name, argPairs, moreArgs, lineCount, charCount };
}

function formatCollapsed({ name, argPairs, moreArgs, lineCount, charCount }) {
  const header = `${YELLOW}⚙${R} ${BOLD}${name}${R}(${argPairs}${moreArgs})`;
  const meta   = `${DIM}${lineCount}L ${charCount}C${R}`;
  const hint   = `${DIM}[${GREEN}▶${R} click/Enter]${R}`;
  return { header, meta, hint };
}

// ── Interactive viewer ───────────────────────────────────────────────────────

export async function displayToolResult({ name, args, result, renderCollapsed, renderExpanded }) {
  const pageSize = Math.max(8, rows() - 6);
  const summary  = buildSummary(name, args, result);
  const collapsed = formatCollapsed(summary);

  process.stdout.write("\n");

  if (renderCollapsed) {
    renderCollapsed({ name, args, result, ...collapsed });
  } else {
    const w       = cols();
    const content = `${collapsed.header}  ${collapsed.meta}  ${collapsed.hint}`;
    const pad     = Math.max(0, w - 4 - visibleLen(content));
    process.stdout.write(`${DIM}┌${R} ${content}${" ".repeat(pad)} ${DIM}┐${R}\n`);
  }

  process.stdout.write(`  ${DIM}click or Enter to expand  ·  other key to skip${R}\n`);

  const input = await waitForInput(8_000);

  if (input.type === "timeout") {
    process.stdout.write("\n");
    return;
  }

  if (input.type === "key") {
    const action = parseKey(input.key);
    if (action !== "enter" && input.key !== " ") {
      process.stdout.write("\n");
      return;
    }
  }
  // type === 'click' OR enter/space key → expand

  await showExpanded({ name, args, result, pageSize, renderExpanded, collapsed });
  process.stdout.write("\n");
}

async function showExpanded({ name, args, result, pageSize, renderExpanded, collapsed }) {
  const lines      = result.split("\n");
  const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));
  let page = 0;

  while (true) {
    const clearCount = pageSize + 2;
    process.stdout.write(`\x1b[${clearCount}A`);

    const w       = cols();
    const content = `${collapsed.header}  ${collapsed.meta}  ${DIM}expanded${R}`;
    const pad     = Math.max(0, w - 4 - visibleLen(content));
    process.stdout.write(`${DIM}┌${R} ${content}${" ".repeat(pad)} ${DIM}┐${R}\n`);

    const startIdx = page * pageSize;
    const pageLines = lines.slice(startIdx, startIdx + pageSize);

    if (renderExpanded) {
      renderExpanded({ name, args, result, pageLines, page, totalPages, pageSize });
    } else {
      for (const line of pageLines) {
        const linePad = Math.max(0, w - 6 - visibleLen(line));
        process.stdout.write(`  ${DIM}│${R} ${CYAN}${line}${R}${" ".repeat(linePad)}\n`);
      }
      const remaining = pageSize - pageLines.length;
      for (let i = 0; i < remaining; i++) {
        process.stdout.write(`  ${DIM}│${R}\n`);
      }
    }

    const pageInfo = `${DIM}${page + 1}/${totalPages}  ↑↓ scroll  click/Esc/Enter close${R}`;
    process.stdout.write(`  ${pageInfo}\n`);

    const input = await waitForInput(30_000);

    if (input.type === "click" || input.type === "timeout") {
      break;
    }

    const action = parseKey(input.key);
    if (action === "up")          page = Math.max(0, page - 1);
    else if (action === "down")   page = Math.min(totalPages - 1, page + 1);
    else if (action === "escape" || action === "enter") break;
  }

  // Erase expanded area
  const clearCount = pageSize + 3;
  process.stdout.write(`\x1b[${clearCount}A`);
  for (let i = 0; i < clearCount; i++) {
    process.stdout.write("\x1b[2K\r\n");
  }
  process.stdout.write(`\x1b[${clearCount}A`);
}

// ── Static (non-interactive) display ────────────────────────────────────────

export function displayToolResultStatic({ name, args, result, maxPreviewLines = 8 }) {
  const summary   = buildSummary(name, args, result);
  const collapsed = formatCollapsed(summary);
  const w         = cols();

  process.stdout.write("\n");

  const content = `${collapsed.header}  ${collapsed.meta}`;
  const pad     = Math.max(0, w - 4 - visibleLen(content));
  process.stdout.write(`${DIM}┌${R} ${content}${" ".repeat(pad)} ${DIM}┐${R}\n`);

  const lines   = result.split("\n");
  const preview = lines.slice(0, maxPreviewLines);
  for (const line of preview) {
    const linePad = Math.max(0, w - 6 - visibleLen(line));
    process.stdout.write(`  ${DIM}│${R} ${line}${" ".repeat(linePad)}\n`);
  }

  if (lines.length > maxPreviewLines) {
    process.stdout.write(`  ${DIM}… ${lines.length - maxPreviewLines} more lines${R}\n`);
  }

  process.stdout.write("\n");
}

// ── Config ───────────────────────────────────────────────────────────────────

let _toolResultMode = "interactive";

export function configureToolResultDisplay(mode) {
  if (["interactive", "static", "full"].includes(mode)) {
    _toolResultMode = mode;
  }
}

export function getToolResultDisplayMode() {
  return _toolResultMode;
}
