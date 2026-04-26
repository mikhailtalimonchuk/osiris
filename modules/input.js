import readline from "node:readline";

const R      = "\x1b[0m";
const DIM    = "\x1b[2m";
const BGREEN = "\x1b[92m";
const CYAN   = "\x1b[36m";

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function createAsk(commands) {
  return (promptStr) => new Promise((resolve, reject) => {
    let buf      = "";
    let dropIdx  = 0;
    let dropItems = [];
    const pLen   = stripAnsi(promptStr).length;

    const updateDrop = () => {
      dropItems = buf.startsWith("/")
        ? commands.filter(c => c.startsWith(buf))
        : [];
      if (dropIdx >= dropItems.length) dropIdx = 0;
    };

    const render = () => {
      let out = `\r\x1b[J${promptStr}${buf}`;
      for (let i = 0; i < dropItems.length; i++) {
        out += `\n\x1b[2K  `;
        out += i === dropIdx
          ? `${BGREEN}▶${R} ${CYAN}${dropItems[i]}${R}`
          : `  ${DIM}${dropItems[i]}${R}`;
      }
      if (dropItems.length) {
        out += `\x1b[${dropItems.length}A\r\x1b[${pLen + buf.length}C`;
      }
      process.stdout.write(out);
    };

    const done = (value) => {
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(`\r\x1b[J${promptStr}${value}\n`);
      resolve(value);
    };

    const onKey = (ch, key) => {
      if (!key) {
        const c = ch ?? "";
        if (c && c.charCodeAt(0) >= 32) { buf += c; updateDrop(); render(); }
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

      if (key.ctrl && key.name === "u") { buf = ""; updateDrop(); render(); return; }

      if (key.name === "return") {
        done(dropItems.length ? dropItems[dropIdx] : buf);
        return;
      }

      if (key.name === "backspace") {
        if (buf) { buf = buf.slice(0, -1); updateDrop(); render(); }
        return;
      }

      if (key.name === "up") {
        if (dropItems.length) { dropIdx = (dropIdx - 1 + dropItems.length) % dropItems.length; render(); }
        return;
      }

      if (key.name === "down") {
        if (dropItems.length) { dropIdx = (dropIdx + 1) % dropItems.length; render(); }
        return;
      }

      if (key.name === "escape") { dropItems = []; dropIdx = 0; render(); return; }

      if (key.name === "tab" && dropItems.length) {
        buf = dropItems[dropIdx];
        dropItems = [];
        render();
        return;
      }

      const c = ch ?? key.sequence ?? "";
      if (c && !key.ctrl && !key.meta && c.charCodeAt(0) >= 32) {
        buf += c;
        updateDrop();
        render();
      }
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKey);
    process.stdout.write(promptStr);
  });
}
