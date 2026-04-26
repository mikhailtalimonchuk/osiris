// Minimal template — plain text with green request time
const GREEN = "\x1b[32m";
const R = "\x1b[0m";

export default {
  prompt: "> ",

  welcome({ baseUrl, model }) {
    process.stdout.write(`osiris | ${baseUrl} | ${model}\n`);
    process.stdout.write("Commands: /exit /reset /save /history\n\n");
  },

  response(text, stats) {
    process.stdout.write(text + "\n");
    if (stats) {
      const elapsed = (stats.elapsedMs / 1000).toFixed(2);
      process.stdout.write(`${GREEN}${elapsed}s${R}\n`);
    }
  },

  streamStart() {},

  streamEnd(stats) {
    if (stats) {
      const elapsed = (stats.elapsedMs / 1000).toFixed(2);
      process.stdout.write(`${GREEN}${elapsed}s${R}\n`);
    }
  },

  info(msg) {
    process.stdout.write(msg + "\n");
  },

  error(msg) {
    process.stderr.write("Error: " + msg + "\n");
  },
};
