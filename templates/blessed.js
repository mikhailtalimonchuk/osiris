// Blessed TUI template — full interactive terminal UI
import blessed from "blessed";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ── History ────────────────────────────────────────────────────────────────────
const HISTORY_FILE = path.join(os.homedir(), ".osiris", "history");
const ONE_DAY_MS   = 24 * 60 * 60 * 1000;

const cmdHistory = {
  entries: [], maxSize: 1000, index: -1,
  load() {
    try {
      if (!fs.existsSync(HISTORY_FILE)) return;
      const cutoff = Date.now() - ONE_DAY_MS;
      this.entries = fs.readFileSync(HISTORY_FILE, "utf-8")
        .split("\n").filter(Boolean)
        .flatMap(l => { try { const e = JSON.parse(l); return e.ts >= cutoff && e.text ? [e] : []; } catch { return []; } })
        .slice(-this.maxSize);
    } catch { this.entries = []; }
    this.index = -1;
  },
  save() {
    try {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fs.writeFileSync(HISTORY_FILE, this.entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    } catch {}
  },
  add(text) {
    const t = text.trim();
    if (!t || this.entries.at(-1)?.text === t) return;
    this.entries.push({ ts: Date.now(), text: t });
    if (this.entries.length > this.maxSize) this.entries.shift();
    this.index = -1;
    this.save();
  },
  prev() {
    if (!this.entries.length) return null;
    if (this.index === -1) this.index = this.entries.length - 1;
    else if (this.index > 0) this.index--;
    return this.entries[this.index].text;
  },
  next() {
    if (this.index === -1) return "";
    this.index++;
    if (this.index >= this.entries.length) { this.index = -1; return ""; }
    return this.entries[this.index].text;
  },
  reset() { this.index = -1; },
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function wordStart(str, pos) {
  while (pos > 0 && /\s/.test(str[pos - 1])) pos--;
  while (pos > 0 && !/\s/.test(str[pos - 1])) pos--;
  return pos;
}
function wordEnd(str, pos) {
  while (pos < str.length && !/\s/.test(str[pos])) pos++;
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  return pos;
}

// Escape blessed tag characters in user content
function esc(str) {
  return String(str ?? "").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

// Strip blessed tags for length measurement
function visLen(str) {
  return str.replace(/\{[^}]+\}/g, "").replace(/\\[{}]/g, " ").length;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1)     + "K";
  return String(n);
}

function fmtStats(stats) {
  if (!stats) return "";
  const { promptTokens, completionTokens, totalTokens, elapsedMs, tokensPerSec } = stats;
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const tok = totalTokens ? `${promptTokens}↑ ${completionTokens}↓ = ${totalTokens} tok` : "";
  const tps = tokensPerSec ? `${tokensPerSec} tok/s` : "";
  return [tok, `${elapsed} s`, tps].filter(Boolean).join("  ·  ");
}

// ── Screen ─────────────────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR:    true,
  title:       "⚡ OSIRIS",
  fullUnicode: true,
  dockBorders: false,
  ignoreLocked: ["C-c"],
});

// Header bar (1 row)
const header = blessed.box({
  parent: screen,
  top: 0, left: 0, right: 0, height: 1,
  tags: true,
  style: { fg: "cyan" },
});

// Chat log (fills space between header and input)
const chatBox = blessed.box({
  parent: screen,
  top: 1, left: 0, right: 0, bottom: 4,
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: false,
  tags: true,
  scrollbar: {
    ch:    " ",
    style: { bg: "cyan" },
    track: { bg: "black" },
  },
});

// Input container (3 rows: top border + content + bottom border)
const inputWrap = blessed.box({
  parent: screen,
  bottom: 1, left: 0, right: 0, height: 3,
  border: { type: "line" },
  style:  { border: { fg: "green" } },
  tags: true,
});

// Input text area inside the container
const inputLine = blessed.box({
  parent: inputWrap,
  top: 0, left: 1, right: 1, height: 1,
  tags: true,
  style: { fg: "white" },
});

