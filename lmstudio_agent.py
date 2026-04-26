import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

import requests


DEFAULT_BASE_URL = os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234/v1")
DEFAULT_MODEL = os.environ.get("LMSTUDIO_MODEL", "local-model")


def _url(base_url: str, path: str) -> str:
    return base_url.rstrip("/") + "/" + path.lstrip("/")


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
    return data  # type: ignore[return-value]


def save_history(path: str, messages: List[Dict[str, str]]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)


def main() -> int:
    p = argparse.ArgumentParser(description="Simple CLI agent for LM Studio (OpenAI-compatible API).")
    p.add_argument("--base-url", default=DEFAULT_BASE_URL, help="LM Studio base URL (default: %(default)s)")
    p.add_argument("--model", default=DEFAULT_MODEL, help="Model name to send (default: %(default)s)")
    p.add_argument("--system", default="You are a helpful CLI assistant.", help="System prompt")
    p.add_argument("--temperature", type=float, default=0.2, help="Sampling temperature")
    p.add_argument("--max-tokens", type=int, default=None, help="Max tokens in response")
    p.add_argument("--stream", action="store_true", help="Stream tokens")
    p.add_argument("--timeout", type=float, default=120.0, help="HTTP timeout in seconds")
    p.add_argument("--history", default=None, help="Path to JSON history file (optional)")
    args = p.parse_args()

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

    print(f"Connected target: {args.base_url}  |  model: {args.model}")
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
                print(f"Failed to save: {e}", file=sys.stderr)
            continue

        messages.append({"role": "user", "content": user})
        try:
            assistant = chat(
                base_url=args.base_url,
                model=args.model,
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
