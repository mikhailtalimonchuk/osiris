export const DEFAULT_BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
export const DEFAULT_MODEL = process.env.LMSTUDIO_MODEL ?? null;

export function nextVal(it, flag) {
  const n = it.next();
  if (n.done) throw new Error(`${flag} requires a value`);
  return n.value;
}

export function parseArgs(argv) {
  const args = {
    baseUrl:     DEFAULT_BASE_URL,
    model:       DEFAULT_MODEL,
    system:      "You are a helpful CLI assistant.",
    temperature: 0.2,
    maxTokens:   null,
    stream:      false,
    timeoutMs:   120_000,
    history:     null,
    once:        null,
    template:    "default",
    debug:       false,
    // Security
    apiKey:      null,
    rateLimit:   0,          // 0 = unlimited
    toolSandbox: null,       // null = cwd, "off" = disabled, string = custom root
  };
  const explicit = new Set();

  const it = argv[Symbol.iterator]();
  for (let cur = it.next(); !cur.done; cur = it.next()) {
    const a = cur.value;
    if (a === "--help" || a === "-h")   return { args: { ...args, help: true }, explicit };
    if (a === "--stream")               { args.stream      = true;                                      explicit.add("stream");      }
    else if (a === "--debug")           { args.debug       = true;                                      explicit.add("debug");       }
    else if (a === "--base-url")        { args.baseUrl     = nextVal(it, a);                            explicit.add("baseUrl");     }
    else if (a === "--model")           { args.model       = nextVal(it, a);                            explicit.add("model");       }
    else if (a === "--system")          { args.system      = nextVal(it, a);                            explicit.add("system");      }
    else if (a === "--temperature")     { args.temperature = Number(nextVal(it, a));                    explicit.add("temperature"); }
    else if (a === "--max-tokens")      { args.maxTokens   = Number(nextVal(it, a));                    explicit.add("maxTokens");   }
    else if (a === "--timeout")         { args.timeoutMs   = Math.floor(Number(nextVal(it, a)) * 1000); explicit.add("timeoutMs");  }
    else if (a === "--history")         { args.history     = nextVal(it, a);                            explicit.add("history");     }
    else if (a === "--once")            { args.once        = nextVal(it, a);                            explicit.add("once");        }
    else if (a === "--template")        { args.template    = nextVal(it, a);                            explicit.add("template");    }
    // Security flags
    else if (a === "--api-key")         { args.apiKey      = nextVal(it, a);                            explicit.add("apiKey");      }
    else if (a === "--rate-limit")      { args.rateLimit   = Number(nextVal(it, a));                    explicit.add("rateLimit");   }
    else if (a === "--tool-sandbox")    { args.toolSandbox = nextVal(it, a);                            explicit.add("toolSandbox"); }
    else process.stderr.write(`Unknown option: ${a}\n`);
  }
  return { args, explicit };
}

export function helpText() {
  return `
osiris — LM Studio CLI agent (OpenAI-compatible API)

Usage:
  osiris [--stream] [--history FILE] [--base-url URL] [--model NAME]
         [--system PROMPT] [--temperature N] [--max-tokens N]
         [--timeout SECONDS] [--once "message"] [--template NAME]

Security:
  --api-key KEY        Bearer token for remote LM Studio instances
  --rate-limit RPM     Max requests per minute (0 = unlimited, default: 0)
  --tool-sandbox PATH  Restrict tool access to PATH (default: cwd; "off" to disable)

Defaults:
  --base-url   ${DEFAULT_BASE_URL}
  --model      auto-detect from /v1/models
  --template   default
  --debug      off

Templates:
  default      Clean output with subtle color
  fancy        Box-drawing UI with full ANSI color
  minimal      Plain text, no decoration

Commands (interactive):
  /exit, /quit   Quit
  /reset         Clear conversation (keeps system prompt)
  /save          Save history (requires --history)
  /history       Print message list as JSON
  /status        Show session stats (tokens, requests, uptime)
  /models        Browse and switch loaded models
  /design        Switch display template at runtime
`.trim();
}