// Autocomplete dropdown (shown above input when typing /)
const dropdown = blessed.list({
  parent: screen,
  bottom: 4, left: 2, width: 36,
  height: 0,
  hidden: true,
  tags: true,
  style: {
    fg:       "white",
    selected: { fg: "cyan", bold: true },
    item:     { fg: "gray" },
  },
});

// Footer (1 row — command hints)
const footer = blessed.box({
  parent: screen,
  bottom: 0, left: 0, right: 0, height: 1,
  tags: true,
  style: { fg: "gray" },
});

// ── State ──────────────────────────────────────────────────────────────────────
const SPIN = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

// Message store — each entry rendered to logLines on update
const msgLog = [];       // { type, payload }
let logLines = [];

let inputBuf    = "";
let inputCursor = 0;
let inputActive = false;
let inputResolve = null;
let inputCmds   = [];
let dropItems   = [];
let dropIdx     = 0;
let searchMode  = false;
let searchBuf   = "";
let searchIdx   = -1;

const killRing  = [];
let killRingIdx = -1;
const undoStack = [];
let undoPtr     = -1;

let isThinking  = false;
let spinFrame   = 0;
let isStreaming  = false;
let streamBuf   = "";
let currentModel = "";
let clockTimer  = null;

// ── Log rendering ──────────────────────────────────────────────────────────────
function bw() { return Math.max(20, (screen.width || 80) - 2); }

function hline(label = "", color = "cyan") {
  const w = bw();
  const lbl = label ? ` ${label} ` : "";
  const fill = Math.max(0, w - 2 - visLen(lbl));
  return ` {${color}-fg}╭${lbl}${"─".repeat(fill)}╮{/}`;
}

function hlineRight(right = "", color = "cyan") {
  const w = bw();
  const r = right ? ` ${right} ` : "";
  const fill = Math.max(0, w - 2 - visLen(r));
  return ` {${color}-fg}╰${"─".repeat(fill)}${r}╯{/}`;
}

function bline(content, color = "cyan") {
  return ` {${color}-fg}│{/} ${content}`;
}

function renderMsg(msg) {
  const lines = [];
  switch (msg.type) {
    case "welcome": {
      const { baseUrl, model } = msg;
      lines.push("");
      lines.push(hline("", "cyan"));
      lines.push(bline("{bold}{cyan-fg}⚡ OSIRIS{/}  LM Studio CLI Agent{/}", "cyan"));
      lines.push(bline(`${"─".repeat(bw() - 4)}{/}`, "cyan"));
      lines.push(bline(`url    {/}${esc(baseUrl)}`, "cyan"));
      lines.push(bline(`model  {/}${esc(model)}`, "cyan"));
      lines.push(bline(`${"─".repeat(bw() - 4)}{/}`, "cyan"));
      lines.push(bline(`type {/}/ + Enter to pick a command  ·  Tab to autocomplete{/}`, "cyan"));
      lines.push(bline(`start with {/}# to reset context  ·  Ctrl+C to exit{/}`, "cyan"));
      lines.push(hlineRight("", "cyan"));
      lines.push("");
      break;
    }
    case "user": {
      lines.push("");
      lines.push(hline("{bold}YOU{/}", "green"));
      for (const line of String(msg.content).split("\n")) {
        lines.push(bline(`{green-fg}${esc(line)}{/}`, "green"));
      }
      lines.push(hlineRight("", "green"));
      break;
    }
    case "ai": {
      lines.push("");
      lines.push(hline("{bold}OSIRIS{/}", "blue"));
      for (const line of String(msg.content).split("\n")) {
        lines.push(bline(esc(line), "blue"));
      }
      const sl = fmtStats(msg.stats);
      lines.push(hlineRight(sl ? `${esc(sl)}{/}` : "", "blue"));
      lines.push("");
      break;
    }
    case "tool": {
      const { name, args, result } = msg;
      const argStr = Object.entries(args ?? {})
        .map(([k, v]) => `${esc(k)}={/}{cyan-fg}${esc(JSON.stringify(v))}{/}`)
        .join("  ");
      const rlines = String(result ?? "").split("\n").filter(Boolean);
      const preview = esc(rlines[0]?.slice(0, 70) ?? "");
      const moreTag = rlines.length > 1 ? `  +${rlines.length - 1} lines{/}` : "";
      lines.push("");
      lines.push(hline(`{bold}⚙ ${esc(name)}{/}`, "yellow"));
      if (argStr) lines.push(bline(argStr, "yellow"));
      lines.push(bline(`→{/}  ${preview}${moreTag}`, "yellow"));
      lines.push(hlineRight("", "yellow"));
      break;
    }
    case "info":
      lines.push(`  {yellow-fg}◦{/} ${esc(msg.content)}{/}`);
      break;
    case "error":
      lines.push(`  {red-fg}✖{/} {red-fg}${esc(msg.content)}{/}`);
      break;
    case "separator":
      lines.push(`  ${"─".repeat(bw() - 2)}{/}`);
      break;
  }
  return lines;
}

