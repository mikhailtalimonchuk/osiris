# osiris

A lightweight CLI agent that connects to **LM Studio** via its OpenAI-compatible local API. Supports streaming, conversation history, display templates, and a layered config system.

## Prerequisites

- Start LM Studio's local server: **Local Server → Start Server**
- Default endpoint: `http://localhost:1234/v1`
- If a model is loaded, osiris will detect it automatically — no `--model` flag needed.

## Install

From GitHub (no publish needed):

```bash
npm i -g github:T-nix/osiris
```

Dev install from a local clone:

```bash
npm i -g .
```

## Quick start

```bash
osiris                         # auto-detects model, uses default template
osiris --stream                # stream tokens as they arrive
osiris --template fancy        # box-drawing UI with full color
osiris --once "What is 2+2?"   # single message, then exit
```

---

## Configuration

osiris uses a **layered config system**. Settings are merged in this order — later sources override earlier ones:

```
built-in defaults
  → ~/.osiris/config.json        (global / machine-wide)
    → ancestor .osiris.json       (up to searchDepth parent dirs, within ~)
      → .osiris.json              (current directory)
        → environment variables
          → CLI flags             (always highest priority)
```

### Global config — `~/.osiris/config.json`

Put settings you want everywhere on this machine. This is also where you set `searchDepth`.

**Example — point osiris to a remote LM Studio instance:**

```json
{
  "baseUrl": "http://192.168.1.50:1234/v1",
  "stream": true,
  "template": "fancy"
}
```

**Example — local setup with a fixed model:**

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "model": "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF",
  "stream": true,
  "temperature": 0.3,
  "searchDepth": 5
}
```

### Project config — `.osiris.json`

Drop a `.osiris.json` in your project directory (or any parent directory up to `~`) to override the global config for that context. osiris walks upward from the current directory and merges every `.osiris.json` it finds, so closer files win.

**Example — coding assistant for a specific project:**

```json
{
  "system": "You are an expert TypeScript developer. Answer concisely with code examples.",
  "temperature": 0.1,
  "history": ".osiris-history.json"
}
```

**Example — disable streaming for a project where you pipe output:**

```json
{
  "stream": false,
  "template": "minimal"
}
```

### Ancestor search boundary

osiris will never read config files outside your home directory (`~`), regardless of `searchDepth`. If you set `"searchDepth": 99` and your project is at `~/projects/app`, it will search up to `~` and stop — it will not read `/etc`, `/tmp`, or any other system path.

### All config keys

| Key | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | string | `http://localhost:1234/v1` | LM Studio server URL |
| `model` | string | auto-detect | Model name to request |
| `system` | string | `"You are a helpful CLI assistant."` | System prompt |
| `temperature` | number | `0.2` | Sampling temperature (0–2) |
| `maxTokens` | number | none | Max tokens in response |
| `stream` | boolean | `false` | Stream tokens as they arrive |
| `timeout` | number | `120` | HTTP timeout in seconds |
| `history` | string | none | Path to conversation history JSON file |
| `template` | string | `"default"` | Display template name |
| `searchDepth` | number | `3` | **Root config only.** How many parent directories to search for `.osiris.json` |

---

## CLI flags

All config keys can also be set via CLI flag — flags always win over config files.

```bash
osiris [--base-url URL] [--model NAME] [--system PROMPT]
       [--temperature N] [--max-tokens N] [--timeout SECONDS]
       [--stream] [--history FILE] [--once "message"] [--template NAME]
```

Environment variables `LMSTUDIO_BASE_URL` and `LMSTUDIO_MODEL` are also supported.

---

## Display templates

| Name | Description |
|---|---|
| `default` | Clean layout with subtle ANSI color |
| `fancy` | Box-drawing UI (╭─╮), full color, adapts to terminal width |
| `minimal` | Plain text, no ANSI codes — safe for piping |

Set via flag:
```bash
osiris --template fancy
```

Or in any config file:
```json
{ "template": "fancy" }
```

**Custom templates:** create `templates/mytheme.js` in the project root, export a default object with `prompt`, `welcome`, `response`, `streamStart`, `streamEnd`, `info`, and `error` methods, then use `--template mytheme`.

---

## Interactive commands

| Command | Description |
|---|---|
| `/exit`, `/quit` | Quit |
| `/reset` | Clear conversation, keep system prompt |
| `/save` | Save history to file (requires `--history`) |
| `/history` | Print full message list as JSON |

---

## Python version

A Python equivalent is also available at `lmstudio_agent.py`. Install with:

```bash
pip install -e .
osiris --stream
```

It supports all the same flags including `--once`, `--history`, and `--stream`. Config file loading uses the same `~/.osiris/config.json` and `.osiris.json` conventions.
