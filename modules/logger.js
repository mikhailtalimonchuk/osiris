// Singleton debug logger — writes to stderr AND optionally to a log file.
// Call logger.enable() once (after parsing --debug) to activate all output.
// Call logger.setLogFile(path) to enable file logging.

import fs from "node:fs";
import path from "node:path";

const DIM   = "\x1b[2m";
const CYAN  = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const R     = "\x1b[0m";

let _on = false;
let _logFile = null;   // fs write stream (null = file logging disabled)

function timestamp() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function writeToFile(tag, msg) {
  if (!_logFile) return;
  const line = `[${timestamp()}] [${tag}] ${msg.replace(/\x1b\[[0-9;]*m/g, "")}\n`;
  _logFile.write(line);
}

function line(color, tag, msg) {
  process.stderr.write(`${DIM}[${R}${color}${tag}${R}${DIM}]${R} ${msg}\n`);
  writeToFile(tag, msg);
}

export const logger = {
  enable() { _on = true; },
  active()  { return _on; },

  /** Set a log file path; subsequent debug output is appended there. */
  setLogFile(filePath) {
    if (_logFile) { _logFile.end(); _logFile = null; }
    if (!filePath) return;
    const abs = path.resolve(filePath);
    _logFile = fs.createWriteStream(abs, { flags: "a" });
    _logFile.write(`\n=== osiris debug session started at ${new Date().toISOString()} ===\n`);
  },

  step(tag, msg)  { if (_on) line(CYAN,   tag, msg); },
  ok(tag, msg)    { if (_on) line(CYAN,   tag, `\x1b[32m✔\x1b[0m ${msg}`); },
  warn(tag, msg)  { if (_on) line(YELLOW, tag, `\x1b[33m⚠\x1b[0m ${msg}`); },
  fail(tag, msg)  { if (_on) line(RED,    tag, `\x1b[31m✖\x1b[0m ${msg}`); },

  json(tag, obj) {
    if (!_on) return;
    const body = JSON.stringify(obj, null, 2)
      .split("\n")
      .map(l => `  ${l}`)
      .join("\n");
    line(CYAN, tag, "\n" + body);
  },

  /** Log a user input line (for input/output audit trail). */
  input(msg) {
    if (!_on) return;
    line(CYAN, "input", `user: ${msg}`);
  },

  /** Log an assistant output line (for input/output audit trail). */
  output(msg) {
    if (!_on) return;
    // Truncate very long outputs for the log
    const truncated = msg.length > 2000 ? msg.slice(0, 2000) + "\n… (truncated)" : msg;
    line(CYAN, "output", truncated);
  },
};