function renderStreamLines() {
  const out = [];
  out.push("");
  out.push(hline("{bold}OSIRIS{/} {yellow-fg}●{/}", "blue"));
  for (const line of (streamBuf || " ").split("\n")) {
    out.push(bline(esc(line), "blue"));
  }
  return out;
}

function updateDisplay() {
  logLines = [];
  for (const msg of msgLog) {
    logLines.push(...renderMsg(msg));
  }
  if (isStreaming) {
    logLines.push(...renderStreamLines());
  }
  chatBox.setContent(logLines.join("\n"));
  chatBox.setScrollPerc(100);
  screen.render();
}

function addMsg(msg) {
  msgLog.push(msg);
  updateDisplay();
}

// ── Header ─────────────────────────────────────────────────────────────────────
function renderHeader() {
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, "0")).join(":");

  const brand   = "{bold}{cyan-fg}⚡ OSIRIS{/}";
  const model   = currentModel ? `  │{/}  ${esc(currentModel)}{/}` : "";
  const spinner = isThinking ? `{yellow-fg}${SPIN[spinFrame]} thinking{/}  ` : "";
  const clock   = `${time}{/}`;

  header.setContent(` ${brand}${model}{right}${spinner}${clock} `);
  screen.render();
}

// ── Footer ─────────────────────────────────────────────────────────────────────
function renderFooter() {
  const cmds = inputCmds.map(c => `${c}{/}`).join("  ");
  footer.setContent(` shortcuts:{/}  ${cmds}  │  ↑↓ history  Ctrl+R search  Ctrl+C exit{/}`);
}

// ── Input rendering ────────────────────────────────────────────────────────────
function renderInput() {
  if (!inputActive) {
    inputWrap.style.border = { fg: "gray" };
    inputLine.setContent("waiting…{/}");
    dropdown.hide();
    screen.render();
    return;
  }

  inputWrap.style.border = { fg: "green" };

  if (searchMode) {
    const match = cmdHistory.entries[searchIdx];
    inputLine.setContent(
      `{yellow-fg}(reverse-i-search){/} '${esc(searchBuf)}'{/}: {green-fg}${esc(match?.text ?? "")}{/}`
    );
    dropdown.hide();
    screen.render();
    return;
  }

  const before = esc(inputBuf.slice(0, inputCursor));
  const cur    = inputBuf[inputCursor] ?? " ";
  const after  = esc(inputBuf.slice(inputCursor + 1));
  inputLine.setContent(`{green-fg}›{/} ${before}${esc(cur)}{/}${after}`);

  if (dropItems.length) {
    dropdown.setItems(
      dropItems.map((item, i) =>
        i === dropIdx
          ? `{bold}{cyan-fg}▶ ${esc(item)}{/}`
          : `  ${esc(item)}{/}`
      )
    );
    dropdown.height = Math.min(dropItems.length, 8);
    dropdown.show();
  } else {
    dropdown.hide();
  }

  screen.render();
}

