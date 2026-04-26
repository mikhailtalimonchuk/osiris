import fs from "node:fs/promises";
import path from "node:path";
import { TOOL_FIND_MAX_RESULTS, TOOL_READ_DEFAULT_MAX_LINES } from "./constants.js";

// ── Sandbox configuration ────────────────────────────────────────────────────
// By default tools are sandboxed to process.cwd().  Override via config key
// `toolSandbox` (absolute path) or set to "off" to disable sandboxing entirely.

let _sandboxRoot = process.cwd();
let _sandboxEnabled = true;

export function configureToolSandbox(rootOrMode) {
  if (rootOrMode === "off" || rootOrMode === false) {
    _sandboxEnabled = false;
    _sandboxRoot = null;
    return;
  }
  _sandboxEnabled = true;
  _sandboxRoot = path.resolve(rootOrMode ?? process.cwd());
}

/**
 * Resolve a user-supplied path and enforce the sandbox boundary.
 * Throws if the resolved path escapes the sandbox root.
 */
export function safePath(p) {
  if (!_sandboxEnabled) return path.resolve(p);
  const resolved = path.resolve(_sandboxRoot, p);
  const root = _sandboxRoot;
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${p}" is outside the sandbox root (${root})`);
  }
  return resolved;
}

export function getSandboxInfo() {
  return { enabled: _sandboxEnabled, root: _sandboxRoot };
}

// ── Tool limits (overridable via config) ─────────────────────────────────────

let _findMaxResults   = TOOL_FIND_MAX_RESULTS;
let _readMaxLines     = TOOL_READ_DEFAULT_MAX_LINES;

/**
 * Override tool limits at runtime (called after config is loaded).
 * Accepts a partial object — only provided keys are updated.
 */
export function configureToolLimits(opts = {}) {
  if (Number.isInteger(opts.findMaxResults) && opts.findMaxResults > 0) {
    _findMaxResults = opts.findMaxResults;
  }
  if (Number.isInteger(opts.readMaxLines) && opts.readMaxLines > 0) {
    _readMaxLines = opts.readMaxLines;
  }
}

export function getToolLimits() {
  return { findMaxResults: _findMaxResults, readMaxLines: _readMaxLines };
}

// ── implementations (async) ──────────────────────────────────────────────────

const patternCache = new Map();
function compilePattern(pattern) {
  if (!patternCache.has(pattern)) {
    patternCache.set(pattern, new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "i"
    ));
  }
  return patternCache.get(pattern);
}

async function findPaths({ pattern = "*", dir = ".", type = "any" }) {
  const re = compilePattern(pattern);
  const root = safePath(dir);
  const results = [];

  async function walk(cur) {
    let entries;
    try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= _findMaxResults) return;
      const full = path.join(cur, e.name);
      const isDir = e.isDirectory();
      if (re.test(e.name)) {
        if (type === "any" || (type === "file" && !isDir) || (type === "dir" && isDir))
          results.push(full + (isDir ? "/" : ""));
      }
      if (isDir) await walk(full);
    }
  }

  await walk(root);
  return results.length ? results.join("\n") : "No matches found.";
}

async function listDir({ path: p = "." }) {
  try {
    const entries = await fs.readdir(safePath(p), { withFileTypes: true });
    if (!entries.length) return "(empty)";
    return entries.map(e => `${e.isDirectory() ? "d" : "f"}  ${e.name}`).join("\n");
  } catch (e) { return `Error: ${e.message}`; }
}

async function makeDir({ path: p }) {
  try { await fs.mkdir(safePath(p), { recursive: true }); return `Created: ${p}`; }
  catch (e) { return `Error: ${e.message}`; }
}

async function readFile({ path: p, max_lines }) {
  const effectiveMax = (max_lines != null && Number.isInteger(max_lines) && max_lines > 0)
    ? max_lines
    : _readMaxLines;

  try {
    const text = await fs.readFile(safePath(p), "utf8");
    const lines = text.split("\n");
    return lines.length > effectiveMax
      ? lines.slice(0, effectiveMax).join("\n") + `\n… (${lines.length - effectiveMax} lines truncated)`
      : text;
  } catch (e) { return `Error: ${e.message}`; }
}

async function writeFile({ path: p, content }) {
  try {
    const safe = safePath(p);
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await fs.writeFile(safe, content, "utf8");
    return `Written: ${p}`;
  } catch (e) { return `Error: ${e.message}`; }
}

async function appendFile({ path: p, content }) {
  try { await fs.appendFile(safePath(p), content, "utf8"); return `Appended to: ${p}`; }
  catch (e) { return `Error: ${e.message}`; }
}

async function deletePath({ path: p, recursive = false }) {
  try {
    const safe = safePath(p);
    const stat = await fs.stat(safe);
    if (stat.isDirectory()) await fs.rm(safe, { recursive });
    else await fs.unlink(safe);
    return `Deleted: ${p}`;
  } catch (e) { return `Error: ${e.message}`; }
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const HANDLERS = {
  find:   findPaths,
  ls:     listDir,
  mkdir:  makeDir,
  read:   readFile,
  write:  writeFile,
  append: appendFile,
  delete: deletePath,
};

/**
 * Execute a tool asynchronously.
 * Returns a string result (or error message).
 */
export async function executeTool(name, args) {
  const fn = HANDLERS[name];
  if (!fn) return `Unknown tool: ${name}`;
  try { return String(await fn(args)); }
  catch (e) { return `Error: ${e.message}`; }
}

// ── definitions (OpenAI function-calling schema) ─────────────────────────────

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "find",
      description: "Find files or directories recursively by name pattern",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Name pattern; supports * wildcard. Example: *.js" },
          dir:     { type: "string", description: "Root directory to search (default: current dir)" },
          type:    { type: "string", enum: ["file", "dir", "any"], description: "Match files, dirs, or both" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ls",
      description: "List contents of a directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path (default: current dir)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mkdir",
      description: "Create a directory (and parent directories as needed)",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path to create" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read the contents of a file",
      parameters: {
        type: "object",
        properties: {
          path:      { type: "string", description: "File path" },
          max_lines: { type: "number", description: "Max lines to return (default: configurable via toolReadMaxLines)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write (create or overwrite) a file",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string", description: "File path" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append",
      description: "Append content to the end of a file",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string", description: "File path" },
          content: { type: "string", description: "Content to append" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete",
      description: "Delete a file or directory",
      parameters: {
        type: "object",
        properties: {
          path:      { type: "string",  description: "File or directory path" },
          recursive: { type: "boolean", description: "Recursively delete directory contents" },
        },
        required: ["path"],
      },
    },
  },
];
