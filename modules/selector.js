import readline from "node:readline";

const R      = "\x1b[0m";
const DIM    = "\x1b[2m";
const BGREEN = "\x1b[92m";
const CYAN   = "\x1b[36m";

export async function select(items, { label = "" } = {}) {
  if (!items.length) return null;

  return new Promise((resolve) => {
    let idx = 0;
    const lineCount = items.length + (label ? 1 : 0);

    const render = (first) => {
      if (!first) process.stdout.write(`\x1b[${lineCount}A`);
      if (label) process.stdout.write(`\x1b[2K${DIM}  ${label}${R}\n`);
      for (let i = 0; i < items.length; i++) {
        process.stdout.write("\x1b[2K");
        process.stdout.write(i === idx
          ? `  ${BGREEN}▶${R} ${CYAN}${items[i]}${R}\n`
          : `    ${DIM}${items[i]}${R}\n`
        );
      }
    };

    const cleanup = (result) => {
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(`\x1b[${lineCount}A\x1b[J`);
      resolve(result);
    };

    const onKey = (_ch, key) => {
      if (!key) return;
      if      (key.name === "up")                { idx = (idx - 1 + items.length) % items.length; render(false); }
      else if (key.name === "down")              { idx = (idx + 1) % items.length; render(false); }
      else if (key.name === "return")            { cleanup(items[idx]); }
      else if (key.name === "escape")            { cleanup(null); }
      else if (key.ctrl && key.name === "c")     { cleanup(null); process.exit(0); }
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKey);
    render(true);
  });
}
