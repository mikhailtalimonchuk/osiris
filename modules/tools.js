import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function safePath(p) {
  const resolved = path.resolve(p);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep))
    throw new Error(`Path "${p}" is outside the project root`);
  return resolved;
}

// ── implementations ──────────────────────────────────────────────────────────

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

function findPaths({ pattern = "*", dir = ".", type = "any" }) {
  const re = compilePattern(pattern);
  const root = safePath(dir);
  const results = [];

  function walk(cur) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= 300) return;
      const full = path.join(cur, e.name);
      const isDir = e.isDirectory();
      if (re.test(e.name)) {
        if (type === "any" || (type === "file" && !isDir) || (type === "dir" && isDir))
          results.push(full + (isDir ? "/" : ""));
      }
      if (isDir) walk(full);
    }
  }

  walk(root);
  return results.length ? results.join("\n") : "No matches found.";
}

function listDir({ path: p = "." }) {
  try {
    const entries = fs.readdirSync(safePath(p), { withFileTypes: true });
    if (!entries.length) return "(empty)";
    return entries.map(e => `${e.isDirectory() ? "d" : "f"}  ${e.name}`).join("\n");
  } catch (e) { return `Error: ${e.message}`; }
}

function makeDir({ path: p }) {
  try { fs.mkdirSync(safePath(p), { recursive: true }); return `Created: ${p}`; }
  catch (e) { return `Error: ${e.message}`; }
}

function readFile({ path: p, max_lines = 500 }) {
  try {
    const text = fs.readFileSync(safePath(p), "utf8");
    const lines = text.split("\n");
    return lines.length > max_lines
      ? lines.slice(0, max_lines).join("\n") + `\n… (${lines.length - max_lines} lines truncated)`
      : text;
  } catch (e) { return `Error: ${e.message}`; }
}

function writeFile({ path: p, content }) {
  try {
    const safe = safePath(p);
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, content, "utf8");
    return `Written: ${p}`;
  } catch (e) { return `Error: ${e.message}`; }
}

function appendFile({ path: p, content }) {
  try { fs.appendFileSync(safePath(p), content, "utf8"); return `Appended to: ${p}`; }
  catch (e) { return `Error: ${e.message}`; }
}

function deletePath({ path: p, recursive = false }) {
  try {
    const safe = safePath(p);
    const stat = fs.statSync(safe);
    if (stat.isDirectory()) fs.rmSync(safe, { recursive });
    else fs.unlinkSync(safe);
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

export function executeTool(name, args) {
  const fn = HANDLERS[name];
  if (!fn) return `Unknown tool: ${name}`;
  try { return String(fn(args)); }
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
          max_lines: { type: "number", description: "Max lines to return (default: 500)" },
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
