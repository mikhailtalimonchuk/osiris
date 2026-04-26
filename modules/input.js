import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const R      = "\x1b[0m";
const DIM    = "\x1b[2m";
const BGREEN = "\x1b[92m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";

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

/**
 * Find the start of the word at or before position `pos` in `str`.
 * Words are sequences of non-whitespace characters.
 */
function wordStart(str, pos) {
  while (pos > 0 && /\s/.test(str[pos - 1])) pos--;
  while (pos > 0 && !/\s/.test(str[pos - 1])) pos--;
  return pos;
}

/**
 * Find the end of the word at or after position `pos` in `str`.
 */
function wordEnd(str, pos) {
  while (pos < str.length && !/\s/.test(str[pos])) pos++;
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  return pos;
}

export function createAsk(commands) {
  return (promptStr) => new Promise((resolve, reject) => {
    let buf      = "";
    let cursor   = 0; // cursor position within buf (0 = start, buf.length = end)
    let dropIdx  = 0;
    let dropItems = [];

    // Kill ring: stack of killed text segments
    const killRing = [];
    let killRingIndex = -1;

    // Undo stack: snapshots of { buf, cursor } for Ctrl+_ undo
    const undoStack = [];
    let undoPointer = -1;

    // Reverse search state
    let searchMode = false;
    let searchBuf = "";
    let searchIndex = -1; // index into history.entries (searched from newest)

    const pLen   = stripAnsi(promptStr).length;

    history.reset();

    const updateDrop = () => {
      dropItems = buf.startsWith("/")
        ? commands.filter(c => c.startsWith(buf))
        : [];
      if (dropIdx >= dropItems.length) dropIdx = 0;
    };

    /**
     * Save an undo snapshot (avoid duplicates of identical state).
     */
    const pushUndo = () => {
      // Trim any redo states beyond current pointer
      if (undoPointer < undoStack.length - 1) {
        undoStack.length = undoPointer + 1;
      }
      // Avoid pushing duplicate state
      const top = undoStack[undoStack.length - 1];
      if (top && top.buf === buf && top.cursor === cursor) return;
      undoStack.push({ buf, cursor });
      undoPointer = undoStack.length - 1;
      // Cap undo history at 200 entries
      if (undoStack.length > 200) {
        undoStack.shift();
        undoPointer--;
      }
    };

    /**
     * Undo: Ctrl+_ or Ctrl+X Ctrl+U
     */
    const undo = () => {
      if (undoPointer > 0) {
        undoPointer--;
        const snap = undoStack[undoPointer];
        buf = snap.buf;
        cursor = snap.cursor;
        updateDrop();
        render();
      }
    };

    /**
     * Redo: Ctrl+G (after undo)
     */
    const redo = () => {
      if (undoPointer < undoStack.length - 1) {
        undoPointer++;
        const snap = undoStack[undoPointer];
        buf = snap.buf;
        cursor = snap.cursor;
        updateDrop();
        render();
      }
    };

    /**
     * Kill ring operations
     */
    const pushKill = (text) => {
      if (!text) return;
      // If killing adjacent to previous kill, append to same entry
      if (killRing.length > 0 && killRingIndex >= 0) {
        killRing[killRingIndex] += text;
      } else {
        killRing.push(text);
        killRingIndex = killRing.length - 1;
        // Cap kill ring at 50 entries
        if (killRing.length > 50) killRing.shift();
      }
    };

    const yank = () => {
      if (killRing.length === 0) return;
      const text = killRing[killRingIndex] ?? killRing[killRing.length - 1];
      buf = buf.slice(0, cursor) + text + buf.slice(cursor);
      cursor += text.length;
      updateDrop();
      render();
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

      // Render reverse search indicator
      if (searchMode) {
        out += `\n\x1b[2K  ${YELLOW}(reverse-i-search)`;
        out += `'${searchBuf}': ${R}${RED}${history.entries[searchIndex]?.text ?? ""}${R}`;
      }

      // Move cursor to correct position
      if (dropItems.length) {
        // When dropdown is open, position cursor at end of input + dropdown height
        const extraLines = searchMode ? 1 : 0;
        out += `\x1b[${dropItems.length + extraLines}A\r\x1b[${pLen + buf.length}C`;
      } else if (searchMode) {
        // Search mode: cursor at end of search result line
        out += `\x1b[1A\r\x1b[${pLen + (history.entries[searchIndex]?.text?.length ?? 0)}C`;
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
      pushUndo();
      buf = buf.slice(0, cursor) + ch + buf.slice(cursor);
      cursor++;
      updateDrop();
      render();
    };

    const deleteForward = () => {
      if (cursor < buf.length) {
        pushUndo();
        pushKill(buf[cursor]);
        buf = buf.slice(0, cursor) + buf.slice(cursor + 1);
        updateDrop();
        render();
      }
    };

    const deleteBack = () => {
      if (cursor > 0) {
        pushUndo();
        pushKill(buf[cursor - 1]);
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

    /**
     * Move cursor forward by one word (Alt+F)
     */
    const moveWordForward = () => {
      const end = wordEnd(buf, cursor);
      if (end !== cursor) {
        cursor = end;
        render();
      }
    };

    /**
     * Move cursor backward by one word (Alt+B)
     */
    const moveWordBackward = () => {
      const start = wordStart(buf, cursor);
      if (start !== cursor) {
        cursor = start;
        render();
      }
    };

    /**
     * Transpose characters: swap char at cursor with char before it (Ctrl+T)
     */
    const transposeChars = () => {
      if (buf.length < 2) return;
      pushUndo();
      // If cursor is at end, swap last two chars
      if (cursor === buf.length) {
        const i = cursor - 1;
        buf = buf.slice(0, i - 1) + buf[i] + buf[i - 1] + buf.slice(i + 1);
        cursor = i + 1;
      } else if (cursor > 0) {
        // Swap char before cursor with char at cursor
        const i = cursor - 1;
        buf = buf.slice(0, i) + buf[i + 1] + buf[i] + buf.slice(i + 2);
        cursor = i + 2;
      }
      updateDrop();
      render();
    };

    /**
     * Kill from cursor to end of line (Ctrl+K)
     */
    const killLine = () => {
      if (cursor < buf.length) {
        pushUndo();
        const killed = buf.slice(cursor);
        pushKill(killed);
        buf = buf.slice(0, cursor);
        updateDrop();
        render();
      }
    };

    /**
     * Kill from cursor to start of line (Ctrl+U — already exists, but now uses kill ring)
     */
    const killWholeLine = () => {
      if (buf.length > 0) {
        pushUndo();
        pushKill(buf);
        buf = "";
        cursor = 0;
        updateDrop();
        render();
      }
    };

    /**
     * Reverse incremental search (Ctrl+R)
     */
    const startReverseSearch = () => {
      searchMode = true;
      searchBuf = "";
      searchIndex = -1;
      render();
    };

    /**
     * Handle keystrokes during reverse search
     */
    const handleSearchInput = (ch, key) => {
      if (key?.name === "escape" || key?.ctrl && key.name === "g") {
        // Cancel search
        searchMode = false;
        searchBuf = "";
        searchIndex = -1;
        render();
        return;
      }

      if (key?.name === "return") {
        // Accept search result
        if (searchIndex >= 0) {
          buf = history.entries[searchIndex].text;
          cursor = buf.length;
        }
        searchMode = false;
        searchBuf = "";
        searchIndex = -1;
        updateDrop();
        render();
        return;
      }

      if (key?.name === "up") {
        // Find previous match
        searchBuf = searchBuf; // keep current search string
        // Search backward from current position
        let found = false;
        for (let i = searchIndex - 1; i >= 0; i--) {
          if (history.entries[i].text.toLowerCase().includes(searchBuf.toLowerCase())) {
            searchIndex = i;
            found = true;
            break;
          }
        }
        if (!found && searchBuf) {
          // Wrap around to end
          for (let i = history.entries.length - 1; i >= 0; i--) {
            if (history.entries[i].text.toLowerCase().includes(searchBuf.toLowerCase())) {
              searchIndex = i;
              break;
            }
          }
        }
        render();
        return;
      }

      if (key?.name === "down") {
        // Find next match
        let found = false;
        for (let i = searchIndex + 1; i < history.entries.length; i++) {
          if (history.entries[i].text.toLowerCase().includes(searchBuf.toLowerCase())) {
            searchIndex = i;
            found = true;
            break;
          }
        }
        if (!found && searchBuf) {
          // Wrap around to start
          for (let i = 0; i < history.entries.length; i++) {
            if (history.entries[i].text.toLowerCase().includes(searchBuf.toLowerCase())) {
              searchIndex = i;
              break;
            }
          }
        }
        render();
        return;
      }

      if (key?.name === "backspace" || (key?.ctrl && key.name === "h")) {
        if (searchBuf.length > 0) {
          searchBuf = searchBuf.slice(0, -1);
          // Re-search with new (shorter) query
          searchIndex = -1;
          for (let i = history.entries.length - 1; i >= 0; i--) {
            if (history.entries[i].text.toLowerCase().includes(searchBuf.toLowerCase())) {
              searchIndex = i;
              break;
            }
          }
        }
        render();
        return;
      }

      if (key?.ctrl && key.name === "j") {
        // Ctrl+J during search: accept current result and return to editing
        if (searchIndex >= 0) {
          buf = history.entries[searchIndex].text;
          cursor = buf.length;
        }
        searchMode = false;
        searchBuf = "";
        searchIndex = -1;
        updateDrop();
        render();
        return;
      }

      // Regular character input — add to search buffer
      if (ch && !key?.ctrl && !key?.meta && ch.charCodeAt(0) >= 32) {
        searchBuf += ch;
        // Search for first match (newest first)
        searchIndex = -1;
        for (let i = history.entries.length - 1; i >= 0; i--) {
          if (history.entries[i].text.toLowerCase().includes(searchBuf.toLowerCase())) {
            searchIndex = i;
            break;
          }
        }
        render();
      }
    };

    const onKey = (ch, key) => {
      // If in reverse search mode, delegate to search handler
      if (searchMode) {
        handleSearchInput(ch, key);
        return;
      }

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

      // Ctrl+U: kill whole line (now uses kill ring)
      if (key.ctrl && key.name === "u") { killWholeLine(); return; }

      // Ctrl+K: kill from cursor to end of line
      if (key.ctrl && key.name === "k") { killLine(); return; }

      // Ctrl+Y: yank (paste) from kill ring
      if (key.ctrl && key.name === "y") { yank(); return; }

      // Ctrl+_: undo
      if (key.ctrl && key.name === "_") { undo(); return; }

      // Ctrl+T: transpose characters
      if (key.ctrl && key.name === "t") { transposeChars(); return; }

      // Ctrl+R: reverse incremental search
      if (key.ctrl && key.name === "r") { startReverseSearch(); return; }

      // Ctrl+A = home
      if (key.ctrl && key.name === "a") { moveHome(); return; }
      // Ctrl+E = end
      if (key.ctrl && key.name === "e") { moveEnd(); return; }
      // Ctrl+F = forward
      if (key.ctrl && key.name === "f") { moveRight(); return; }
      // Ctrl+B = backward
      if (key.ctrl && key.name === "b") { moveLeft(); return; }
      // Ctrl+H = backspace
      if (key.ctrl && key.name === "h") { deleteBack(); return; }
      // Ctrl+W: delete word backward
      if (key.ctrl && key.name === "w") {
        const beforeCursor = buf.slice(0, cursor);
        const match = beforeCursor.match(/(\S+)\s*$/);
        if (match) {
          pushUndo();
          pushKill(match[0]);
          buf = buf.slice(0, cursor - match[0].length) + buf.slice(cursor);
          cursor -= match[0].length;
          updateDrop();
          render();
        }
        return;
      }

      // Alt+F: move forward by word
      if (key.meta && key.name === "f") { moveWordForward(); return; }
      // Alt+B: move backward by word
      if (key.meta && key.name === "b") { moveWordBackward(); return; }

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
          return;
        }
        moveLeft();
        return;
      }

      if (key.name === "right") {
        if (dropItems.length) {
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
            pushUndo();
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
          pushUndo();
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
