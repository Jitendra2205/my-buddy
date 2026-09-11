# 🤝 My Buddy

A local, single-process AI platform modeled on [Onyx](https://github.com/onyx-dot-app/onyx). Same feature *shape* — agents, connectors, knowledge retrieval with citations, actions, deep research, code execution, voice, usage analytics — but it runs as one Node process with JSON-file storage instead of Docker + Postgres + Vespa + Redis + Celery.

Runs on **Google Gemini** by default. Anthropic Claude is available as a second provider if you add its key.

## Setup

```
npm install
copy .env.example .env      # then add your GEMINI_API_KEY
npm start
```

Open http://localhost:3717. Get a Gemini key from [Google AI Studio](https://aistudio.google.com/apikey).

Run the tests with `npm test`.

## Features

### Chat
- **Streaming responses** with a live **trace** of what the agent is doing (searching the web, querying your documents, running code).
- **Extended thinking** shown as a collapsible "Thoughts" panel.
- **Inline citations** — click `[1]` to jump to the source in the side panel.
- **Chat history** with search, pinning, rename, and delete.
- **Voice**: dictate with your microphone, and have replies read aloud (browser speech APIs — nothing leaves your machine for this).
- **Dark by default**, with a light theme behind the toggle.

### Agents (Onyx: *Agents / Assistants*)
Four built in — My Buddy, Code Buddy, Research Buddy, Data Buddy — plus your own. Each agent has its own instructions, starter prompts, and per-agent tool switches:

| Tool | What it does |
|---|---|
| 📚 Knowledge | Searches your indexed documents (BM25) and cites excerpts |
| 🌐 Web search | Google Search grounding, with sources and inline citations |
| 🐍 Code interpreter | Runs Python in the provider's sandbox for real computation |
| 🖼️ Charts & images | Generates downloadable files/charts via code execution |
| ⚡ Actions | Calls HTTP APIs you define |

Agents can also be scoped to specific **document sets**, so they only search what's relevant.

### Deep Research (Onyx: *Deep Research*)
Toggle 🔬 Deep Research in the composer and the server runs a real multi-step flow: it **plans** sub-questions, **investigates them in parallel** (web + your documents), de-duplicates sources, then **writes a cited report**. Each phase streams into the chat as it completes.

### Connectors & Knowledge (Onyx: *Connectors / Document Sets / Explorer*)
- **Web page connector** — fetch a URL, strip the markup, index the readable text.
- **File upload** — txt, md, csv, json, and source code.
- **Paste text** — index notes directly.
- **Document Sets** — group documents and scope agents to them.
- **Document Explorer** — query the retrieval index directly and see BM25 scores, exactly what your agents see.

Retrieval is real BM25 (IDF + length normalization) over overlapping ~1200-char chunks — a local stand-in for Onyx's Vespa hybrid index.

### Actions (Onyx: *OpenAPI & MCP Actions*)
Define an HTTP endpoint with a name, description, method, headers, and a JSON Schema for its inputs. Enable it on an agent and the model can call it mid-conversation; results come back into the answer.

### Usage (Onyx: *Analytics*)
Model calls, input/output tokens, estimated cost at list price (priced per provider and model), and a daily token chart.

### Settings (Onyx: *LLM Models / Chat Preferences*)
Provider picker, a model list fetched live from the provider, effort level (`low` to `max`), thinking on/off and visibility, plus global tool switches.

## Providers

| | Gemini (default) | Anthropic |
|---|---|---|
| Key | `GEMINI_API_KEY` | `ANTHROPIC_API_KEY` |
| SDK | none — plain `fetch` | `@anthropic-ai/sdk` (optional dependency) |
| Web search | Google Search grounding | Server-side web search |
| Code execution | Gemini code execution | Anthropic code execution |

Each provider remembers its own model, so switching back and forth never points a Claude model id at Gemini. Conversation history is stored in one shared format and survives a provider switch.

Two Gemini quirks the adapter handles for you, both found the hard way:

- **Thought signatures.** Gemini 3 refuses a conversation that replays a tool call without the opaque signature it issued alongside it. The adapter carries that signature on its own block and hands it straight back — without this, every multi-step tool turn fails with a 400.
- **Built-ins vs. functions.** Gemini quietly stops running its own web search and code execution as soon as the request also declares functions; it hands those calls back to the client instead. So when an agent needs both (say, knowledge retrieval *and* web search), My Buddy declares the built-ins as ordinary functions and fulfils them with a focused single-tool sub-call. Agents with no functions keep the faster native path.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Required for chat on Gemini. |
| `ANTHROPIC_API_KEY` | — | Optional; enables the Anthropic provider. |
| `ACCESS_PASSWORD` | — | **Required when hosting.** Turns on HTTP Basic auth for every request. |
| `ACCESS_USER` | `buddy` | Username for that gate. |
| `PORT` | `3717` | Server port. |
| `HOST` | `127.0.0.1` | Loopback by default. Set `0.0.0.0` only when deploying. |
| `MY_BUDDY_PROVIDER` | `gemini` | Overrides the provider on startup. |
| `MY_BUDDY_MODEL` | `gemini-pro-latest` | Overrides the model on startup. |

### Keeping your API key safe

The key lives only in `.env` (git-ignored) or in the host's secret settings, is read server-side, and is never sent to the browser — `/api/config` reports only whether a key is present. Two rules matter:

1. **The server binds to `127.0.0.1` by default.** It is not reachable from your network unless you change `HOST`.
2. **If you expose it, set `ACCESS_PASSWORD`.** A deployed My Buddy is a direct line to your paid key; without a password, anyone with the URL can spend it. The server logs a warning at startup if you bind to a public interface without one.

## Hosting

My Buddy is a plain Node HTTP server, so it runs anywhere Node runs. It is **not** deployable to front-end-only platforms (Vercel static, Netlify, Lovable) — those don't run a long-lived Node process.

**Render** — a `render.yaml` blueprint is included. Push the repo, create a Blueprint service from it, then set `GEMINI_API_KEY` and `ACCESS_PASSWORD` in the dashboard. The blueprint mounts a 1 GB disk at `data/`; without a persistent disk every deploy wipes your chats and indexed documents.

**Railway / Fly.io / Cloud Run** — a `Dockerfile` is included. Set the same env vars as secrets and mount a volume at `/app/data`.

Whichever host you pick: set `HOST=0.0.0.0`, let the platform supply `PORT`, and never commit `.env`.

## How it compares to Onyx

| | Onyx | My Buddy |
|---|---|---|
| Services | Postgres, Vespa, Redis, Celery, Docker | One Node process |
| Dependencies | Hundreds | Zero required (Gemini via `fetch`) |
| Memory | 1 GB+ (Lite) | ~60 MB |
| Startup | Minutes | Under a second |
| Retrieval | Vespa hybrid (vector + keyword) | BM25 keyword |
| Connectors | 50+ (Slack, Drive, Confluence…) | Web page, file, paste |
| Auth / multi-user / SSO | ✅ | Single shared password |
| Agents, actions, deep research, citations, code exec, voice | ✅ | ✅ |

My Buddy is deliberately single-user. For team permissions, SSO, or indexing thousands of documents from SaaS connectors, use Onyx. For a fast personal assistant that starts instantly and keeps everything in one process, use this.

## Layout

```
server.js               HTTP server, access gate, all API routes
lib/providers/          Provider adapters behind one shared interface
  index.js              Registry, resolution, per-provider pricing
  gemini.js             Google Gemini (plain fetch, SSE streaming)
  anthropic.js          Anthropic Claude (optional)
lib/store.js            JSON persistence, chunking, BM25 index
lib/tools.js            Tool descriptors + knowledge/action/delegate execution
lib/chat.js             The agent loop (streaming, tools, artifacts)
lib/research.js         Deep Research orchestration
public/                 UI (no build step, no framework)
test/                   Unit tests — npm test
data/                   Your data — git-ignored
```
