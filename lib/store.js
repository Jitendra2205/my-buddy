// JSON-file persistence + a small BM25 keyword index (My Buddy's stand-in for
// Onyx's Postgres + Vespa hybrid index).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

function save(name, data) {
  ensureDirs();
  const file = path.join(DATA_DIR, name);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;

// ---------------- defaults ----------------

const DEFAULT_SETTINGS = {
  provider: "gemini",
  model: "gemini-pro-latest",
  // Each provider remembers its own model so switching back and forth doesn't
  // leave, say, a Claude model id pointed at Gemini.
  modelByProvider: { gemini: "gemini-pro-latest", anthropic: "claude-opus-5" },
  effort: "high",
  thinking: true,
  showThinking: true,
  webSearchEnabled: true,
  codeInterpreterEnabled: true,
  knowledgeEnabled: true,
  imageGenEnabled: true,
  voiceEnabled: true,
  maxSearchResults: 6,
  retrievalTopK: 6,
};

const DEFAULT_AGENTS = [
  {
    id: "general",
    name: "My Buddy",
    emoji: "🤝",
    description: "Your everyday assistant for anything.",
    system:
      "You are My Buddy, a warm, sharp personal assistant. Be genuinely helpful and direct. Keep responses focused; go deep only when the question calls for it.",
    tools: { webSearch: false, codeInterpreter: false, knowledge: true, imageGen: false },
    docSetIds: [],
    actionIds: [],
    starters: ["What can you help me with?", "Summarize my documents", "Draft an email"],
    builtin: true,
  },
  {
    id: "coder",
    name: "Code Buddy",
    emoji: "💻",
    description: "Programming help, debugging, and code execution.",
    system:
      "You are Code Buddy, an expert software engineer. Give working, idiomatic code with brief explanations. Point out bugs and pitfalls plainly. When analysis or computation would help, use the code interpreter rather than guessing.",
    tools: { webSearch: false, codeInterpreter: true, knowledge: true, imageGen: false },
    docSetIds: [],
    actionIds: [],
    starters: ["Review this function", "Why does this test fail?", "Plot this data"],
    builtin: true,
  },
  {
    id: "researcher",
    name: "Research Buddy",
    emoji: "🔎",
    description: "Web research with cited, current information.",
    system:
      "You are Research Buddy. For questions where current information would change the answer (recent events, prices, versions, releases), search the web before answering rather than answering from memory. Always cite sources. Note where sources disagree.",
    tools: { webSearch: true, codeInterpreter: false, knowledge: true, imageGen: false },
    docSetIds: [],
    actionIds: [],
    starters: ["What happened this week in AI?", "Compare these two products", "Find recent research on X"],
    builtin: true,
  },
  {
    id: "analyst",
    name: "Data Buddy",
    emoji: "📊",
    description: "Analyzes data and generates charts you can download.",
    system:
      "You are Data Buddy, a data analyst. Use the code interpreter to compute real results — never estimate numbers you could calculate. Produce charts as image files when a visual helps, and explain what the data shows in plain language.",
    tools: { webSearch: false, codeInterpreter: true, knowledge: true, imageGen: true },
    docSetIds: [],
    actionIds: [],
    starters: ["Chart this CSV", "Find trends in my data", "Run a quick statistical test"],
    builtin: true,
  },
];

// ---------------- state ----------------

const savedSettings = load("settings.json", {});

// v1 settings predate the provider layer: their `model` was always a Claude
// model, so file it under Anthropic and start fresh on Gemini.
if (savedSettings.model && !savedSettings.provider) {
  savedSettings.modelByProvider = {
    ...DEFAULT_SETTINGS.modelByProvider,
    anthropic: savedSettings.model,
    ...(savedSettings.modelByProvider || {}),
  };
  delete savedSettings.model;
}

const state = {
  settings: {
    ...DEFAULT_SETTINGS,
    ...savedSettings,
    modelByProvider: {
      ...DEFAULT_SETTINGS.modelByProvider,
      ...(savedSettings.modelByProvider || {}),
    },
  },
  agents: load("agents.json", null) || DEFAULT_AGENTS,
  sessions: load("sessions.json", []),
  documents: load("documents.json", []),
  docSets: load("docsets.json", []),
  actions: load("actions.json", []),
  usage: load("usage.json", []),
};

// Migrate v1 "buddies.json" into agents if present and agents were unset.
if (!load("agents.json", null)) {
  const legacy = load("buddies.json", null);
  if (Array.isArray(legacy)) {
    for (const b of legacy) {
      if (state.agents.some((a) => a.id === b.id)) continue;
      state.agents.push({
        id: b.id,
        name: b.name,
        emoji: b.emoji,
        description: b.description,
        system: b.system,
        tools: { webSearch: !!b.webSearch, codeInterpreter: false, knowledge: true, imageGen: false },
        docSetIds: [],
        actionIds: [],
        starters: [],
        builtin: false,
      });
    }
  }
  save("agents.json", state.agents);
}

const persist = {
  settings: () => save("settings.json", state.settings),
  agents: () => save("agents.json", state.agents),
  sessions: () => save("sessions.json", state.sessions),
  documents: () => save("documents.json", state.documents),
  docSets: () => save("docsets.json", state.docSets),
  actions: () => save("actions.json", state.actions),
  usage: () => save("usage.json", state.usage),
};

// ---------------- chunking + BM25 ----------------

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i if in is it its of on or that the this to was were what when where which who will with you your".split(
    " "
  )
);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) || []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

