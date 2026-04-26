import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const R      = "\x1b[0m";
const DIM    = "\x1b[2m";
const BGREEN = "\x1b[92m";
const CYAN   = "\x1b[36m";

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// History stored as JSONL: one {"ts":timestamp,"text":"..."} per line
const HISTORY_FILE = path.join(os.homedir(), ".osiris", "history");
const ONE_DAY_MS   = 24 * 60 * 60 * 1000;

const history = {
  entries: [], // { ts: number, text: string }[]
  maxSize: 1000,
  index: -1,

  load() {
    try {
      if (!fs.existsSync(HISTORY_FILE)) return;
      const cutoff = Date.now() - ONE_DAY_MS;
      const raw    = fs.readFileSync(HISTORY_FILE, "utf-8");
      const parsed = [];
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (e.ts >= cutoff && e.text) parsed.push(e);
        } catch { /* skip malformed lines */ }
      }
      this.entries = parsed.slice(-this.maxSize);
    } catch {
      this.entries = [];
    }
    this.index = -1;
  },

  save() {
    try {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fs.writeFileSync(
        HISTORY_FILE,
        this.entries.map(e => JSON.stringify(e)).join("\n") + "\n",
        "utf-8"
      );
    } catch { /* ignore write errors */ }
  },

  add(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.entries[this.entries.length - 1]?.text === trimmed) return;
    this.entries.push({ ts: Date.now(), text: trimmed });
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
  get length() { return this.entries.length; },
};

/**
 * Load command-line history from disk (call once at app startup).
 */
export function loadCommandHistory() {
  history.load();
}

/**
 * Save command-line history to disk (call on app exit).
 */
export function saveCommandHistory() {
  history.save();
}

export function getHistory() {
  return history;
}

export function createAsk(commands) {
  return (promptStr) => new Promise((resolve, reject) => {
    let buf      = "";
    let cursor   = 0; // cursor position within buf (0 = start, buf.length = end)
    let dropIdx  = 0;
    let dropItems = [];
    const pLen   = stripAnsi(promptStr).length;

    history.reset();

    const updateDrop = () => {
      dropItems = buf.startsWith("/")
        ? commands.filter(c => c.startsWith(buf))
        : [];
      if (dropIdx >= dropItems.length) dropIdx = 0;
    };

    const render = () => {
      // Build the visible line: prompt + text before cursor + text after cursor
      const before = buf.slice(0, cursor);
      const after  = buf.slice(cursor);
      let out = `\r\x1b[J${promptStr}${before}${after}`;

      // Render autocomplete dropdown
      for (let i = 0; i < dropItems.length; i++) {
        out += `\n\x1b[2K  `;
        out += i === dropIdx
          ? `${BGREEN}▶${R} ${CYAN}${dropItems[i]}${R}`
          : `  ${DIM}${dropItems[i]}${R}`;
      }

      // Move cursor to correct position
      if (dropItems.length) {
        // When dropdown is open, position cursor at end of input + dropdown height
        out += `\x1b[${dropItems.length}A\r\x1b[${pLen + buf.length}C`;
      } else {
        // No dropdown — position cursor within the line
        out += `\x1b[${pLen + cursor}G`;
      }

      process.stdout.write(out);
    };

    const done = (value) => {
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      // Add non-empty input to history
      history.add(value);
      process.stdout.write(`\r\x1b[J${promptStr}${value}\n`);
      resolve(value);
    };

    const insertChar = (ch) => {
      buf = buf.slice(0, cursor) + ch + buf.slice(cursor);
      cursor++;
      updateDrop();
      render();
    };

    const deleteForward = () => {
      if (cursor < buf.length) {
        buf = buf.slice(0, cursor) + buf.slice(cursor + 1);
        updateDrop();
        render();
      }
    };

    const deleteBack = () => {
      if (cursor > 0) {
        buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
        cursor--;
        updateDrop();
        render();
      }
    };

    const moveLeft = () => {
      if (cursor > 0) { cursor--; render(); }
    };

    const moveRight = () => {
      if (cursor < buf.length) { cursor++; render(); }
    };

    const moveHome = () => {
      cursor = 0;
      render();
    };

    const moveEnd = () => {
      cursor = buf.length;
      render();
    };

    const onKey = (ch, key) => {
      if (!key) {
        const c = ch ?? "";
        if (c && c.charCodeAt(0) >= 32) { insertChar(c); }
        return;
      }

      if (key.ctrl && key.name === "c") { process.stdout.write("\n"); process.exit(0); }

      if (key.ctrl && key.name === "d" && !buf) {
        process.stdin.removeListener("keypress", onKey);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdout.write("\n");
        reject(new Error("EOF"));
        return;
      }

      if (key.ctrl && key.name === "u") { buf = ""; cursor = 0; updateDrop(); render(); return; }

      if (key.ctrl && key.name === "a") { moveHome(); return; } // Ctrl+A = home
      if (key.ctrl && key.name === "e") { moveEnd(); return; }  // Ctrl+E = end
      if (key.ctrl && key.name === "f") { moveRight(); return; } // Ctrl+F = forward
      if (key.ctrl && key.name === "b") { moveLeft(); return; }  // Ctrl+B = backward
      if (key.ctrl && key.name === "h") { deleteBack(); return; } // Ctrl+H = backspace
      if (key.ctrl && key.name === "w") {
        // Ctrl+W: delete word backward
        const beforeCursor = buf.slice(0, cursor);
        const match = beforeCursor.match(/(\S+)\s*$/);
        if (match) {
          buf = buf.slice(0, cursor - match[0].length) + buf.slice(cursor);
          cursor -= match[0].length;
          updateDrop();
          render();
        }
        return;
      }

      if (key.name === "return") {
        done(dropItems.length ? dropItems[dropIdx] : buf);
        return;
      }

      if (key.name === "backspace") {
        deleteBack();
        return;
      }

      if (key.name === "delete") {
        deleteForward();
        return;
      }

      if (key.name === "left") {
        if (dropItems.length) {
          // If dropdown is open, left arrow does nothing (or could close it)
          return;
        }
        moveLeft();
        return;
      }

      if (key.name === "right") {
        if (dropItems.length) {
          // If dropdown is open, right arrow does nothing
          return;
        }
        moveRight();
        return;
      }

      if (key.name === "home") {
        moveHome();
        return;
      }

      if (key.name === "end") {
        moveEnd();
        return;
      }

      if (key.name === "up") {
        if (dropItems.length) {
          dropIdx = (dropIdx - 1 + dropItems.length) % dropItems.length;
          render();
        } else {
          // Navigate command history
          const prev = history.prev();
          if (prev !== null) {
            buf = prev;
            cursor = buf.length;
            updateDrop();
            render();
          }
        }
        return;
      }

      if (key.name === "down") {
        if (dropItems.length) {
          dropIdx = (dropIdx + 1) % dropItems.length;
          render();
        } else {
          // Navigate command history forward
          const next = history.next();
          buf = next;
          cursor = buf.length;
          updateDrop();
          render();
        }
        return;
      }

      if (key.name === "escape") { dropItems = []; dropIdx = 0; render(); return; }

      if (key.name === "tab" && dropItems.length) {
        buf = dropItems[dropIdx];
        cursor = buf.length;
        dropItems = [];
        render();
        return;
      }

      const c = ch ?? key.sequence ?? "";
      if (c && !key.ctrl && !key.meta && c.charCodeAt(0) >= 32) {
        insertChar(c);
      }
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKey);
    process.stdout.write(promptStr);
  });
}
