import axios from "axios";
import os from "node:os";
import dns from "dns"; // force IPv4 — LM Studio on localhost doesn't always respond on IPv6
import http from "http";
import { logger } from "./logger.js";

export function urlJoin(baseUrl, p) {
  return baseUrl.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");
}

export async function fetchFirstModel(baseUrl, timeoutMs) {
  const url = urlJoin(baseUrl, "/models");
  logger.step("models", `GET ${url} (timeout: ${timeoutMs}ms)`);
  try {
    dns.setDefaultResultOrder("ipv4first");
    const agent = new http.Agent({ family: 4, keepAlive: true });
    const res = await axios.get(url, { timeout: timeoutMs, httpAgent: agent, proxy: false });
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

function makeStats(usage, elapsedMs) {
  const promptTokens      = usage?.prompt_tokens     ?? 0;
  const completionTokens  = usage?.completion_tokens ?? 0;
  const totalTokens       = usage?.total_tokens      ?? (promptTokens + completionTokens);
  const tokensPerSec      = completionTokens && elapsedMs > 0
    ? Math.round(completionTokens / (elapsedMs / 1000) * 10) / 10
    : 0;
  return { elapsedMs, promptTokens, completionTokens, totalTokens, tokensPerSec };
}

export async function fetchAllModels(baseUrl, timeoutMs) {
  const url = urlJoin(baseUrl, "/models");
  try {
    const res = await axios.get(url, { timeout: timeoutMs, proxy: false });
    const models = res.data?.data ?? [];
    return models.map(m => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

// Strip /v1 suffix to reach the LM Studio-native /api/v0 endpoints
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

export async function fetchAvailableModels(baseUrl, timeoutMs) {
  const url = apiRoot(baseUrl) + "/api/v0/models";
  logger.step("models", `GET ${url}`);
  try {
    const res = await axios.get(url, { timeout: timeoutMs, proxy: false });
    const models = res.data?.data ?? [];
    logger.ok("models", `${models.length} model(s) from /api/v0/models`);
    logger.json("models:available", models.map(m => ({ id: m.path ?? m.id, state: m.state })));
    return models.map(m => m.path ?? m.id).filter(Boolean);
  } catch (e) {
    logger.fail("models", `/api/v0/models failed: ${e.message} — falling back to /v1/models`);
    return fetchAllModels(baseUrl, timeoutMs);
  }
}

export async function unloadModel(baseUrl, modelId, timeoutMs) {
  const url = apiRoot(baseUrl) + "/api/v1/models/unload";
  logger.step("models", `POST ${url}  identifier=${modelId}`);
  try {
    const res = await axios.post(url, { instance_id: modelId }, { timeout: timeoutMs, proxy: false });
    logger.ok("models", `unload HTTP ${res.status}`);
  } catch (e) {
    logger.fail("models", `unload failed: ${e.message}`);
    throw httpErr(e);
  }
}

export async function loadModel(baseUrl, modelId) {
  const url = apiRoot(baseUrl) + "/api/v1/models/load";
  logger.step("models", `POST ${url}  path=${modelId}`);
  try {
    // No timeout — loading a large GGUF can take several minutes
    const res = await axios.post(url, { model: modelId }, { timeout: 0, proxy: false });
    logger.ok("models", `load HTTP ${res.status}`);
  } catch (e) {
    logger.fail("models", `load failed: ${e.message}`);
    throw httpErr(e);
  }
}

export async function chatOnce({ baseUrl, model, messages, temperature, maxTokens, stream, timeoutMs, tools, onFirstChunk }) {
  const url = urlJoin(baseUrl, "/chat/completions");
  const body = {
    model, messages, temperature, stream,
    ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  };

  logger.step("chat", `POST ${url}`);
  logger.json("chat:request", { model, temperature, stream, maxTokens, tools: tools?.length ?? 0, messageCount: messages.length });

  const startTime = Date.now();
  let res;
  try {
    res = await axios.post(url, body, {
      timeout: timeoutMs,
      responseType: stream ? "stream" : "json",
    });
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
  let buf = "", full = "", usage = null, firstChunkFired = false;
  const tcMap = {}; // index → { id, function: { name, arguments } }

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

      // Accumulate tool_call deltas
      for (const tc of choice.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        if (!tcMap[idx]) tcMap[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id)                       tcMap[idx].id                       += tc.id;
        if (tc.function?.name)           tcMap[idx].function.name            += tc.function.name;
        if (tc.function?.arguments)      tcMap[idx].function.arguments       += tc.function.arguments;
      }

      const delta = choice.delta?.content;
      if (delta) { process.stdout.write(delta); full += delta; }
    }
  }

  process.stdout.write(os.EOL);
  const toolCalls = Object.keys(tcMap).length ? Object.values(tcMap) : null;
  const stats = makeStats(usage, Date.now() - startTime);
  logger.step("chat", `stream ended without [DONE] — ${full.length} chars total`);
  return { text: full, stats, toolCalls };
}