// Split on paragraph boundaries into ~1200-char chunks with light overlap.
function chunkText(text, size = 1200, overlap = 150) {
  const paras = text.split(/\n\s*\n/);
  const chunks = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length > size) {
      chunks.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - overlap));
    }
    buf += (buf ? "\n\n" : "") + p;
    while (buf.length > size * 1.6) {
      chunks.push(buf.slice(0, size).trim());
      buf = buf.slice(size - overlap);
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(Boolean);
}

function addDocument({ name, source, url, text, docSetIds = [] }) {
  const chunks = chunkText(text).map((t, i) => ({
    id: `${i}`,
    text: t,
    tokens: tokenize(t),
  }));
  const doc = {
    id: newId("doc"),
    name,
    source,
    url: url || null,
    docSetIds,
    chunkCount: chunks.length,
    charCount: text.length,
    chunks,
    createdAt: Date.now(),
  };
  state.documents.push(doc);
  persist.documents();
  return doc;
}

// BM25 over chunks, optionally scoped to document sets or explicit doc ids.
function searchKnowledge(query, { topK = 6, docSetIds = null, docIds = null } = {}) {
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];

  let docs = state.documents;
  if (docIds && docIds.length) docs = docs.filter((d) => docIds.includes(d.id));
  if (docSetIds && docSetIds.length) {
    docs = docs.filter((d) => (d.docSetIds || []).some((s) => docSetIds.includes(s)));
  }
  if (!docs.length) return [];

  const chunks = [];
  for (const d of docs) for (const c of d.chunks) chunks.push({ doc: d, chunk: c });
  if (!chunks.length) return [];

  const N = chunks.length;
  const avgLen = chunks.reduce((s, c) => s + c.chunk.tokens.length, 0) / N || 1;
  const df = new Map();
  for (const t of new Set(qTokens)) {
    let n = 0;
    for (const c of chunks) if (c.chunk.tokens.includes(t)) n++;
    df.set(t, n);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored = chunks.map((c) => {
    const len = c.chunk.tokens.length || 1;
    let score = 0;
    for (const t of qTokens) {
      const n = df.get(t) || 0;
      if (!n) continue;
      let f = 0;
      for (const tok of c.chunk.tokens) if (tok === t) f++;
      if (!f) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return { ...c, score };
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((c, i) => ({
      n: i + 1,
      docId: c.doc.id,
      docName: c.doc.name,
      url: c.doc.url,
      source: c.doc.source,
      chunkId: c.chunk.id,
      score: Number(c.score.toFixed(3)),
      text: c.chunk.text,
    }));
}

function recordUsage(entry) {
  state.usage.push({ ts: Date.now(), ...entry });
  if (state.usage.length > 5000) state.usage = state.usage.slice(-5000);
  persist.usage();
}

function saveArtifact(name, buffer) {
  ensureDirs();
  const id = newId("art");
  const safe = path.basename(name).replace(/[^\w.\-]/g, "_") || "artifact";
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}__${safe}`), buffer);
  return { id, name: safe, size: buffer.length };
}

function artifactPath(id) {
  if (!/^art_[a-f0-9]+$/.test(id)) return null;
  const match = fs.readdirSync(ARTIFACT_DIR).find((f) => f.startsWith(id + "__"));
  return match ? path.join(ARTIFACT_DIR, match) : null;
}

ensureDirs();

module.exports = {
  state,
  persist,
  newId,
  addDocument,
  searchKnowledge,
  chunkText,
  recordUsage,
  saveArtifact,
  artifactPath,
  DEFAULT_SETTINGS,
  DATA_DIR,
};
