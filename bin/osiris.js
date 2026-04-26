#!/usr/bin/env node
import { logger }                                    from "../modules/logger.js";
import { loadConfig }                                from "../modules/config.js";
import { parseArgs, helpText }                       from "../modules/args.js";
import { chatOnce, fetchFirstModel, fetchAllModels, fetchAvailableModels, unloadModel, loadModel, getApiRoot } from "../modules/chat.js";
import { loadHistory, saveHistory }                  from "../modules/history.js";
import { select }                                    from "../modules/selector.js";
import { createAsk }                                 from "../modules/input.js";

const COMMANDS = ["/exit", "/reset", "/history", "/save", "/status", "/models"];

const CONFIG_MAP = [
  ["baseUrl",     "baseUrl",     v => v],
  ["model",       "model",       v => v],
  ["system",      "system",      v => v],
  ["temperature", "temperature", v => Number(v)],
  ["maxTokens",   "maxTokens",   v => Number(v)],
  ["stream",      "stream",      v => Boolean(v)],
  ["timeout",     "timeoutMs",   v => Math.floor(Number(v) * 1000)],
  ["history",     "history",     v => v],
  ["template",    "template",    v => v],
];

function startSpinner(label) {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  const DIM = "\x1b[2m", R = "\x1b[0m";
  let i = 0;
  const t0 = Date.now();
  const iv = setInterval(() => {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r${DIM}  ${frames[i++ % frames.length]} ${label}  ${s}s${R}`);
  }, 80);
  return () => { clearInterval(iv); process.stdout.write("\r\x1b[2K"); };
}

async function loadTemplate(name) {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`Invalid template name: "${name}"`);
  try {
    const { default: tpl } = await import(new URL(`../templates/${name}.js`, import.meta.url));
    return tpl;
  } catch {
    throw new Error(`Template "${name}" not found. Available: default, fancy, minimal`);
  }
}

async function run() {
  const { args, explicit } = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(helpText() + "\n");
    process.exit(0);
  }

  // Enable debug logger as early as possible so every subsequent step is visible
  if (args.debug) {
    logger.enable();
    logger.step("debug", "debug mode enabled");
    logger.json("args:cli", { ...args, debug: true });
    logger.json("args:explicit", [...explicit]);
  }

  // Config files fill in any arg the user did not set explicitly on the CLI
  logger.step("config", "loading config files…");
  const config = loadConfig();
  for (const [cfgKey, argKey, transform] of CONFIG_MAP) {
    if (!explicit.has(argKey) && config[cfgKey] !== undefined) {
      args[argKey] = transform(config[cfgKey]);
    }
  }
  logger.json("args:final", args);

  // Load the display template before doing any I/O
  logger.step("template", `loading template: "${args.template}"`);
  let tpl;
  try {
    tpl = await loadTemplate(args.template);
    logger.ok("template", `loaded: "${args.template}"`);
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exit(1);
  }

  // Auto-detect model if not provided
  if (!args.model) {
    logger.step("models", `no model set — querying ${args.baseUrl}`);
    args.model = await fetchFirstModel(args.baseUrl, args.timeoutMs);
    if (!args.model) {
      tpl.error("Cannot load model in LM Studio. Load a model or pass --model.");
      process.exit(1);
    }
    tpl.info(`Auto-selected model: ${args.model}`);
  } else {
    logger.ok("models", `model set explicitly: ${args.model}`);
  }

  // Build the initial message list (load history if requested)
  let messages = [{ role: "system", content: args.system }];
  if (args.history) {
    logger.step("history", `loading history from: ${args.history}`);
    try {
      const hist = loadHistory(args.history);
      if (hist?.length && hist[0]?.role === "system") {
        messages = hist;
        logger.ok("history", `resumed session — ${hist.length} message(s)`);
      } else if (hist) {
        messages = messages.concat(hist);
        logger.ok("history", `appended ${hist.length} message(s) to new session`);
      } else {
        logger.step("history", "history file not found — starting fresh");
      }
    } catch (e) {
      tpl.error(`Failed to load history: ${e?.message ?? String(e)}`);
      process.exit(2);
    }
  }

  // Non-interactive single-shot mode
  if (args.once) {
    logger.step("run", `--once mode: "${args.once}"`);
    messages.push({ role: "user", content: args.once });
    try {
      if (args.stream) tpl.streamStart?.();
      const { text: assistant, stats } = await chatOnce({ ...args, messages });
      if (args.stream) tpl.streamEnd?.(stats);
      else tpl.response(assistant, stats);
      messages.push({ role: "assistant", content: assistant });
      if (args.history) { try { saveHistory(args.history, messages); } catch {} }
    } catch (e) {
      tpl.error(`Request failed: ${e?.message ?? String(e)}`);
      process.exit(1);
    }
    return;
  }

  // Interactive loop
  logger.step("run", "entering interactive loop");
  tpl.welcome({ baseUrl: args.baseUrl, model: args.model });

  const ask = createAsk(COMMANDS);

  const sessionStart = Date.now();
  const sessionStats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };

  while (true) {
    let user;
    try {
      user = String(await ask(tpl.prompt)).trim();
    } catch {
      break;
    }

    if (!user) continue;

    if (user === "/exit" || user === "/quit") break;

    if (user === "/reset") {
      messages = [{ role: "system", content: args.system }];
      tpl.info("history reset");
      continue;
    }

    if (user === "/history") {
      process.stdout.write(JSON.stringify(messages, null, 2) + "\n");
      continue;
    }

    if (user === "/save") {
      if (!args.history) { tpl.info("no --history path provided"); continue; }
      try {
        saveHistory(args.history, messages);
        tpl.info(`saved to ${args.history}`);
      } catch (e) {
        tpl.error(`failed to save: ${e?.message ?? String(e)}`);
      }
      continue;
    }

    if (user === "/status") {
      tpl.status?.({ sessionStart, sessionStats, model: args.model, baseUrl: args.baseUrl });
      continue;
    }

    if (user === "/models") {
      tpl.info(`API root: ${getApiRoot(args.baseUrl)}`);

      let stopSpinner = startSpinner("fetching available models");
      const models = await fetchAvailableModels(args.baseUrl, args.timeoutMs);
      stopSpinner();

      if (!models.length) { tpl.error("No models returned — check LM Studio version supports /api/v0/models"); continue; }
      tpl.info(`${models.length} model(s) found`);

      const picked = await select(models, { label: `select a model  (loaded: ${args.model}):` });
      if (!picked || picked === args.model) continue;

      stopSpinner = startSpinner(`unloading  ${args.model}`);
      try {
        await unloadModel(args.baseUrl, args.model, args.timeoutMs);
        stopSpinner();
        tpl.info("unloaded");
      } catch (e) {
        stopSpinner();
        tpl.error(`Unload failed: ${e?.message ?? String(e)}`);
      }

      stopSpinner = startSpinner(`loading  ${picked}`);
      try {
        await loadModel(args.baseUrl, picked);
        stopSpinner();
        args.model = picked;
        tpl.info(`Model → ${picked}`);
      } catch (e) {
        stopSpinner();
        tpl.error(`Load failed: ${e?.message ?? String(e)}`);
      }
      continue;
    }

    messages.push({ role: "user", content: user });
    try {
      if (args.stream) tpl.streamStart?.();
      const { text: assistant, stats } = await chatOnce({ ...args, messages });
      if (args.stream) tpl.streamEnd?.(stats);
      else tpl.response(assistant, stats);
      messages.push({ role: "assistant", content: assistant });
      sessionStats.requests      += 1;
      sessionStats.promptTokens     += stats.promptTokens;
      sessionStats.completionTokens += stats.completionTokens;
      sessionStats.totalTokens      += stats.totalTokens;
      if (args.history) { try { saveHistory(args.history, messages); } catch {} }
    } catch (e) {
      messages.pop(); // remove last user message so the turn can be retried cleanly
      tpl.error(`Request failed: ${e?.message ?? String(e)}`);
    }
  }

  process.stdin.pause();
  if (args.history) { try { saveHistory(args.history, messages); } catch {} }
}

run().catch((e) => {
  process.stderr.write((e?.stack ?? String(e)) + "\n");
  process.exit(1);
});
