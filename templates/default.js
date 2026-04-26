// Clean template — subtle ANSI color, no box drawing
const R = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

export default {
  prompt: `${CYAN}›${R} `,

  welcome({ baseUrl, model }) {
    const sep = `${DIM}${"─".repeat(52)}${R}`;
    process.stdout.write(`\n${BOLD}  osiris${R}  ${DIM}LM Studio CLI Agent${R}\n`);
    process.stdout.write(`${sep}\n`);
    process.stdout.write(`  ${DIM}url  ${R}${baseUrl}\n`);
    process.stdout.write(`  ${DIM}mdl  ${R}${model}\n`);
    process.stdout.write(`${sep}\n`);
    process.stdout.write(`  ${DIM}commands: /exit  /reset  /save  /history${R}\n\n`);
  },

  response(text) {
    process.stdout.write(`\n${GREEN}${text}${R}\n\n`);
  },

  streamStart() {
    process.stdout.write(`\n${GREEN}`);
  },

  streamEnd() {
    process.stdout.write(`${R}\n`);
  },

  info(msg) {
    process.stdout.write(`${DIM}  ${msg}${R}\n`);
  },

  error(msg) {
    process.stderr.write(`${RED}  ✖ ${msg}${R}\n`);
  },
};
