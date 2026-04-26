// ── Tool defaults ────────────────────────────────────────────────────────────
// Shared limits for the built-in tool implementations.

/** Maximum number of results the `find` tool returns before stopping the walk. */
export const TOOL_FIND_MAX_RESULTS = 300;

/** Default maximum lines the `read` tool returns from a file. */
export const TOOL_READ_DEFAULT_MAX_LINES = 500;

// ── HTTP / API defaults ──────────────────────────────────────────────────────

/** Default HTTP request timeout in milliseconds (2 minutes). */
export const DEFAULT_TIMEOUT_MS = 120_000;