// ── Editing helpers ────────────────────────────────────────────────────────────
function updateDrop() {
  dropItems = inputBuf.startsWith("/")
    ? inputCmds.filter(c => c.startsWith(inputBuf))
    : [];
  if (dropIdx >= dropItems.length) dropIdx = 0;
}

function pushUndo() {
  if (undoPtr < undoStack.length - 1) undoStack.length = undoPtr + 1;
  const top = undoStack.at(-1);
  if (top && top.buf === inputBuf && top.cursor === inputCursor) return;
  undoStack.push({ buf: inputBuf, cursor: inputCursor });
  undoPtr = undoStack.length - 1;
  if (undoStack.length > 200) { undoStack.shift(); undoPtr--; }
}

function undo() {
  if (undoPtr > 0) {
    undoPtr--;
    ({ buf: inputBuf, cursor: inputCursor } = undoStack[undoPtr]);
    updateDrop(); renderInput();
  }
}

function pushKill(text) {
  if (!text) return;
  if (killRing.length && killRingIdx >= 0) {
    killRing[killRingIdx] += text;
  } else {
    killRing.push(text);
    killRingIdx = killRing.length - 1;
    if (killRing.length > 50) killRing.shift();
  }
}

function yank() {
  if (!killRing.length) return;
  const text = killRing[killRingIdx] ?? killRing.at(-1);
  inputBuf = inputBuf.slice(0, inputCursor) + text + inputBuf.slice(inputCursor);
  inputCursor += text.length;
  updateDrop(); renderInput();
}

function insertChar(ch) {
  pushUndo();
  inputBuf = inputBuf.slice(0, inputCursor) + ch + inputBuf.slice(inputCursor);
  inputCursor++;
  updateDrop(); renderInput();
}

function resolveWith(value) {
  inputActive = false;
  dropItems   = [];
  searchMode  = false;
  searchBuf   = "";
  searchIdx   = -1;
  dropdown.hide();
  cmdHistory.add(value);
  addMsg({ type: "user", content: value });
  inputBuf    = "";
  inputCursor = 0;
  undoStack.length = 0;
  undoPtr = -1;
  renderInput();
  if (inputResolve) { const fn = inputResolve; inputResolve = null; fn(value); }
}

// ── Key handler ────────────────────────────────────────────────────────────────
// Use screen.key() for ALL named keys — this is the correct blessed pattern.
// screen.on("keypress") is used ONLY for printable character insertion and search mode.
// This prevents escape-sequence bytes from being accidentally inserted as text.

function ifInput(fn) {
  return (...args) => { if (inputActive && !searchMode) fn(...args); };
}

// Ctrl+C — always active, even while thinking/streaming
screen.key(["C-c"], () => process.exit(0));

// Enter
screen.key(["return", "enter"], ifInput(() => {
  resolveWith(dropItems.length ? dropItems[dropIdx] : inputBuf);
}));

// Backspace / Delete
screen.key(["backspace"], ifInput(() => {
  if (inputCursor > 0) { pushUndo(); inputBuf = inputBuf.slice(0, inputCursor - 1) + inputBuf.slice(inputCursor); inputCursor--; updateDrop(); renderInput(); }
}));
screen.key(["delete"], ifInput(() => {
  if (inputCursor < inputBuf.length) { pushUndo(); inputBuf = inputBuf.slice(0, inputCursor) + inputBuf.slice(inputCursor + 1); updateDrop(); renderInput(); }
}));

// Arrow keys — cursor movement and history
screen.key(["left"], ifInput(() => {
  if (dropItems.length) return;
  if (inputCursor > 0) { inputCursor--; renderInput(); }
}));
screen.key(["right"], ifInput(() => {
  if (dropItems.length) return;
  if (inputCursor < inputBuf.length) { inputCursor++; renderInput(); }
}));
screen.key(["up"], ifInput(() => {
  if (dropItems.length) { dropIdx = (dropIdx - 1 + dropItems.length) % dropItems.length; renderInput(); return; }
  const prev = cmdHistory.prev();
  if (prev !== null) { pushUndo(); inputBuf = prev; inputCursor = inputBuf.length; updateDrop(); renderInput(); }
}));
screen.key(["down"], ifInput(() => {
  if (dropItems.length) { dropIdx = (dropIdx + 1) % dropItems.length; renderInput(); return; }
  const next = cmdHistory.next();
  pushUndo(); inputBuf = next; inputCursor = inputBuf.length; updateDrop(); renderInput();
}));

