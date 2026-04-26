import axios from "axios";
import os from "node:os";
import dns from "dns";
import http from "http";
import https from "https";
import { logger } from "./logger.js";

// ── Retry with exponential backoff ───────────────────────────────────────────

const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isRetryable = RETRYABLE_STATUS.includes(e?.response?.status);
      const isNetworkError = e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT" || e?.code === "ECONNREFUSED";
      if ((isRetryable || isNetworkError) && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        logger.warn("retry", `attempt ${attempt + 1}/${maxRetries} failed — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
  throw lastErr;
}

// ── Shared connection pool ───────────────────────────────────────────────────
// Reuse TCP connections across requests instead of creating a new agent each time.

const sharedHttpAgent = new http.Agent({
  family: 4,
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 16,
  maxFreeSockets: 8,
});

const sharedHttpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 16,
  maxFreeSockets: 8,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

export function urlJoin(baseUrl, p) {
  return baseUrl.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");
}

function apiRoot(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

export function getApiRoot(baseUrl) {
  return apiRoot(baseUrl);
}

function httpErr(e) {
  if (e.response) {
    const body = typeof e.response.data === "object"
      ? JSON.stringify(e.response.data)
      : String(e.response.data ?? "");
    return new Error(`HTTP ${e.response.status} ${e.response.statusText}${body ? `: ${body}` : ""}`);
  }
  return e;
}

function makeStats(usage, elapsedMs) {
  const promptTokens      = usage?.prompt_tokens     ?? 0;
  const completionTokens  = usage?.completion_tokens ?? 0;
  const totalTokens       = usage?.total_tokens      ?? (promptTokens + completionTokens);
  const tokensPerSec      = completionTokens && elapsedMs > 0
    ? Math.round(completionTokens / (elapsedMs / 1000) * 10) / 10
    : 0;
  return { elapsedMs, promptTokens, completionTokens, totalTokens, tokensPerSec };
}

/** Build common axios config with optional API key and IPv4 forcing */
function axiosConfig(timeoutMs, apiKey) {
  const cfg = { timeout: timeoutMs, proxy: false };
  if (apiKey) cfg.headers = { Authorization: `Bearer ${apiKey}` };
  dns.setDefaultResultOrder("ipv4first");
  // Reuse shared agents for connection pooling
  cfg.httpAgent = sharedHttpAgent;
  cfg.httpsAgent = sharedHttpsAgent;
  return cfg;
}

// ── Model endpoints ──────────────────────────────────────────────────────────

export async function fetchFirstModel(baseUrl, timeoutMs, apiKey) {
  const url = urlJoin(baseUrl, "/models");
  logger.step("models", `GET ${url} (timeout: ${timeoutMs}ms)`);
  try {
    const res = await withRetry(() => axios.get(url, axiosConfig(timeoutMs, apiKey)));
    const models = res.data?.data ?? [];
    logger.ok("models", `HTTP ${res.status} — ${models.length} model(s) returned`);
    if (!models.length) {
      logger.warn("models", "list is empty — no model loaded in LM Studio");
      return null;
    }
    logger.json("models:list", models.map(m => m.id));
    const selected = models[0].id ?? null;
    logger.ok("models", `auto-selected: ${selected}`);
    return selected;
  } catch (e) {
    if (e.response) {
      logger.fail("models", `HTTP ${e.response.status} ${e.response.statusText}`);
    } else {
      const cause = e?.cause?.message ?? e?.cause ?? "";
      logger.fail("models", `request error: ${e?.message ?? String(e)}${cause ? ` → ${cause}` : ""}`);
    }
    return null;
  }
}

export async function fetchAllModels(baseUrl, timeoutMs, apiKey) {
  const url = urlJoin(baseUrl, "/models");
  try {
    const res = await withRetry(() => axios.get(url, axiosConfig(timeoutMs, apiKey)));
    const models = res.data?.data ?? [];
    return models.map(m => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

export async function fetchAvailableModels(baseUrl, timeoutMs, apiKey) {
  const url = apiRoot(baseUrl) + "/api/v0/models";
  logger.step("models", `GET ${url}`);
  try {
    const res = await withRetry(() => axios.get(url, axiosConfig(timeoutMs, apiKey)));
    const models = res.data?.data ?? [];
    logger.ok("models", `${models.length} model(s) from /api/v0/models`);
    logger.json("models:available", models.map(m => ({ id: m.path ?? m.id, state: m.state })));
    return models.map(m => m.path ?? m.id).filter(Boolean);
  } catch (e) {
    logger.fail("models", `/api/v0/models failed: ${e.message} — falling back to /v1/models`);
    return fetchAllModels(baseUrl, timeoutMs, apiKey);
  }
}

export async function unloadModel(baseUrl, modelId, timeoutMs, apiKey) {
  const url = apiRoot(baseUrl) + "/api/v1/models/unload";
  logger.step("models", `POST ${url}  identifier=${modelId}`);
  try {
    const res = await withRetry(() => axios.post(url, { instance_id: modelId }, axiosConfig(timeoutMs, apiKey)));
    logger.ok("models", `unload HTTP ${res.status}`);
  } catch (e) {
    logger.fail("models", `unload failed: ${e.message}`);
    throw httpErr(e);
  }
}

export async function loadModel(baseUrl, modelId, apiKey) {
  const url = apiRoot(baseUrl) + "/api/v1/models/load";
  logger.step("models", `POST ${url}  path=${modelId}`);
  try {
    const cfg = axiosConfig(0, apiKey); // no timeout for large GGUF loads
    const res = await withRetry(() => axios.post(url, { model: modelId }, cfg));
    logger.ok("models", `load HTTP ${res.status}`);
  } catch (e) {
    logger.fail("models", `load failed: ${e.message}`);
    throw httpErr(e);
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export async function chatOnce({ baseUrl, model, messages, temperature, maxTokens, stream, timeoutMs, tools, onFirstChunk, onFirstContent, apiKey, rateLimiter }) {
  const url = urlJoin(baseUrl, "/chat/completions");
  const body = {
    model, messages, temperature, stream,
    ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  };

  logger.step("chat", `POST ${url}`);
  logger.json("chat:request", { model, temperature, stream, maxTokens, tools: tools?.length ?? 0, messageCount: messages.length });
  logger.json("chat:messages", { messages: JSON.stringify(messages) });

  // Rate-limit gate
  await rateLimiter?.acquire();

  const startTime = Date.now();
  let res;
  try {
    res = await withRetry(() => axios.post(url, body, {
      ...axiosConfig(timeoutMs, apiKey),
      responseType: stream ? "stream" : "json",
    }));
  } catch (e) {
    if (e.response) {
      const msg = `HTTP ${e.response.status}: ${JSON.stringify(e.response.data) || e.response.statusText}`;
      logger.fail("chat", msg);
      throw new Error(msg);
    }
    const cause = e?.cause?.message ?? e?.cause ?? "";
    throw new Error(`${e?.message ?? String(e)}${cause ? ` → ${cause}` : ""}`);
  }

  logger.ok("chat", `HTTP ${res.status}${stream ? " (streaming)" : ""}`);

  if (!stream) {
    const msg     = res.data?.choices?.[0]?.message ?? {};
    const content = msg.content ?? "";
    const toolCalls = msg.tool_calls?.length ? msg.tool_calls : null;
    const stats   = makeStats(res.data?.usage, Date.now() - startTime);
    logger.step("chat", `response: ${content.length} chars, tool_calls: ${toolCalls?.length ?? 0}`);
    return { text: content, stats, toolCalls };
  }

  // SSE streaming — accumulate both content and tool_call deltas
  let buf = "", full = "", usage = null, firstChunkFired = false, firstContentFired = false;
  const tcMap = {};

  for await (const chunk of res.data) {
    buf += chunk.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";

    for (const line of parts) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") {
        process.stdout.write(os.EOL);
        const toolCalls = Object.keys(tcMap).length ? Object.values(tcMap) : null;
        const stats = makeStats(usage, Date.now() - startTime);
        logger.step("chat", `stream done — ${full.length} chars, tool_calls: ${toolCalls?.length ?? 0}`);
        return { text: full, stats, toolCalls };
      }
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (!firstChunkFired) { firstChunkFired = true; onFirstChunk?.(); }
      if (obj?.usage) usage = obj.usage;

      const choice = obj?.choices?.[0];
      if (!choice) continue;

      for (const tc of choice.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        if (!tcMap[idx]) tcMap[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id)                       tcMap[idx].id                       += tc.id;
        if (tc.function?.name)           tcMap[idx].function.name            += tc.function.name;
        if (tc.function?.arguments)      tcMap[idx].function.arguments       += tc.function.arguments;
      }

      const delta = choice.delta?.content;
      if (delta) {
        if (!firstContentFired) { firstContentFired = true; onFirstContent?.(); }
        process.stdout.write(delta);
        full += delta;
      }
    }
  }

  process.stdout.write(os.EOL);
  const toolCalls = Object.keys(tcMap).length ? Object.values(tcMap) : null;
  const stats = makeStats(usage, Date.now() - startTime);
  logger.step("chat", `stream ended without [DONE] — ${full.length} chars total`);
  return { text: full, stats, toolCalls };
}
