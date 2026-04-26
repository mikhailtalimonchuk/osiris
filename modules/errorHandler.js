// Centralized error handling utilities
// Provides consistent error logging and user-friendly error messages.

import { logger } from "./logger.js";

/**
 * Log an error to stderr (always visible) and to the debug log file (if active).
 * Unlike the regular logger, this always writes to stderr regardless of debug mode.
 */
export function logError(tag, message) {
  const RED = "\x1b[31m";
  const DIM = "\x1b[2m";
  const R = "\x1b[0m";
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`${DIM}[${ts}]${R} ${RED}✖ ${tag}${R} ${message}\n`);
  logger.fail(tag, message);
}

/**
 * Wrap an async operation and log errors silently (non-fatal).
 * Returns the result on success, or `null` on failure.
 * The error is logged but does not propagate.
 *
 * @param {string} tag - Logger tag (e.g. "history", "stats")
 * @param {Function} fn - Async function to execute
 * @param {string} [fallbackMsg] - Optional message to log on failure (default: derived from error)
 * @returns {Promise<any|null>}
 */
export async function safeAsync(tag, fn, fallbackMsg) {
  try {
    return await fn();
  } catch (e) {
    const msg = fallbackMsg ?? e?.message ?? String(e);
    logError(tag, msg);
    return null;
  }
}

/**
 * Wrap a sync operation and log errors silently (non-fatal).
 * Returns the result on success, or `null` on failure.
 *
 * @param {string} tag - Logger tag
 * @param {Function} fn - Sync function to execute
 * @param {string} [fallbackMsg] - Optional message to log on failure
 * @returns {any}
 */
export function safeSync(tag, fn, fallbackMsg) {
  try {
    return fn();
  } catch (e) {
    const msg = fallbackMsg ?? e?.message ?? String(e);
    logError(tag, msg);
    return null;
  }
}

/**
 * Create a user-friendly error message from an error object.
 * Strips stack traces and internal details.
 */
export function userMessage(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  return e?.message ?? String(e);
}