// Home / End
screen.key(["home"], ifInput(() => { inputCursor = 0; renderInput(); }));
screen.key(["end"],  ifInput(() => { inputCursor = inputBuf.length; renderInput(); }));

// Tab — autocomplete
screen.key(["tab"], ifInput(() => {
  if (dropItems.length) { inputBuf = dropItems[dropIdx]; inputCursor = inputBuf.length; dropItems = []; renderInput(); }
}));

// Escape — clear dropdown / exit search
screen.key(["escape"], () => {
  if (!inputActive) return;
  if (searchMode) { searchMode = false; searchBuf = ""; searchIdx = -1; renderInput(); return; }
  dropItems = []; dropIdx = 0; renderInput();
});

// Emacs movement bindings
screen.key(["C-a"], ifInput(() => { inputCursor = 0; renderInput(); }));
screen.key(["C-e"], ifInput(() => { inputCursor = inputBuf.length; renderInput(); }));
screen.key(["C-f"], ifInput(() => { if (inputCursor < inputBuf.length) { inputCursor++; renderInput(); } }));
screen.key(["C-b"], ifInput(() => { if (inputCursor > 0) { inputCursor--; renderInput(); } }));

// Ctrl+H = backspace
screen.key(["C-h"], ifInput(() => {
  if (inputCursor > 0) { pushUndo(); inputBuf = inputBuf.slice(0, inputCursor - 1) + inputBuf.slice(inputCursor); inputCursor--; updateDrop(); renderInput(); }
}));

// Kill ring
screen.key(["C-u"], ifInput(() => { pushUndo(); pushKill(inputBuf); inputBuf = ""; inputCursor = 0; updateDrop(); renderInput(); }));
screen.key(["C-k"], ifInput(() => {
  if (inputCursor < inputBuf.length) { pushUndo(); pushKill(inputBuf.slice(inputCursor)); inputBuf = inputBuf.slice(0, inputCursor); updateDrop(); renderInput(); }
}));
screen.key(["C-y"], ifInput(() => yank()));
screen.key(["C-w"], ifInput(() => {
  const before = inputBuf.slice(0, inputCursor);
  const match  = before.match(/(\S+)\s*$/);
  if (match) { pushUndo(); pushKill(match[0]); inputBuf = inputBuf.slice(0, inputCursor - match[0].length) + inputBuf.slice(inputCursor); inputCursor -= match[0].length; updateDrop(); renderInput(); }
}));

// Undo / Transpose
screen.key(["C-_"], ifInput(() => undo()));
screen.key(["C-t"], ifInput(() => {
  if (inputBuf.length < 2) return;
  pushUndo();
  if (inputCursor === inputBuf.length) {
    const i = inputCursor - 1;
    inputBuf = inputBuf.slice(0, i - 1) + inputBuf[i] + inputBuf[i - 1] + inputBuf.slice(i + 1);
  } else if (inputCursor > 0) {
    const i = inputCursor - 1;
    inputBuf = inputBuf.slice(0, i) + inputBuf[i + 1] + inputBuf[i] + inputBuf.slice(i + 2);
    inputCursor = i + 2;
  }
  updateDrop(); renderInput();
}));

// Reverse search
screen.key(["C-r"], () => {
  if (!inputActive) return;
  searchMode = true; searchBuf = ""; searchIdx = -1; renderInput();
});

// Ctrl+D — EOF on empty
screen.key(["C-d"], () => {
  if (!inputActive || inputBuf) return;
  if (inputResolve) { inputActive = false; const fn = inputResolve; inputResolve = null; fn(null); }
});

