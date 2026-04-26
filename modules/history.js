import fs from "node:fs";
import path from "node:path";

export function loadHistory(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("History file must be a JSON array.");
  return data;
}

export function saveHistory(filePath, messages) {
  if (!filePath) return;
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(messages, null, 2), "utf8");
}
