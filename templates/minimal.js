// Minimal template — plain text, no ANSI codes, pipe-friendly
export default {
  prompt: "> ",

  welcome({ baseUrl, model }) {
    process.stdout.write(`osiris | ${baseUrl} | ${model}\n`);
    process.stdout.write("Commands: /exit /reset /save /history\n\n");
  },

  response(text) {
    process.stdout.write(text + "\n");
  },

  streamStart() {},

  streamEnd() {},

  info(msg) {
    process.stdout.write(msg + "\n");
  },

  error(msg) {
    process.stderr.write("Error: " + msg + "\n");
  },
};
