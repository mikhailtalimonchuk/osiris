import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { safeSync, safeAsync } from "./errorHandler.js";

export function loadHistory(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("History file must be a JSON array.");
  return data;
}

export async function saveHistory(filePath, messages) {
  if (!filePath) return;
  const abs = path.resolve(filePath);
  await fsPromises.mkdir(path.dirname(abs), { recursive: true });
  await fsPromises.writeFile(abs, JSON.stringify(messages, null, 2), "utf8");
}

/**
 * Save history without throwing — logs errors instead.
 * Use this for non-critical background saves (e.g. after each turn).
 * Now async so it doesn't block the event loop.
 */
export async function saveHistorySafe(filePath, messages) {
  await safeAsync("history", () => saveHistory(filePath, messages), `Failed to save history to ${filePath}`);
}
