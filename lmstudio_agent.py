import argparse
import json
import os
import pathlib
import sys
from typing import Any, Dict, List, Optional

import requests

# ---------------------------------------------------------------------------
# Debug logger — writes to stderr, activated via --debug
# ---------------------------------------------------------------------------
_debug_on = False

def _dbg(tag: str, msg: str, data: object = None) -> None:
    if not _debug_on:
        return
    sys.stderr.write(f"\x1b[2m[\x1b[0m\x1b[36m{tag}\x1b[0m\x1b[2m]\x1b[0m {msg}\n")
    if data is not None:
        sys.stderr.write(json.dumps(data, indent=2, ensure_ascii=False)
                         .replace("\n", "\n  ") + "\n")


DEFAULT_BASE_URL = os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234/v1")
DEFAULT_MODEL = os.environ.get("LMSTUDIO_MODEL")  # None → auto-detect from /v1/models

HOME = pathlib.Path.home()
ROOT_CONFIG_FILE = HOME / ".osiris" / "config.json"
PROJECT_CONFIG_NAME = ".osiris.json"

# Maps JSON config keys (camelCase) to argparse dest names (snake_case).
_CONFIG_TO_ARGPARSE: Dict[str, str] = {
    "baseUrl":     "base_url",
    "model":       "model",
    "system":      "argparse_system", # This is a bit tricky because of how I'll use it. Let's just map to the arg name.
    "temperature": "temperature",
    "maxTokens":   "max_tokens",
    "stream":      "stream",
    "timeout":     "timeout",
    "history":     "history",
}

# Actually, let's redefine it more simply to avoid confusion during the rewrite.
_CONFIG_MAP: Dict[str, str] = {
    "baseUrl":     "base_url",
    "model":       "model",
    "system":      "system",
    "temperature": "temperature",
    "maxTokens":   "max_tokens",
    "stream":      "stream",
    "timeout":     "timeout",
    "history":     "history",
}


def _read_json_file(p: pathlib.Path) -> Optional[dict]:
    try:
        if not p.exists():
            return None
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def load_config() -> dict:
    _dbg("config", f"checking root config: {ROOT_CONFIG_FILE}")
    root_cfg: dict = _read_json_file(ROOT_CONFIG_FILE) or {}
    if root_cfg:
        _dbg("config", "root config loaded", root_cfg)
    else:
        _dbg("config", "root config not found or empty — using defaults")

    search_depth = int(root_cfg.get("searchDepth", 3))
    _dbg("config", f"searchDepth = {search_depth}")

    cwd = pathlib.Path.cwd()
    ancestor_cfgs: list = []

    if cwd.is_relative_to(HOME):
        _dbg("config", f"cwd is within ~ — searching {search_depth} level(s) up")
        d = cwd
        for _ in range(search_depth):
            parent = d.parent
            if parent == d:  # filesystem root
                break
            d = parent
            if not d.is_relative_to(HOME):
                _dbg("config", f"stopped at {d} — outside ~")
                break
            cfg_path = d / PROJECT_CONFIG_NAME
            cfg = _read_json_file(cfg_path)
            if cfg:
                _dbg("config", f"ancestor config found: {cfg_path}", cfg)
                ancestor_cfgs.insert(0, cfg)
            else:
                _dbg("config", f"no config at: {cfg_path}")
    else:
        _dbg("config", f"cwd {cwd} is outside ~ — skipping ancestor search")

    cwd_cfg_path = cwd / PROJECT_CONFIG_NAME
    _dbg("config", f"checking cwd config: {cwd_cfg_path}")
    cwd_cfg: dict = _read_json_file(cwd_cfg_path) or {}
    if cwd_cfg:
        _dbg("config", "cwd config loaded", cwd_cfg)
    else:
        _dbg("config", "no cwd config found")

    merged = {k: v for k, v in root_cfg.items() if k != "searchDepth"}
    for cfg in ancestor_cfgs:
        merged.update(cfg)
    merged.update(cwd_cfg)

    if _debug_on:
        _dbg("config:merged", "final merged config", merged)

    return merged


def _url(base_url: str, path: str) -> str:
    return base_url.rstrip("/") + "/" + path.lstrip("/")


def fetch_loaded_models(base_url: str, timeout_s: float) -> List[str]:
    """Returns a list of IDs of currently loaded models."""
    url = _url(base_url, "/models")
    _dbg("models", f"GET {url} (timeout: {timeout_s}s)")
    try:
        r = requests.get(url, timeout=timeout_s)
        r.raise_for_status()
        models = r.json().get("data", [])
        model_ids = [m.get("id") for m in models if m.get("id")]
        _dbg("models", f"HTTP {r.status_code} — {len(model_ids)} model(s) loaded")
        return model_ids
    except Exception as e:
        _dbg("models", f"request error: {e}")
        return []


def _print_streaming_delta(resp: requests.Response) -> str:
    """
    Print streamed tokens as they arrive (OpenAI-compatible SSE).
    Returns the full assistant text collected.
    """
    full_text: List[str] = []
    for raw_line in resp.iter_lines(decode_unicode=True):
        if not raw_line:
            continue
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:") :].strip()
        if payload == "[DONE]":
            break
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        delta = (
            obj.get("choices", [{}])[0]
            .get("delta", {})
            .get("content")
        )
        if delta:
            sys.stdout.write(delta)
            sys.stdout.flush()
            full_text.append(delta)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return "".join(full_text)


