import { readKey, parseKey, enableMouse, disableMouse } from "./keyreader.js";

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const R      = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN  = "\x1b[32m";

function visibleLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function cols() {
  return Math.min(process.stdout.columns || 80, 120);
}

function rows() {
  return Math.max(12, process.stdout.rows || 24);
}

// ── Read one action (key or mouse click) ─────────────────────────────────────

/**
 * Wait for a single key or mouse click.
 * Returns the parsed action string ("enter", "escape", "click", "up", "down", "timeout", …)
 */
async function readAction(timeoutMs = 0) {
  enableMouse();
  const key = await readKey(timeoutMs);
  disableMouse();
  return parseKey(key);
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
  const hint   = `${DIM}[${GREEN}▶${R}${DIM} click/Enter]${R}`;
  return { header, meta, hint };
}

// ── Interactive viewer ───────────────────────────────────────────────────────

/**
 * Display a tool result with interactive expand support.
 *
 * Shows a compact 1-line collapsed summary. Left-click or Enter/Space expands
 * the full result inline (appended below — no cursor tricks). Long results are
 * paginated; click/Enter advances pages, Escape closes early.
 */
export async function displayToolResult({ name, args, result, renderCollapsed, renderExpanded }) {
  const pageSize  = Math.max(8, rows() - 6);
  const summary   = buildSummary(name, args, result);
  const collapsed = formatCollapsed(summary);
  const w = cols();

  process.stdout.write("\n");

  // ── Collapsed summary ───────────────────────────────────────────────────
  if (renderCollapsed) {
    renderCollapsed({ name, args, result, ...collapsed });
  } else {
    const content = `${collapsed.header}  ${collapsed.meta}  ${collapsed.hint}`;
    const pad = Math.max(0, w - 4 - visibleLen(content));
    process.stdout.write(`${DIM}┌${R} ${content}${" ".repeat(pad)} ${DIM}┐${R}\n`);
  }

  // ── Wait for expand decision (8s auto-skip) ─────────────────────────────
  const decision = await readAction(8_000);
  const shouldExpand = decision === "enter" || decision === "click";

  if (!shouldExpand) {
    process.stdout.write("\n");
    return;
  }

  // ── Expanded view: append-only, paginated ──────────────────────────────
  const lines      = result.split("\n");
  const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));

  for (let page = 0; page < totalPages; page++) {
    const startIdx  = page * pageSize;
    const pageLines = lines.slice(startIdx, startIdx + pageSize);

    if (renderExpanded) {
      renderExpanded({ name, args, result, pageLines, page, totalPages, pageSize });
    } else {
      for (const line of pageLines) {
        const pad = Math.max(0, w - 6 - visibleLen(line));
        process.stdout.write(`  ${DIM}│${R} ${CYAN}${line}${R}${" ".repeat(pad)}\n`);
      }
    }

    if (page === totalPages - 1) {
      if (totalPages > 1) {
        process.stdout.write(`  ${DIM}── end (${totalPages} pages) ──${R}\n`);
      }
    } else {
      process.stdout.write(
        `  ${DIM}── page ${page + 1}/${totalPages}  ·  click/Enter next  ·  Esc close ──${R}\n`
      );
      const next = await readAction(0); // wait indefinitely on pagination
      if (next === "escape") break;
    }
  }

  process.stdout.write("\n");
}

// ── Static (non-interactive) display ────────────────────────────────────────

export function displayToolResultStatic({ name, args, result, maxPreviewLines = 8 }) {
  const summary   = buildSummary(name, args, result);
  const collapsed = formatCollapsed(summary);
  const w = cols();

  process.stdout.write("\n");

  const content = `${collapsed.header}  ${collapsed.meta}`;
  const pad = Math.max(0, w - 4 - visibleLen(content));
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
