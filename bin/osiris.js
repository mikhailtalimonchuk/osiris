#!/usr/bin/env node
import { logger }                                    from "../modules/logger.js";
import { loadConfig }                                from "../modules/config.js";
import { parseArgs, helpText }                       from "../modules/args.js";
import { chatOnce, fetchFirstModel, fetchAllModels, fetchAvailableModels, unloadModel, loadModel, getApiRoot } from "../modules/chat.js";
import { TOOLS, executeTool, configureToolSandbox, getSandboxInfo, configureToolLimits, getToolLimits } from "../modules/tools.js";
import { loadHistory, saveHistory, saveHistorySafe } from "../modules/history.js";
import { select }                                    from "../modules/selector.js";
import { createAsk, loadCommandHistory, saveCommandHistory } from "../modules/input.js";
import { appendStatSafe, getStatusDir, flushStats }  from "../modules/stats.js";
import { RateLimiter }                               from "../modules/rateLimiter.js";
import { userMessage }                               from "../modules/errorHandler.js";
import { configureToolResultDisplay, displayToolResult, displayToolResultStatic } from "../modules/toolResult.js";

const COMMANDS = ["/exit", "/reset", "/history", "/save", "/status", "/models", "/design"];

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
  // Tool limit config keys
  ["toolFindMaxResults", "toolFindMaxResults", v => Number(v)],
  ["toolReadMaxLines",   "toolReadMaxLines",   v => Number(v)],
  // Tool result display mode
  ["toolResultMode", "toolResultMode", v => v],
  // Security config keys
  ["apiKey",      "apiKey",      v => v],
  ["rateLimit",   "rateLimit",   v => Number(v)],
  ["toolSandbox", "toolSandbox", v => v],
];

const AVAILABLE_TEMPLATES = ["default", "fancy", "minimal"];

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

async function runWithTools({ args, messages, tpl, rateLimiter, toolResultMode }) {
  const msgs      = [...messages]; // working copy — caller's array is not modified here
  const toolMsgs  = [];            // intermediate messages to add to history after

  let streamOpen = false;

  while (true) {
    tpl.thinking?.();

    const { text, stats, toolCalls } = await chatOnce({
      ...args,
      messages: msgs,
      tools: TOOLS,
      rateLimiter,
      // Stop spinner when server first responds (even if tool-only, no text yet)
      onFirstChunk: () => { tpl.thinkingStop?.(); },
      // Open stream border only when actual text content begins flowing
      onFirstContent: () => {
        if (!streamOpen) { tpl.streamStart?.(); streamOpen = true; }
      },
    });

    // For non-stream mode thinkingStop is not yet called; idempotent for stream
    tpl.thinkingStop?.();

    if (toolCalls?.length) {
      if (streamOpen) { tpl.streamCancel?.(); streamOpen = false; }

      const assistantMsg = { role: "assistant", content: text || null, tool_calls: toolCalls };
      msgs.push(assistantMsg);
      toolMsgs.push(assistantMsg);

      for (const call of toolCalls) {
        let callArgs;
        try { callArgs = JSON.parse(call.function.arguments); } catch { callArgs = {}; }
        // Tools are now async — await them so the event loop isn't blocked
        const result = await executeTool(call.function.name, callArgs);

        // Display tool result using the configured mode
        if (toolResultMode === "full") {
          // Always show full result — use template's toolCall if available, else static
          if (tpl.toolCall) {
            tpl.toolCall({ name: call.function.name, args: callArgs, result });
          } else {
            displayToolResultStatic({ name: call.function.name, args: callArgs, result });
          }
        } else if (toolResultMode === "static") {
          // Non-interactive: summary + preview
          displayToolResultStatic({ name: call.function.name, args: callArgs, result });
        } else {
          // Interactive: collapsed summary, press Enter to expand inline
          await displayToolResult({
            name: call.function.name,
            args: callArgs,
            result,
            renderCollapsed: tpl.renderToolCollapsed,
            renderExpanded: tpl.renderToolExpanded,
          });
        }

        const toolMsg = { role: "tool", tool_call_id: call.id, content: result };
        msgs.push(toolMsg);
        toolMsgs.push(toolMsg);
      }
      continue;
    }

    // Final response — display it
    if (streamOpen) { tpl.streamEnd?.(stats); streamOpen = false; }
    else tpl.response(text, stats);

    return { text, stats, toolMsgs };
  }
}