def chat(
    base_url: str,
    model: str,
    messages: List[Dict[str, str]],
    temperature: float,
    max_tokens: Optional[int],
    stream: bool,
    timeout_s: float,
) -> str:
    body: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": stream,
    }
    if max_tokens is not None:
        body["max_tokens"] = max_tokens

    with requests.post(
        _url(base_url, "/chat/completions"),
        json=body,
        stream=stream,
        timeout=timeout_s,
    ) as r:
        r.raise_for_status()
        if stream:
            return _print_streaming_delta(r)
        data = r.json()
        return data["choices"][0]["message"]["content"]


def load_history(path: str) -> List[Dict[str, str]]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("History file must be a JSON list of messages.")
    for i, msg in enumerate(data):
        if not isinstance(msg, dict) or "role" not in msg or "content" not in msg:
            raise ValueError(f"Message at index {i} is missing 'role' or 'content'.")
    return data  # type: ignore[return-value]


def save_history(path: str, messages: List[Dict[str, str]]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)


def main() -> int:
    config = load_config()
    # Translate config keys to argparse dest names so set_defaults() can override them.
    # CLI args always beat set_defaults(), which in turn beats add_argument(default=...).
    argparse_defaults = {
        dest: config[cfg_key]
        for cfg_key, dest in _CONFIG_MAP.items()
        if cfg_key in config
    }

    p = argparse.ArgumentParser(description="Simple CLI agent for LM Studio (OpenAI-compatible API).")
    p.add_argument("--base-url", default=DEFAULT_BASE_URL, help="LM Studio base URL (default: %(default)s)")
    p.add_argument("--model", default=DEFAULT_MODEL, help="Model name to send (default: %(default)s)")
    p.add_argument("--system", default="You are a helpful CLI assistant.", help="System prompt")
    p.add_argument("--temperature", type=float, default=0.2, help="Sampling temperature")
    p.add_argument("--max-tokens", type=int, default=None, help="Max tokens in response")
    p.add_argument("--stream", action="store_true", help="Stream tokens")
    p.add_argument("--timeout", type=float, default=120.0, help="HTTP timeout in seconds")
    p.add_argument("--history", default=None, help="Path to JSON history file (optional)")
    p.add_argument("--once", default=None, metavar="MESSAGE", help="Send a single message and excludes (non-interactive)")
    p.add_argument("--debug", action="store_true", help="Print debug info for each step to stderr")
    p.set_defaults(**argparse_defaults)
    args = p.parse_args()

    global _debug_on
    if args.debug:
        _debug_on = True
        _dbg("debug", "debug mode enabled")
        _dbg("args", "parsed arguments", {k: v for k, v in vars(args).items() if k != "debug"})

    # 1. Check what models are actually loaded
    loaded_models = fetch_loaded_models(args.base_url, args.timeout)

    model = args.model
    if model:
        if model not in loaded_models:
            if not loaded_models:
                print(f"Error: Specified model '{model}' is not loaded and no other models are loaded.", file=sys.stderr)
                return 1
            else:
                print(f"Warning: Specified model '{model}' is not currently loaded.", file=sys.stderr)
                print(f"Loaded models: {', '.join(loaded_models)}", file=sys.stderr)
        else:
            _dbg("models", f"model set explicitly and is loaded: {model}")
    else:
        if not loaded_models:
            print("No model loaded in LM Studio. Load a model or pass --model.", file=sys.stderr)
            return 1
        model = loaded_models[0]
        print(f"Auto-selected model: {model}")

    messages: List[Dict[str, str]] = [{"role": "system", "content": args.system}]
    if args.history:
        try:
            hist = load_history(args.history)
            # If the file already contains a system message, keep it; otherwise keep CLI one.
            if hist and isinstance(hist, list) and hist[0].get("role") == "system":
                messages = hist
            else:
                messages.extend(hist)
        except Exception as e:
            print(f"Failed to load history: {e}", file=sys.stderr)
            return 2

    if args.once:
        messages.append({"role": "user", "content": args.once})
        try:
            assistant = chat(
                base_url=args.base_url,
                model=model,
                messages=messages,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                stream=args.stream,
                timeout_s=args.timeout,
            )
        except Exception as e:
            print(f"Request failed: {e}", file=sys.stderr)
            return 1
        if not args.stream:
            print(assistant)
        messages.append({"role": "assistant", "content": assistant})
        if args.history:
            try:
                save_history(args.history, messages)
            except Exception:
                pass
        return 0

    print(f"Connected to: {args.base_url}  |  model: {model}")
    print("Type your message. Commands: /exit, /reset, /save, /history\n")

    while True:
        try:
            user = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not user:
            continue
        if user in ("/exit", "/quit"):
            break
        if user == "/reset":
            messages = [{"role": "system", "content": args.system}]
            print("(history reset)")
            continue
        if user == "/history":
            print(json.dumps(messages, ensure_ascii=False, indent=2))
            continue
        if user == "/save":
            if not args.history:
                print("No --history path provided.")
                continue
            try:
                save_history(args.history, messages)
                print(f"(saved to {args.history})")
            except Exception as e:
                print(f"Failed to save: {else}", file=sys.stderr)
                continue

        messages.append({"role": "user", "content": user})
        try:
            assistant = chat(
                base_url=args.base_url,
                model=model,
                messages=messages,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                stream=args.stream,
                timeout_s=args.timeout,
            )
        except requests.RequestException as e:
            print(f"Request failed: {e}", file=sys.stderr)
            # Remove last user message so it can be retried cleanly.
            messages.pop()
            continue
        except Exception as e:
            print(f"Unexpected error: {e}", file=sys.stderr)
            messages.pop()
            continue

        if not args.stream:
            print(assistant)
        messages.append({"role": "assistant", "content": assistant})

        if args.history:
            # Best-effort autosave so the session survives crashes.
            try:
                save_history(args.history, messages)
            except Exception:
                pass

    if args.history:
        try:
            save_history(args.history, messages)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