// ── Printable character input + search mode (screen.on handles what screen.key misses) ──
screen.on("keypress", (ch, key) => {
  if (!inputActive) return;

  const ctrl = key?.ctrl ?? false;
  const meta = key?.meta ?? false;

  // Search mode — intercept all keystrokes
  if (searchMode) {
    const name = key?.name;
    if (name === "backspace" || (ctrl && name === "h")) {
      if (searchBuf.length > 0) {
        searchBuf = searchBuf.slice(0, -1);
        searchIdx = -1;
        for (let i = cmdHistory.entries.length - 1; i >= 0; i--) {
          if (cmdHistory.entries[i].text.toLowerCase().includes(searchBuf.toLowerCase())) { searchIdx = i; break; }
        }
      }
    } else if (ch && ch.length === 1 && !ctrl && !meta && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127) {
      searchBuf += ch;
      searchIdx = -1;
      for (let i = cmdHistory.entries.length - 1; i >= 0; i--) {
        if (cmdHistory.entries[i].text.toLowerCase().includes(searchBuf.toLowerCase())) { searchIdx = i; break; }
      }
    }
    renderInput(); return;
  }

  // Printable character insertion — only single visible chars, no escape sequences
  if (
    ch &&
    ch.length === 1 &&
    !ctrl &&
    !meta &&
    ch.charCodeAt(0) >= 32 &&
    ch.charCodeAt(0) !== 127  // exclude DEL
  ) {
    insertChar(ch);
  }
});

// Mouse scroll in chat
screen.on("mouse", (data) => {
  if (data.action === "wheelup")   { chatBox.scroll(-3); screen.render(); }
  if (data.action === "wheeldown") { chatBox.scroll(3);  screen.render(); }
});

// Resize
screen.on("resize", () => {
  updateDisplay();
  renderHeader();
  renderInput();
});

// ── Clock / spinner ────────────────────────────────────────────────────────────
function startClock() {
  clockTimer = setInterval(() => {
    if (isThinking) spinFrame = (spinFrame + 1) % SPIN.length;
    renderHeader();
  }, 100);
}

// ── Blessed list selector (replaces selector.js while screen is active) ────────
async function blessedSelect(items, { label = "select an option:" } = {}) {
  return new Promise((resolve) => {
    const savedActive = inputActive;
    inputActive = false;

    const overlay = blessed.box({
      parent: screen,
      top: "center", left: "center",
      width: Math.min(70, screen.width - 8),
      height: Math.min(items.length + 6, screen.height - 6),
      border: { type: "line" },
      style: { border: { fg: "cyan" } },
      tags: true,
    });

    blessed.box({
      parent: overlay,
      top: 0, left: 1, right: 1, height: 1,
      content: `{bold}{cyan-fg}${esc(label)}{/}`,
      tags: true,
    });

    const list = blessed.list({
      parent: overlay,
      top: 2, left: 1, right: 1, bottom: 2,
      items: items.map(i => `  ${esc(i)}`),
      mouse: true,
      keys: false,
      tags: true,
      style: {
        fg:       "white",
        selected: { fg: "cyan", bold: true },
        item:     { fg: "gray" },
      },
    });

    blessed.box({
      parent: overlay,
      bottom: 0, left: 1, right: 1, height: 1,
      content: "↑↓ navigate  Enter select  Esc cancel{/}",
      tags: true,
    });

    list.select(0);
    screen.append(overlay);
    screen.render();

    const cleanup = (result) => {
      screen.unkey("escape",  escH);
      screen.unkey("return",  enterH);
      screen.unkey("up",      upH);
      screen.unkey("down",    downH);
      overlay.destroy();
      inputActive = savedActive;
      screen.render();
      resolve(result);
    };

    const escH   = () => cleanup(null);
    const enterH = () => cleanup(items[list.selected]);
    const upH    = () => { list.up(1); screen.render(); };
    const downH  = () => { list.down(1); screen.render(); };

    screen.key(["escape"], escH);
    screen.key(["return"],  enterH);
    screen.key(["up"],      upH);
    screen.key(["down"],    downH);
  });
}

