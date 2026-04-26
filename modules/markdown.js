/**
 * Lightweight markdown renderer for terminal output.
 * Supports: code blocks, inline code, bold, italic, headers, lists, links.
 */

const R      = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const ITALIC = "\x1b[3m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE   = "\x1b[34m";
const MAGENTA= "\x1b[35m";
const RED    = "\x1b[31m";
const BGREEN = "\x1b[42m";
const BCYAN  = "\x1b[46m";

// ── Language name → ANSI color mapping ────────────────────────────────────────

const LANG_COLORS = {
  javascript:  YELLOW,
  js:         YELLOW,
  typescript:  YELLOW,
  ts:         YELLOW,
  python:     BLUE,
  py:         BLUE,
  bash:       GREEN,
  sh:         GREEN,
  shell:      GREEN,
  json:       MAGENTA,
  yaml:       CYAN,
  yml:       CYAN,
  html:       RED,
  css:        CYAN,
  sql:        MAGENTA,
  markdown:   DIM,
  md:         DIM,
  rust:       YELLOW,
  rs:         YELLOW,
  go:         CYAN,
  java:       RED,
  c:          BLUE,
  cpp:        BLUE,
  "c++":      BLUE,
  ruby:       RED,
  rb:         RED,
  php:        MAGENTA,
  swift:      YELLOW,
  kotlin:     MAGENTA,
  scala:      MAGENTA,
  r:          BLUE,
  lua:        BLUE,
  perl:       YELLOW,
  dart:       BLUE,
  toml:       CYAN,
  xml:        RED,
  graphql:    MAGENTA,
  diff:       GREEN,
  patch:      GREEN,
  log:        DIM,
  text:       DIM,
  plaintext:  DIM,
  none:       DIM,
};

function getLangColor(lang) {
  if (!lang) return DIM;
  const key = lang.toLowerCase().trim();
  return LANG_COLORS[key] ?? CYAN;
}

// ── Inline formatting ────────────────────────────────────────────────────────

function renderInline(text) {
  // Escape backslashes first to avoid double-processing
  // Order matters: process code first to avoid formatting inside code spans

  // We process character by character to handle overlapping patterns
  let result = "";
  let i = 0;

  while (i < text.length) {
    // Inline code: `code`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        const code = text.slice(i + 1, end);
        result += `${BGREEN}${R} ${escapeAnsi(code)} ${R}`;
        i = end + 1;
        continue;
      }
    }

    // Bold+Italic: ***text*** or ___text___
    if ((text[i] === "*" && text[i+1] === "*" && text[i+2] === "*") ||
        (text[i] === "_" && text[i+1] === "_" && text[i+2] === "_")) {
      const ch = text[i];
      const end = text.indexOf(ch+ch+ch, i + 3);
      if (end !== -1) {
        result += `${BOLD}${ITALIC}${text.slice(i + 3, end)}${R}`;
        i = end + 3;
        continue;
      }
    }

    // Bold: **text** or __text__
    if ((text[i] === "*" && text[i+1] === "*") ||
        (text[i] === "_" && text[i+1] === "_")) {
      const ch = text[i];
      const end = text.indexOf(ch+ch, i + 2);
      if (end !== -1) {
        result += `${BOLD}${text.slice(i + 2, end)}${R}`;
        i = end + 2;
        continue;
      }
    }

    // Italic: *text* or _text_
    if (text[i] === "*" || text[i] === "_") {
      const ch = text[i];
      const end = text.indexOf(ch, i + 1);
      if (end !== -1) {
        result += `${ITALIC}${text.slice(i + 1, end)}${R}`;
        i = end + 1;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (text[i] === "~" && text[i+1] === "~") {
      const end = text.indexOf("~~", i + 2);
      if (end !== -1) {
        result += `${RED}${ITALIC}${text.slice(i + 2, end)}${R}`;
        i = end + 2;
        continue;
      }
    }

    // Links: [text](url)
    if (text[i] === "[") {
      const bracketEnd = text.indexOf("]", i);
      if (bracketEnd !== -1 && text[bracketEnd + 1] === "(") {
        const parenEnd = text.indexOf(")", bracketEnd + 2);
        if (parenEnd !== -1) {
          const linkText = text.slice(i + 1, bracketEnd);
          const url = text.slice(bracketEnd + 2, parenEnd);
          result += `${CYAN}${linkText}${R} ${DIM}(${url})${R}`;
          i = parenEnd + 1;
          continue;
        }
      }
    }

    result += text[i];
    i++;
  }

  return result;
}

function escapeAnsi(text) {
  return text.replace(/[\x1b\[]/g, "");
}

// ── Block-level rendering ────────────────────────────────────────────────────

/**
 * Render markdown text to ANSI-colored terminal output.
 * @param {string} text - Raw markdown text
 * @param {object} opts - Options
 * @param {boolean} opts.codeBlockBorder - Whether to draw borders around code blocks
 * @returns {string} ANSI-formatted string
 */
export function renderMarkdown(text, opts = {}) {
  const { codeBlockBorder = false } = opts;
  const lines = text.split("\n");
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ```lang ... ```
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const color = getLangColor(lang);
      const codeLines = [];

      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```

      if (codeBlockBorder) {
        // Draw a box around the code block
        const header = lang ? `${DIM}┌─ ${lang.toUpperCase()} ─────────${R}` : `${DIM}┌─ CODE ──────────────${R}`;
        output.push(header);
        for (const cl of codeLines) {
          output.push(`${DIM}│${R} ${color}${escapeAnsi(cl)}${R}`);
        }
        output.push(`${DIM}└────────────────────${R}`);
      } else {
        // Simple code block with left border
        if (lang) {
          output.push(`${DIM}── ${lang.toUpperCase()} ──${R}`);
        }
        for (const cl of codeLines) {
          output.push(`${DIM}│${R} ${color}${escapeAnsi(cl)}${R}`);
        }
        output.push("");
      }
      continue;
    }

    // Headers: # H1, ## H2, etc.
    if (line.startsWith("#")) {
      const level = line.match(/^(#+)/)[1].length;
      const content = line.slice(level).trim();
      const colors = [CYAN, GREEN, YELLOW, BLUE, MAGENTA, RED];
      const color = colors[Math.min(level - 1, colors.length - 1)];
      const prefix = "│".repeat(level);
      output.push(`${color}${BOLD}${prefix} ${content}${R}`);
      i++;
      continue;
    }

    // Horizontal rule: --- or ***
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      output.push(`${DIM}────────────────${R}`);
      i++;
      continue;
    }

    // Unordered list: - item or * item
    if (/^(\s*[-*+])\s/.test(line)) {
      const content = line.replace(/^(\s*[-*+])\s/, "");
      const indent = line.match(/^(\s*)/)[1].length;
      const bullet = indent > 0 ? "└" : "•";
      const prefix = indent > 0 ? "  ".repeat(Math.floor(indent / 2)) : "";
      output.push(`${prefix}${DIM}${bullet} ${R}${renderInline(content)}`);
      i++;
      continue;
    }

    // Ordered list: 1. item
    if (/^\s*\d+\.\s/.test(line)) {
      const match = line.match(/^(\s*)(\d+)\.\s(.*)/);
      if (match) {
        const [, indent, num, content] = match;
        const prefix = indent || "";
        output.push(`${prefix}${DIM}${num}. ${R}${renderInline(content)}`);
        i++;
        continue;
      }
    }

    // Blockquote: > text
    if (line.startsWith(">")) {
      const content = line.slice(1).trim();
      output.push(`${CYAN}▸ ${renderInline(content)}${R}`);
      i++;
      continue;
    }

    // Regular paragraph line
    output.push(renderInline(line));
    i++;
  }

  return output.join("\n");
}

/**
 * Check if text contains any markdown that would benefit from rendering.
 * @param {string} text
 * @returns {boolean}
 */
export function hasMarkdown(text) {
  return /(```|`|\*\*|__|\*|_|~~|\[.*\]\(.*\)|^#{1,6}\s|^-|\d+\.|^>|^---)/m.test(text);
}