async function loadTemplate(name) {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`Invalid template name: "${name}"`);
  try {
    const { default: tpl } = await import(new URL(`../templates/${name}.js`, import.meta.url));
    return tpl;
  } catch {
    throw new Error(`Template "${name}" not found. Available: ${AVAILABLE_TEMPLATES.join(", ")}`);
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

let _pendingMessages = null;
let _pendingHistory  = null;
let _shuttingDown    = false;

function updatePendingState(messages, historyPath) {
  _pendingMessages = messages;
  _pendingHistory  = historyPath;
}

async function onShutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;

  // Flush any buffered stats to disk before exiting
  await flushStats();
  // Persist command-line history (up/down arrows) to disk
  saveCommandHistory();
  if (_pendingHistory && _pendingMessages) {
    try {
      await saveHistory(_pendingHistory, _pendingMessages);
      logger.ok("shutdown", `history saved to ${_pendingHistory}`);
    } catch (e) {
      logger.error("shutdown", `failed to save history: ${e?.message ?? String(e)}`);
    }
  }
  process.exit(0);
}

process.on("SIGINT",  onShutdown);
process.on("SIGTERM", onShutdown);

async function run() {
  const { args, explicit } = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(helpText() + "\n");
    process.exit(0);
  }

  // Enable debug logger as early as possible so every subsequent step is visible
  if (args.debug) {
    logger.enable();
    logger.setLogFile(".osiris-debug.log");
    logger.step("debug", "debug mode enabled — logging to .osiris-debug.log");
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

  // ── Tool limits: configure from resolved args ─────────────────────────────
  configureToolLimits({
    findMaxResults: args.toolFindMaxResults,
    readMaxLines:   args.toolReadMaxLines,
  });
  logger.ok("tools", `tool limits configured: ${JSON.stringify(getToolLimits())}`);

  // ── Tool result display mode ──────────────────────────────────────────────
  const toolResultMode = args.toolResultMode ?? "interactive";
  configureToolResultDisplay(toolResultMode);
  logger.ok("tools", `tool result mode: ${toolResultMode}`);

  // ── Security: configure tool sandbox ──────────────────────────────────────
  const sandboxMode = args.toolSandbox ?? config.toolSandbox;
  if (sandboxMode) {
    configureToolSandbox(sandboxMode);
    logger.ok("security", `tool sandbox configured: ${JSON.stringify(getSandboxInfo())}`);
  } else {
    configureToolSandbox(process.cwd());
    logger.ok("security", `tool sandbox: default (cwd)`);
  }

  // ── Security: configure rate limiter ──────────────────────────────────────
  const rpm = args.rateLimit ?? 0;
  const rateLimiter = rpm > 0 ? new RateLimiter(rpm) : null;
  if (rateLimiter) {
    logger.ok("security", `rate limiter: ${rpm} req/min`);
  } else {
    logger.step("security", "rate limiter: disabled");
  }

  // ── Security: API key ─────────────────────────────────────────────────────
  if (args.apiKey) {
    logger.ok("security", "API key configured (hidden)");
  }

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
    args.model = await fetchFirstModel(args.baseUrl, args.timeoutMs, args.apiKey);
    if (!args.model) {
      tpl.error("Cannot load model in LM Studio. Load a model or pass --model.");
      process.exit(1);
    }
    tpl.info(`Auto-selected model: ${args.model}`);
  } else {
    logger.ok("models", `model set explicitly: ${args.model}`);
  }

  // Load command-line history (up/down arrow) from disk
  loadCommandHistory();

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
    // Track state for signal-handled shutdown
    updatePendingState(messages, args.history);
  }

  // Stats directory — one file per day under ~/.osiris/status/
  const statusDir = getStatusDir(config.statusDir);

  // Non-interactive single-shot mode
  if (args.once) {
    logger.step("run", `--once mode: "${args.once}"`);
    logger.input(args.once);
    messages.push({ role: "user", content: args.once });
    try {
      const { text: assistant, stats, toolMsgs } = await runWithTools({ args, messages, tpl, rateLimiter, toolResultMode: "static" });
      logger.output(assistant);
      for (const m of toolMsgs) messages.push(m);
      messages.push({ role: "assistant", content: assistant });
      // Update pending state so signal handler can save
      updatePendingState(messages, args.history);
      // Save history (non-fatal — logs error if it fails)
      if (args.history) await saveHistorySafe(args.history, messages);
      // Persist stats (non-fatal — logs error if it fails)
      appendStatSafe(statusDir, { model: args.model, ...stats });
      // Flush stats buffer before exiting
      await flushStats();
    } catch (e) {
      tpl.error(`Request failed: ${userMessage(e)}`);
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

    // Log user input in debug mode
    logger.input(user);

    if (user === "/exit" || user === "/quit") break;

    if (user === "/reset") {
      messages = [{ role: "system", content: args.system }];
      updatePendingState(messages, args.history);
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
        await saveHistory(args.history, messages);
        tpl.info(`saved to ${args.history}`);
      } catch (e) {
        tpl.error(`failed to save: ${userMessage(e)}`);
      }
      continue;
    }

    if (user === "/status") {
      const rateInfo = rateLimiter ? { rpm: args.rateLimit, remaining: rateLimiter.remaining } : { rpm: "unlimited" };
      await tpl.status?.({ sessionStart, sessionStats, model: args.model, baseUrl: args.baseUrl, statusDir, sandbox: getSandboxInfo(), rateLimit: rateInfo });
      continue;
    }

    if (user === "/models") {
      tpl.info(`API root: ${getApiRoot(args.baseUrl)}`);

      const stopFetch = startSpinner("fetching available models");
      let models;
      try { models = await fetchAvailableModels(args.baseUrl, args.timeoutMs, args.apiKey); }
      finally { stopFetch(); }

      if (!models.length) { tpl.error("No models returned — check LM Studio version supports /api/v0/models"); continue; }
      tpl.info(`${models.length} model(s) found`);

      const picked = await select(models, { label: `select a model  (loaded: ${args.model}):` });
      if (!picked || picked === args.model) continue;

      let stopSpinner = startSpinner(`unloading  ${args.model}`);
      try {
        await unloadModel(args.baseUrl, args.model, args.timeoutMs, args.apiKey);
        stopSpinner();
        tpl.info("unloaded");
      } catch (e) {
        stopSpinner();
        tpl.error(`Unload failed: ${userMessage(e)}`);
      }

      stopSpinner = startSpinner(`loading  ${picked}`);
      try {
        await loadModel(args.baseUrl, picked, args.apiKey);
        stopSpinner();
        args.model = picked;
        tpl.info(`Model → ${picked}`);
      } catch (e) {
        stopSpinner();
        tpl.error(`Load failed: ${userMessage(e)}`);
      }
      continue;
    }

    if (user === "/design") {
      const labels = AVAILABLE_TEMPLATES.map(t =>
        t === args.template ? `${t} (current)` : t
      );

      const picked = await select(labels, { label: "select a design:" });
      if (!picked) continue;

      // Extract template name (strip " (current)" suffix if present)
      const newTemplate = picked.replace(" (current)", "");

      if (newTemplate === args.template) {
        tpl.info(`already using "${newTemplate}"`);
        continue;
      }

      try {
        const newTpl = await loadTemplate(newTemplate);
        tpl = newTpl;
        args.template = newTemplate;
        logger.ok("template", `switched to: "${newTemplate}"`);
        tpl.info(`design → ${newTemplate}`);
      } catch (e) {
        tpl.error(`failed to load design: ${e.message}`);
      }
      continue;
    }

    // ── # prefix: reset context, optionally with new message ────────────────
    if (user.startsWith("#")) {
      const afterHash = user.slice(1).trim();
      messages = [{ role: "system", content: args.system }];
      updatePendingState(messages, args.history);
      tpl.info("context cleared");
      // If there's text after #, treat it as the first message in the new context
      if (afterHash) {
        user = afterHash;
      } else {
        continue; // just # with no text — reset and go back to prompt
      }
    }

    messages.push({ role: "user", content: user });
    try {
      const { text: assistant, stats, toolMsgs } = await runWithTools({ args, messages, tpl, rateLimiter, toolResultMode });
      logger.output(assistant);
      for (const m of toolMsgs) messages.push(m);
      messages.push({ role: "assistant", content: assistant });
      sessionStats.requests         += 1;
      sessionStats.promptTokens     += stats.promptTokens;
      sessionStats.completionTokens += stats.completionTokens;
      sessionStats.totalTokens      += stats.totalTokens;
      // Update pending state so signal handler can save on SIGINT/SIGTERM
      updatePendingState(messages, args.history);
      // Save history (non-fatal — logs error if it fails) — now async, non-blocking
      if (args.history) saveHistorySafe(args.history, messages);
      // Persist stats (non-fatal — logs error if it fails) — buffered, non-blocking
      appendStatSafe(statusDir, { model: args.model, ...stats });
    } catch (e) {
      messages.pop();
      updatePendingState(messages, args.history);
      tpl.error(`Request failed: ${userMessage(e)}`);
    }
  }

  process.stdin.pause();
  // Final history save (non-fatal — logs error if it fails)
  if (args.history) await saveHistorySafe(args.history, messages);
  // Flush any remaining stats before exit
  await flushStats();
}

run().catch((e) => {
  process.stderr.write((e?.stack ?? String(e)) + "\n");
  process.exit(1);
});
