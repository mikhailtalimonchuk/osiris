/**
 * Read a single keypress from stdin in raw mode.
 * Handles multi-byte escape sequences (arrow keys, etc.) by buffering.
 * Returns the full key sequence string.
 * 
 * @param {number} timeoutMs - Timeout in ms (default 30000)
 * @returns {Promise<string>} The key sequence
 */
export function readKey(timeoutMs = 30000) {
  return new Promise((resolve) => {
    let buf = "";
    let timer = null;
    
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cleanup();
        resolve(buf || "\n");
      }, 50); // 50ms to collect full escape sequence
    };
    
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      if (timer) clearTimeout(timer);
    };
    
    const onData = (data) => {
      buf += data.toString();
      
      // If we have a complete escape sequence or a simple key
      if (buf === "\u001b") {
        // Incomplete escape - wait for more
        resetTimer();
        return;
      }
      
      // Complete sequences: \u001b[A, \u001b[B, \u001b[C, \u001b[D, etc.
      if (buf.startsWith("\u001b[")) {
        if (buf.length >= 3 && /[A-Za-z]/.test(buf[buf.length - 1])) {
          cleanup();
          resolve(buf);
          return;
        }
        resetTimer();
        return;
      }
      
      // Simple key (Enter, etc.)
      cleanup();
      resolve(buf);
    };
    
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
    
    // Hard timeout
    timer = setTimeout(() => {
      cleanup();
      resolve(buf || "\n");
    }, timeoutMs);
  });
}

/**
 * Parse a key sequence into a meaningful action.
 * 
 * @param {string} key - The raw key sequence
 * @returns {string} "left", "right", "up", "down", "enter", "escape", or "other"
 */
export function parseKey(key) {
  if (key === "\u001b[D") return "left";
  if (key === "\u001b[C") return "right";
  if (key === "\u001b[A") return "up";
  if (key === "\u001b[B") return "down";
  if (key === "\u001b") return "escape";
  if (key === "\r" || key === "\n") return "enter";
  return "other";
}
