#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
const DEFAULT_MODEL = process.env.LMSTUDIO_MODEL ?? "local-model";

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    system: "You are a helpful CLI assistant.",
    temperature: 0.2,
    maxTokens: null,
    stream: false,
    timeoutMs: 120_000,
    history: null,
    once: null
  };

  const it = argv[Symbol.iterator]();
  for (let cur = it.next(); !cur.done; cur = it.next()) {
    const a = cur.value;
    if (a === "--help" || a === "-h") return { ...args, help: true };
    if (a === "--stream") args.stream = true;
    else if (a === "--base-url") args.baseUrl = it.next().value;
    else if (a === "--model") args.model = it.next().value;
    else if (a === "--system") args.system = it.next().value;
    else if (a === "--temperature") args.temperature = Number(it.next().value);
    else if (a === "--max-tokens") args.maxTokens = Number(it.next().value);
    else if (a === "--timeout") args.timeoutMs = Math.floor(Number(it.next().value) * 1000);
    else if (a === "--history") args.history = it.next().value;
    else if (a === "--once") args.once = it.next().value;
    else {
      // Unknown arg: ignore for now (keeps it simple)
    }
  }
  return args;
}

function helpText() {
  return `
osiris - LM Studio CLI agent (OpenAI-compatible API)

Usage:
  osiris [--stream] [--history FILE] [--base-url URL] [--model NAME]
         [--system PROMPT] [--temperature N] [--max-tokens N]
         [--timeout SECONDS] [--once "message"]

Defaults:
  --base-url  ${DEFAULT_BASE_URL}
  --model     ${DEFAULT_MODEL}

Commands (interactive):
  /exit, /quit   Quit
  /reset         Clear conversation (keeps system prompt)
  /save          Save history (requires --history)
  /history       Print message list
`.trim();
}

function urlJoin(baseUrl, p) {
  return baseUrl.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");
}

function loadHistory(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("History file must be a JSON array.");
  return data;
}

function saveHistory(filePath, messages) {
  if (!filePath) return;
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(messages, null, 2), "utf8");
}

async function chatOnce({ baseUrl, model, messages, temperature, maxTokens, stream, timeoutMs }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model,
    messages,
    temperature,
    stream
  };
  if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;

  const res = await fetch(urlJoin(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal
  }).finally(() => clearTimeout(t));

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }

  if (!stream) {
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? "";
  }

  // SSE streaming: data: {...}\n\n ... data: [DONE]
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";

    for (const line of parts) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") {
        process.stdout.write(os.EOL);
        return full;
      }
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = obj?.choices?.[0]?.delta?.content;
      if (delta) {
        process.stdout.write(delta);
        full += delta;
      }
    }
  }

  process.stdout.write(os.EOL);
  return full;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    process.exit(0);
  }

  let messages = [{ role: "system", content: args.system }];
  if (args.history) {
    const hist = loadHistory(args.history);
    if (hist?.length && hist[0]?.role === "system") messages = hist;
    else if (hist) messages = messages.concat(hist);
  }

  if (args.once) {
    messages.push({ role: "user", content: args.once });
    const assistant = await chatOnce({ ...args, messages });
    if (!args.stream) console.log(assistant);
    messages.push({ role: "assistant", content: assistant });
    if (args.history) saveHistory(args.history, messages);
    return;
  }

  console.log(`Connected target: ${args.baseUrl}  |  model: ${args.model}`);
  console.log("Type your message. Commands: /exit, /reset, /save, /history\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((resolve) => rl.question("> ", resolve));

  while (true) {
    let user;
    try {
      user = String(await ask()).trim();
    } catch {
      break;
    }
    if (!user) continue;
    if (user === "/exit" || user === "/quit") break;
    if (user === "/reset") {
      messages = [{ role: "system", content: args.system }];
      console.log("(history reset)");
      continue;
    }
    if (user === "/history") {
      console.log(JSON.stringify(messages, null, 2));
      continue;
    }
    if (user === "/save") {
      if (!args.history) {
        console.log("No --history path provided.");
        continue;
      }
      saveHistory(args.history, messages);
      console.log(`(saved to ${args.history})`);
      continue;
    }

    messages.push({ role: "user", content: user });
    try {
      const assistant = await chatOnce({ ...args, messages });
      if (!args.stream) console.log(assistant);
      messages.push({ role: "assistant", content: assistant });
      if (args.history) {
        try {
          saveHistory(args.history, messages);
        } catch {
          // best-effort
        }
      }
    } catch (e) {
      messages.pop(); // remove last user message for clean retry
      console.error(`Request failed: ${e?.message ?? String(e)}`);
    }
  }

  rl.close();
  if (args.history) {
    try {
      saveHistory(args.history, messages);
    } catch {
      // best-effort
    }
  }
}

run().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});