// ── Status overlay ─────────────────────────────────────────────────────────────
async function showStatus({ sessionStart: start, sessionStats, model, baseUrl, statusDir }) {
  const { aggregateStats } = await import("../modules/stats.js");

  const periods = ["session", "day", "week", "month", "all"];
  let current = 0;

  const savedActive = inputActive;
  inputActive = false;

  const overlay = blessed.box({
    parent: screen,
    top: 0, left: 0, right: 0, bottom: 0,
    border: { type: "line" },
    style: { border: { fg: "magenta" } },
    tags: true,
    label: " {bold}{magenta-fg}⚡ SESSION STATUS{/} ",
  });

  const content = blessed.box({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 4,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
  });

  const tabs = blessed.box({
    parent: overlay,
    bottom: 2, left: 1, right: 1, height: 1,
    tags: true,
  });

  blessed.box({
    parent: overlay,
    bottom: 0, left: 1, right: 1, height: 1,
    tags: true,
    content: " ← → switch tabs  R refresh  Esc close{/}",
  });

  screen.append(overlay);

  const renderStatus = () => {
    const period = periods[current];
    let lines = [];

    if (period === "session") {
      const ms = Date.now() - start;
      const s  = Math.floor(ms / 1000);
      const hh = String(Math.floor(s / 3600)).padStart(2, "0");
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      const startStr = new Date(start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      lines = [
        `  {bold}{cyan-fg}Session Status{/}  (current session){/}`,
        `  ${"─".repeat(Math.max(0, (screen.width || 80) - 10))}{/}`,
        `  started   {/}${esc(startStr)}`,
        `  uptime    {/}${hh}:${mm}:${ss}`,
        `  model     {/}{cyan-fg}${esc(model)}{/}`,
        `  url       {/}${esc(baseUrl)}`,
        `  ${"─".repeat(Math.max(0, (screen.width || 80) - 10))}{/}`,
        `  requests  {/}{bold}${sessionStats.requests}{/}`,
        `  tokens    {/}${fmtNumber(sessionStats.promptTokens)}↑{/} ${fmtNumber(sessionStats.completionTokens)}↓{/} = {bold}${fmtNumber(sessionStats.totalTokens)}{/}`,
        `  note      {/}current session only`,
      ];
    } else {
      const st = aggregateStats(statusDir, period);
      lines = [
        `  {bold}{cyan-fg}Usage Stats{/}  (${esc(period)}){/}`,
        `  ${"─".repeat(Math.max(0, (screen.width || 80) - 10))}{/}`,
        `  requests  {/}{bold}${st.totalRequests}{/}`,
        `  tokens    {/}${fmtNumber(st.totalPromptTokens)}↑{/} ${fmtNumber(st.totalCompletionTokens)}↓{/} = {bold}${fmtNumber(st.totalTokens)}{/}`,
        `  ${"─".repeat(Math.max(0, (screen.width || 80) - 10))}{/}`,
        `  time      {/}${fmtDuration(st.totalElapsedMs)}`,
        `  avg speed {/}${st.avgTokensPerSec.toFixed(1)} tok/s`,
      ];
      if (st.topModel)  lines.push(`  top model {/}{cyan-fg}${esc(st.topModel)}{/} (${st.topModelCount} req){/}`);
      if (st.dateRange) lines.push(`  range     {/}${esc(st.dateRange)}`);
    }

    content.setContent(lines.join("\n"));
    tabs.setContent(
      periods.map((p, i) =>
        i === current
          ? `{bold}{cyan-fg}[ ${p} ]{/}`
          : `[ ${p} ]{/}`
      ).join("  ")
    );
    screen.render();
  };

  renderStatus();

  return new Promise((resolve) => {
    const escH     = () => {
      screen.unkey("escape", escH); screen.unkey("q", escH);
      screen.unkey("left", leftH); screen.unkey("h", leftH);
      screen.unkey("right", rightH); screen.unkey("l", rightH);
      screen.unkey("r", refreshH);
      overlay.destroy();
      inputActive = savedActive;
      screen.render();
      resolve();
    };
    const leftH    = () => { current = (current - 1 + periods.length) % periods.length; renderStatus(); };
    const rightH   = () => { current = (current + 1) % periods.length; renderStatus(); };
    const refreshH = () => renderStatus();

    screen.key(["escape", "q"], escH);
    screen.key(["left",   "h"], leftH);
    screen.key(["right",  "l"], rightH);
    screen.key(["r"],           refreshH);
  });
}

// ── Initial render ─────────────────────────────────────────────────────────────
// Enable mouse (chatBox has mouse:true so blessed picks this up automatically,
// but calling it here ensures it's active immediately after all widgets are ready)
screen.enableMouse();
screen.render();

// ── Template export ────────────────────────────────────────────────────────────
startClock();

export default {
  get prompt() { return "> "; },

  welcome({ baseUrl, model }) {
    currentModel = model;
    renderHeader();
    addMsg({ type: "welcome", baseUrl, model });
  },

  thinking() {
    isThinking = true;
    spinFrame  = 0;
  },

  thinkingStop() {
    isThinking = false;
    renderHeader();
  },

  response(text, stats) {
    addMsg({ type: "ai", content: text, stats });
  },

  streamStart() {
    isStreaming = true;
    streamBuf   = "";
    updateDisplay();
  },

  streamCancel() {
    if (streamBuf) addMsg({ type: "ai", content: streamBuf, stats: null });
    isStreaming = false;
    streamBuf   = "";
    updateDisplay();
  },

  streamEnd(stats) {
    const text = streamBuf;
    isStreaming = false;
    streamBuf   = "";
    addMsg({ type: "ai", content: text, stats });
  },

  // Receives each streamed token from chat.js (via onChunk pass-through)
  onChunk(delta) {
    streamBuf += delta;
    // Throttle renders to ~30fps so fast tokens don't overload the event loop
    if (!this._chunkTimer) {
      this._chunkTimer = setTimeout(() => {
        this._chunkTimer = null;
        updateDisplay();
      }, 33);
    }
  },

  // Force full mode so keyreader.js isn't used alongside blessed stdin
  toolResultMode: "full",

  toolCall({ name, args, result }) {
    addMsg({ type: "tool", name, args, result });
  },

  renderToolCollapsed({ name, args, result, header, meta, hint }) {
    const content = `{yellow-fg}⚙ ${esc(name)}{/}  ${esc(meta)}  ${esc(hint)}{/}`;
    addMsg({ type: "info", content: `${esc(name)}  ${esc(meta)}` });
  },

  renderToolExpanded({ pageLines }) {
    for (const line of pageLines) {
      addMsg({ type: "info", content: line });
    }
  },

  info(msg) {
    addMsg({ type: "info", content: msg });
  },

  error(msg) {
    addMsg({ type: "error", content: msg });
  },

  // Native blessed selector — replaces modules/selector.js
  async select(items, opts) {
    return blessedSelect(items, opts);
  },

  async status(opts) {
    return showStatus(opts);
  },

  // Called once to set up input; returns the ask() function used by the main loop
  createAsk(commands) {
    inputCmds = commands;
    cmdHistory.load();
    renderFooter();
    renderInput();

    return function ask() {
      return new Promise((resolve) => {
        inputBuf    = "";
        inputCursor = 0;
        inputActive = true;
        inputResolve = resolve;
        killRingIdx  = -1;
        undoStack.length = 0;
        undoPtr     = -1;
        cmdHistory.reset();
        dropItems   = [];
        dropIdx     = 0;
        renderInput();
      });
    };
  },

  cleanup() {
    if (clockTimer) clearInterval(clockTimer);
    try { screen.destroy(); } catch {}
  },

  saveHistory() {
    cmdHistory.save();
  },
};
