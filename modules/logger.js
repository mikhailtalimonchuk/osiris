// Singleton debug logger — writes to stderr so it never pollutes piped stdout.
// Call logger.enable() once (after parsing --debug) to activate all output.

const DIM   = "\x1b[2m";
const CYAN  = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const R     = "\x1b[0m";

let _on = false;

function line(color, tag, msg) {
  process.stderr.write(`${DIM}[${R}${color}${tag}${R}${DIM}]${R} ${msg}\n`);
}

export const logger = {
  enable() { _on = true; },
  active()  { return _on; },

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
};
