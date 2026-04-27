/** Enable SGR extended mouse tracking (reports button, col, row on click). */
export function enableMouse()  { process.stdout.write("\x1b[?1000h\x1b[?1006h"); }

/** Disable mouse tracking and restore normal input. */
export function disableMouse() { process.stdout.write("\x1b[?1000l\x1b[?1006l"); }

/**
 * Read a single keypress (or mouse click) from stdin in raw mode.
 * Handles multi-byte escape sequences (arrow keys, SGR mouse events, etc.).
 * Returns the full sequence string, or null on timeout.
 *
 * @param {number} timeoutMs - Timeout in ms (default 30000). 0 = wait forever.
 * @returns {Promise<string|null>} The key sequence, or null on timeout.
 */
export function readKey(timeoutMs = 30000) {
  return new Promise((resolve) => {
    let buf = "";
    let seqTimer  = null; // 50ms debounce for partial escape sequences
    let hardTimer = null; // outer hard timeout

    const resolveWith = (val) => {
      clearTimeout(seqTimer);
      clearTimeout(hardTimer);
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      resolve(val);
    };

    const flush = () => resolveWith(buf || null);

    const onData = (data) => {
      buf += data.toString();
      clearTimeout(seqTimer);

      if (buf === "") {
        // Lone escape — wait 50ms to see if more bytes follow (e.g. arrow key)
        seqTimer = setTimeout(flush, 50);
        return;
      }

      if (buf.startsWith("[")) {
        // Escape sequence — keep buffering until a letter or ~ terminates it
        if (buf.length >= 3 && /[A-Za-z~]/.test(buf[buf.length - 1])) {
          resolveWith(buf);
        } else {
          seqTimer = setTimeout(flush, 50);
        }
        return;
      }

      // Simple key (printable char, Enter, Ctrl+*, etc.)
      resolveWith(buf);
    };

    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);

    if (timeoutMs > 0) {
      hardTimer = setTimeout(() => resolveWith(null), timeoutMs);
    }
  });
}

/**
 * Parse a raw key sequence into a meaningful action name.
 *
 * @param {string|null} key
 * @returns {string} one of: left right up down enter escape click mouse timeout other
 */
export function parseKey(key) {
  if (key === null)                     return "timeout";
  if (key === "[D")               return "left";
  if (key === "[C")               return "right";
  if (key === "[A")               return "up";
  if (key === "[B")               return "down";
  if (key === "")                 return "escape";
  if (key === "\r" || key === "\n")     return "enter";

  // SGR extended mouse: \x1b[<button;col;rowM (press) or m (release)
  const m = key.match(/\[<(\d+);(\d+);(\d+)([Mm])/);
  if (m) {
    const btn  = parseInt(m[1]) & 0x43; // strip modifier bits, keep button id
    const type = m[4] === "M" ? "press" : "release";
    return (btn === 0 && type === "press") ? "click" : "mouse";
  }

  return "other";
}
