// My Buddy — a local, Onyx-style AI platform in a single Node process.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------- .env loading (no dependency) ----------
const ENV_PATH = path.join(__dirname, ".env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const store = require("./lib/store");
const { state, persist, newId } = store;
const { runChat } = require("./lib/chat");
const { runResearch } = require("./lib/research");
const providers = require("./lib/providers");

const PORT = Number(process.env.PORT || 3717);
// Loopback by default: the server holds an API key, so it should not be
// reachable from the local network unless someone deliberately opens it.
// Hosting platforms need HOST=0.0.0.0 set explicitly.
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

if (process.env.MY_BUDDY_PROVIDER) state.settings.provider = process.env.MY_BUDDY_PROVIDER;
if (process.env.MY_BUDDY_MODEL) {
  state.settings.modelByProvider[state.settings.provider] = process.env.MY_BUDDY_MODEL;
}

// Keep the display field in step with the per-provider slots.
state.settings.model = providers.modelFor(providers.get(state.settings.provider), state.settings);

const hasKey = () => providers.anyKey();

// Bound to a public interface means a hosted instance, where there is no .env
// to edit — telling someone to edit one sends them looking for a file that
// isn't there.
const IS_HOSTED = HOST !== "127.0.0.1" && HOST !== "localhost";
const NO_KEY_MESSAGE = IS_HOSTED
  ? "No API key configured. Set GEMINI_API_KEY in this service's environment settings — the service restarts automatically."
  : "No API key configured. Add GEMINI_API_KEY to .env and restart the server.";

// The provider actually driving a turn, plus the model it should use.
function activeProvider() {
  const provider = providers.resolve(state.settings);
  return { provider, model: providers.modelFor(provider, state.settings) };
}

// ---------- access gate ----------
// A deployed My Buddy is a direct line to a paid API key, so anything reachable
// from the internet must be behind a password. Set ACCESS_PASSWORD and every
// request needs HTTP Basic credentials; leave it unset for loopback-only use.
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const ACCESS_USER = process.env.ACCESS_USER || "buddy";
const EXPECTED_AUTH = ACCESS_PASSWORD
  ? "Basic " + Buffer.from(`${ACCESS_USER}:${ACCESS_PASSWORD}`).toString("base64")
  : null;

function authorized(req) {
  if (!EXPECTED_AUTH) return true;
  const given = req.headers.authorization || "";
  const a = Buffer.from(given);
  const b = Buffer.from(EXPECTED_AUTH);
  // Compare in constant time, but only when the lengths already match —
  // timingSafeEqual throws on a length mismatch.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- helpers ----------
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const readJson = async (req) => JSON.parse((await readBody(req)).toString("utf8") || "{}");

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
    ? content.filter((b) => b.type === "text").map((b) => b.text).join("")
    : "";

// Strip tags/scripts from a fetched page so we index readable text.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A session whose very first message never landed is noise in Recents.
function dropIfEmpty(session) {
  if (session && !session.messages.length) {
    state.sessions = state.sessions.filter((s) => s.id !== session.id);
    persist.sessions();
  }
}

// ---------- chat endpoint ----------
async function handleChat(req, res, sessionId) {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return sendJson(res, 404, { error: "Session not found" });
  if (!hasKey()) {
    dropIfEmpty(session);
    return sendJson(res, 400, { error: NO_KEY_MESSAGE });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    dropIfEmpty(session);
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  const text = (body.text || "").trim();
  if (!text) {
    dropIfEmpty(session);
    return sendJson(res, 400, { error: "Empty message" });
  }

  const agent = state.agents.find((a) => a.id === session.agentId) || state.agents[0];
  const deepResearch = Boolean(body.deepResearch);

  session.messages.push({ role: "user", content: text });
  if (!session.title || session.title === "New chat") {
    session.title = text.length > 48 ? text.slice(0, 48) + "…" : text;
  }
  session.updatedAt = Date.now();
  persist.sessions();

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "Transfer-Encoding": "chunked",
  });
  const emit = (obj) => res.write(JSON.stringify(obj) + "\n");

  const { provider, model } = activeProvider();

  try {
    const runner = deepResearch ? runResearch : runChat;
    const result = await runner({
      provider,
      model,
      session,
      agent,
      settings: state.settings,
      topic: text,
      emit,
    });

    const last = session.messages[session.messages.length - 1];
    if (last && last.role === "assistant") {
      last.sources = result.sources;
      last.artifacts = result.artifacts;
    }
    session.updatedAt = Date.now();
    persist.sessions();

    emit({ type: "done", usage: result.usage, sources: result.sources, artifacts: result.artifacts });
  } catch (err) {
    // Roll the user turn back so a failed exchange doesn't poison history.
    const idx = session.messages.findIndex((m) => m.role === "user" && m.content === text);
    if (idx >= 0) session.messages.splice(idx);
    persist.sessions();

    emit({ type: "error", error: providers.describeError(err, provider) });
  }
  dropIfEmpty(session);
  res.end();
}

// ---------- static ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;
  let m;

  // Health checks run before the gate — a platform probe has no credentials,
  // and a 401 here would read as "unhealthy" and fail the deploy. It reports
  // liveness only: no settings, no counts, nothing about the key.
  if (p === "/healthz") {
    return sendJson(res, 200, { status: "ok", uptime: Math.round(process.uptime()) });
  }

  if (!authorized(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="My Buddy", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Authentication required.");
  }

  try {
    // --- config & settings ---
    if (p === "/api/config" && method === "GET") {
      const { provider, model } = activeProvider();
      return sendJson(res, 200, {
        hasKey: hasKey(),
        noKeyMessage: NO_KEY_MESSAGE,
        settings: state.settings,
        providers: providers.summary(),
        active: { provider: provider.id, label: provider.label, model, ready: provider.hasKey() },
        counts: {
          agents: state.agents.length,
          documents: state.documents.length,
          docSets: state.docSets.length,
          actions: state.actions.length,
          sessions: state.sessions.length,
        },
      });
    }
    if (p === "/api/settings" && method === "PUT") {
      const body = await readJson(req);
      // `model` always means "the model for the provider in play", so route it
      // into that provider's slot rather than letting it leak across providers.
      const targetProvider = body.provider || state.settings.provider;
      if (body.model) {
        state.settings.modelByProvider = {
          ...state.settings.modelByProvider,
          [targetProvider]: String(body.model).slice(0, 120),
        };
        delete body.model;
      }
      Object.assign(state.settings, body);
      state.settings.model = providers.modelFor(providers.get(state.settings.provider), state.settings);
      persist.settings();
      return sendJson(res, 200, state.settings);
    }

    // Live model catalogue for the settings page; falls back to a static list.
    if (p === "/api/models" && method === "GET") {
      const provider = providers.get(url.searchParams.get("provider") || state.settings.provider);
      return sendJson(res, 200, {
        provider: provider.id,
        hasKey: provider.hasKey(),
        models: await provider.listModels(),
      });
    }

    // --- agents ---
    if (p === "/api/agents" && method === "GET") return sendJson(res, 200, state.agents);
    if (p === "/api/agents" && method === "POST") {
      const b = await readJson(req);
      const agent = {
        id: newId("agent"),
        name: String(b.name || "New Agent").slice(0, 60),
        emoji: String(b.emoji || "🧩").slice(0, 8),
        description: String(b.description || "").slice(0, 300),
        system: String(b.system || "").slice(0, 40000),
        tools: {
          webSearch: !!b.tools?.webSearch,
          codeInterpreter: !!b.tools?.codeInterpreter,
          knowledge: b.tools?.knowledge !== false,
          imageGen: !!b.tools?.imageGen,
        },
        docSetIds: Array.isArray(b.docSetIds) ? b.docSetIds : [],
        actionIds: Array.isArray(b.actionIds) ? b.actionIds : [],
        starters: Array.isArray(b.starters) ? b.starters.slice(0, 4) : [],
        builtin: false,
      };
      state.agents.push(agent);
      persist.agents();
      return sendJson(res, 200, agent);
    }
    if ((m = p.match(/^\/api\/agents\/([\w]+)$/)) && method === "PUT") {
      const agent = state.agents.find((a) => a.id === m[1]);
      if (!agent) return sendJson(res, 404, { error: "Not found" });
      const b = await readJson(req);
      Object.assign(agent, {
        name: b.name ?? agent.name,
        emoji: b.emoji ?? agent.emoji,
        description: b.description ?? agent.description,
        system: b.system ?? agent.system,
        tools: { ...agent.tools, ...(b.tools || {}) },
        docSetIds: b.docSetIds ?? agent.docSetIds,
        actionIds: b.actionIds ?? agent.actionIds,
        starters: b.starters ?? agent.starters,
      });
      persist.agents();
      return sendJson(res, 200, agent);
    }
    if ((m = p.match(/^\/api\/agents\/([\w]+)$/)) && method === "DELETE") {
      const agent = state.agents.find((a) => a.id === m[1]);
      if (!agent) return sendJson(res, 404, { error: "Not found" });
      if (agent.builtin) return sendJson(res, 400, { error: "Built-in agents can't be deleted" });
      state.agents = state.agents.filter((a) => a.id !== m[1]);
      persist.agents();
      return sendJson(res, 200, { ok: true });
    }

    // --- sessions ---
    if (p === "/api/sessions" && method === "GET") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      let list = state.sessions.slice().sort((a, b) => {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        return b.updatedAt - a.updatedAt;
      });
      if (q) {
        list = list.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.messages.some((msg) => textOf(msg.content).toLowerCase().includes(q))
        );
      }
      return sendJson(
        res,
        200,
        list.map((s) => ({
          id: s.id,
          title: s.title,
          agentId: s.agentId,
          pinned: !!s.pinned,
          updatedAt: s.updatedAt,
          messageCount: s.messages.filter((x) => x.role !== "user" || typeof x.content === "string").length,
        }))
      );
    }
    if (p === "/api/sessions" && method === "POST") {
      const b = await readJson(req);
      const session = {
        id: newId("sesn"),
        title: "New chat",
        agentId: b.agentId || state.agents[0].id,
        pinned: false,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.sessions.push(session);
      persist.sessions();
      return sendJson(res, 200, session);
    }
    if ((m = p.match(/^\/api\/sessions\/([\w]+)$/)) && method === "GET") {
      const s = state.sessions.find((x) => x.id === m[1]);
      if (!s) return sendJson(res, 404, { error: "Not found" });
      const display = [];
      for (const msg of s.messages) {
        if (msg.role === "user" && typeof msg.content === "string") {
          display.push({ role: "user", text: msg.content });
        } else if (msg.role === "assistant") {
          const t = textOf(msg.content);
          if (t) display.push({ role: "assistant", text: t, sources: msg.sources || [], artifacts: msg.artifacts || [] });
        }
      }
      return sendJson(res, 200, { id: s.id, title: s.title, agentId: s.agentId, pinned: !!s.pinned, messages: display });
    }
    if ((m = p.match(/^\/api\/sessions\/([\w]+)$/)) && method === "PUT") {
      const s = state.sessions.find((x) => x.id === m[1]);
      if (!s) return sendJson(res, 404, { error: "Not found" });
      const b = await readJson(req);
      if (b.title !== undefined) s.title = String(b.title).slice(0, 120);
      if (b.pinned !== undefined) s.pinned = !!b.pinned;
      if (b.agentId !== undefined) s.agentId = b.agentId;
      persist.sessions();
      return sendJson(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/sessions\/([\w]+)$/)) && method === "DELETE") {
      state.sessions = state.sessions.filter((x) => x.id !== m[1]);
      persist.sessions();
      return sendJson(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/sessions\/([\w]+)\/chat$/)) && method === "POST") {
      return handleChat(req, res, m[1]);
    }

    // --- documents / connectors ---
    if (p === "/api/documents" && method === "GET") {
      return sendJson(
        res,
        200,
        state.documents.map((d) => ({
          id: d.id,
          name: d.name,
          source: d.source,
          url: d.url,
          docSetIds: d.docSetIds,
          chunkCount: d.chunkCount,
          charCount: d.charCount,
          createdAt: d.createdAt,
        }))
      );
    }
    // File connector: raw text body, name in query.
    if (p === "/api/documents/file" && method === "POST") {
      const name = (url.searchParams.get("name") || "document.txt").slice(0, 160);
      const setId = url.searchParams.get("docSetId");
      const text = (await readBody(req)).toString("utf8");
      if (text.includes(" ")) return sendJson(res, 400, { error: "Binary files aren't supported — upload text (txt, md, csv, code, json)." });
      if (!text.trim()) return sendJson(res, 400, { error: "File is empty" });
      const doc = store.addDocument({ name, source: "file", text, docSetIds: setId ? [setId] : [] });
      return sendJson(res, 200, { id: doc.id, name: doc.name, chunkCount: doc.chunkCount });
    }
    // Web connector: fetch a URL and index its readable text.
    if (p === "/api/documents/web" && method === "POST") {
      const b = await readJson(req);
      let target;
      try {
        target = new URL(b.url);
        if (!/^https?:$/.test(target.protocol)) throw new Error("bad protocol");
      } catch {
        return sendJson(res, 400, { error: "Enter a valid http(s) URL" });
      }
      let html;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const resp = await fetch(target.toString(), {
          headers: { "User-Agent": "MyBuddy/1.0 (local knowledge indexer)" },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) return sendJson(res, 400, { error: `Fetch failed: HTTP ${resp.status}` });
        html = await resp.text();
      } catch (err) {
        return sendJson(res, 400, { error: `Fetch failed: ${err.message}` });
      }
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim();
      const text = htmlToText(html);
      if (text.length < 100) return sendJson(res, 400, { error: "Page had no extractable text" });
      const doc = store.addDocument({
        name: (title || target.hostname).slice(0, 160),
        source: "web",
        url: target.toString(),
        text,
        docSetIds: b.docSetId ? [b.docSetId] : [],
      });
      return sendJson(res, 200, { id: doc.id, name: doc.name, chunkCount: doc.chunkCount });
    }
    // Paste-text connector.
    if (p === "/api/documents/text" && method === "POST") {
      const b = await readJson(req);
      if (!b.text || !b.text.trim()) return sendJson(res, 400, { error: "Nothing to index" });
      const doc = store.addDocument({
        name: (b.name || "Pasted note").slice(0, 160),
        source: "file",
        text: b.text,
        docSetIds: b.docSetId ? [b.docSetId] : [],
      });
      return sendJson(res, 200, { id: doc.id, name: doc.name, chunkCount: doc.chunkCount });
    }
    if ((m = p.match(/^\/api\/documents\/([\w]+)$/)) && method === "PUT") {
      const doc = state.documents.find((d) => d.id === m[1]);
      if (!doc) return sendJson(res, 404, { error: "Not found" });
      const b = await readJson(req);
      if (Array.isArray(b.docSetIds)) doc.docSetIds = b.docSetIds;
      persist.documents();
      return sendJson(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/documents\/([\w]+)$/)) && method === "DELETE") {
      state.documents = state.documents.filter((d) => d.id !== m[1]);
      persist.documents();
      return sendJson(res, 200, { ok: true });
    }
    // Document explorer: search the index directly.
    if (p === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q") || "";
      const setId = url.searchParams.get("docSetId");
      return sendJson(
        res,
        200,
        store.searchKnowledge(q, { topK: 12, docSetIds: setId ? [setId] : null })
      );
    }

    // --- document sets ---
    if (p === "/api/docsets" && method === "GET") {
      return sendJson(
        res,
        200,
        state.docSets.map((s) => ({
          ...s,
          docCount: state.documents.filter((d) => (d.docSetIds || []).includes(s.id)).length,
        }))
      );
    }
    if (p === "/api/docsets" && method === "POST") {
      const b = await readJson(req);
      const set = {
        id: newId("set"),
        name: String(b.name || "New set").slice(0, 80),
        description: String(b.description || "").slice(0, 300),
      };
      state.docSets.push(set);
      persist.docSets();
      return sendJson(res, 200, set);
    }
    if ((m = p.match(/^\/api\/docsets\/([\w]+)$/)) && method === "DELETE") {
      state.docSets = state.docSets.filter((s) => s.id !== m[1]);
      for (const d of state.documents) d.docSetIds = (d.docSetIds || []).filter((x) => x !== m[1]);
      persist.docSets();
      persist.documents();
      return sendJson(res, 200, { ok: true });
    }

    // --- actions ---
    if (p === "/api/actions" && method === "GET") return sendJson(res, 200, state.actions);
    if (p === "/api/actions" && method === "POST") {
      const b = await readJson(req);
      if (!/^[a-z0-9_]{1,60}$/i.test(b.name || ""))
        return sendJson(res, 400, { error: "Name must be letters, numbers, and underscores only" });
      const action = {
        id: newId("act"),
        name: b.name,
        description: String(b.description || "").slice(0, 500),
        method: (b.method || "GET").toUpperCase(),
        url: String(b.url || ""),
        headers: b.headers && typeof b.headers === "object" ? b.headers : {},
        inputSchema: b.inputSchema || '{"type":"object","properties":{}}',
        enabled: b.enabled !== false,
      };
      state.actions.push(action);
      persist.actions();
      return sendJson(res, 200, action);
    }
    if ((m = p.match(/^\/api\/actions\/([\w]+)$/)) && method === "DELETE") {
      state.actions = state.actions.filter((a) => a.id !== m[1]);
      for (const agent of state.agents) agent.actionIds = (agent.actionIds || []).filter((x) => x !== m[1]);
      persist.actions();
      persist.agents();
      return sendJson(res, 200, { ok: true });
    }

    // --- artifacts ---
    if ((m = p.match(/^\/api\/artifacts\/(art_[a-f0-9]+)$/)) && method === "GET") {
      const file = store.artifactPath(m[1]);
      if (!file) return sendJson(res, 404, { error: "Not found" });
      const name = path.basename(file).split("__").slice(1).join("__");
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(name)] || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
      });
      return fs.createReadStream(file).pipe(res);
    }

    // --- usage analytics ---
    if (p === "/api/usage" && method === "GET") {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const recent = state.usage.filter((u) => now - u.ts < 30 * day);
      // Cost is estimated per entry, since usage can span providers and models
      // whose list prices differ by an order of magnitude.
      const totals = recent.reduce(
        (acc, u) => {
          const rate = providers.get(u.provider || "anthropic").price(u.model);
          acc.input += u.input || 0;
          acc.output += u.output || 0;
          acc.estimatedCost += ((u.input || 0) / 1e6) * rate.in + ((u.output || 0) / 1e6) * rate.out;
          acc.calls += 1;
          return acc;
        },
        { input: 0, output: 0, calls: 0, estimatedCost: 0 }
      );
      const byDay = {};
      for (const u of recent) {
        const key = new Date(u.ts).toISOString().slice(0, 10);
        byDay[key] = byDay[key] || { date: key, input: 0, output: 0, calls: 0 };
        byDay[key].input += u.input || 0;
        byDay[key].output += u.output || 0;
        byDay[key].calls += 1;
      }
      return sendJson(res, 200, {
        totals,
        byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
        messages: state.sessions.reduce((n, s) => n + s.messages.length, 0),
      });
    }

    if (p.startsWith("/api/")) return sendJson(res, 404, { error: "Unknown API route" });

    serveStatic(res, p);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message || "Server error" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const { provider, model } = activeProvider();
  console.log(`My Buddy running at http://localhost:${PORT}`);
  if (hasKey()) console.log(`Provider: ${provider.label} · model ${model}`);
  else console.log("API key: NOT configured — add GEMINI_API_KEY to .env and restart");

  if (EXPECTED_AUTH) console.log(`Access: password required (user "${ACCESS_USER}")`);
  else if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.warn(
      `WARNING: listening on ${HOST} with no ACCESS_PASSWORD set. Anyone who can reach this port can spend your API key.`
    );
  }
});
