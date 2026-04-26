# LM Studio CLI Agent

Simple command-line “agent” that talks to **LM Studio** using its **OpenAI-compatible** local API.

## Prerequisites

- Start LM Studio’s local server (in LM Studio: **Local Server** → **Start Server**)
- Default endpoint: `http://localhost:1234/v1`

## Install with npm

From **npm** (after you publish it):

```bash
npm i -g kalina
```

Directly from **GitHub** (no publish needed):

```bash
npm i -g github:<your-user>/<your-repo>
```

Dev install from a local clone:

```bash
npm i -g .
```

## Run

```bash
kalina --stream
```

Optional: persist conversation to a JSON file:

```bash
kalina --stream --history .\chat_history.json
```

Optional: override base URL / model (also supported via env vars `LMSTUDIO_BASE_URL` and `LMSTUDIO_MODEL`):

```bash
kalina --base-url http://localhost:1234/v1 --model local-model --stream
```

## CLI Commands

- `/exit`: quit
- `/reset`: clear conversation (keeps system prompt)
- `/save`: save history (requires `--history`)
- `/history`: print current in-memory message list

