// Google Gemini adapter.
//
// Speaks the normalized message shape used everywhere else in My Buddy (an
// Anthropic-style block list, which is also what sessions.json stores) and
// translates it to and from Gemini's `contents` / `parts` wire format. Uses
// plain fetch — no SDK — to keep the zero-dependency spirit of the project.

const { saveArtifact } = require("../store");

const BASE = "https://generativelanguage.googleapis.com/v1beta";

// Fallbacks only — the live list from /models wins when the API is reachable.
// The `-latest` aliases track Google's current stable release of each tier.
const STATIC_MODELS = [
  "gemini-pro-latest",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

// Rough USD per million tokens, matched by substring, most specific first.
// Used only for the cost estimate on the Usage page.
const PRICES = [
  ["flash-lite", { in: 0.1, out: 0.4 }],
  ["flash", { in: 0.3, out: 2.5 }],
  ["pro", { in: 1.25, out: 10 }],
];

const hasKey = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const apiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

// ---------------------------------------------------------------- schema ----

// Gemini accepts a narrow OpenAPI subset. Anything else is a 400, so we keep
// only the fields it knows and uppercase the type enum.
const SCHEMA_KEYS = new Set([
  "type", "description", "properties", "required", "items", "enum", "nullable",
  "format", "minItems", "maxItems", "title",
]);

function cleanSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "OBJECT", properties: {} };
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "type") out.type = String(v).toUpperCase();
    else if (k === "properties") {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v || {})) out.properties[pk] = cleanSchema(pv);
    } else if (k === "items") out.items = cleanSchema(v);
    else out[k] = v;
  }
  // These are always tool-parameter or response schemas, so an untyped schema
  // is an object unless it clearly describes a list.
  if (!out.type) out.type = out.items ? "ARRAY" : "OBJECT";
  if (out.type === "OBJECT" && !out.properties) out.properties = {};
  return out;
}

// ------------------------------------------------------------- messages ----

// Our tool_result blocks carry a tool_use_id; Gemini matches responses to calls
// by tool *name*, so we remember what each id was called.
function toContents(messages) {
  const nameById = new Map();
  const contents = [];

  for (const m of messages) {
    if (m.role === "assistant") {
      const parts = [];
      for (const b of m.content || []) {
        // Gemini 3 rejects a conversation that replays a tool call without the
        // opaque thought signature it issued with it, so we carry the
        // signature on our own block and hand it straight back.
        const sig = b.signature ? { thoughtSignature: b.signature } : {};
        if (b.type === "text" && b.text) parts.push({ text: b.text, ...sig });
        else if (b.type === "tool_use") {
          nameById.set(b.id, b.name);
          parts.push({ functionCall: { name: b.name, args: b.input || {} }, ...sig });
        }
        // Thinking blocks are deliberately dropped: the reasoning text itself
        // is not replayable, only its signature, which rides on the call above.
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    if (typeof m.content === "string") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
      continue;
    }

    const parts = [];
    for (const b of m.content || []) {
      if (b.type === "tool_result") {
        const name = nameById.get(b.tool_use_id) || "tool";
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        parts.push({
          functionResponse: {
            name,
            response: b.is_error ? { error: text } : { result: text },
          },
        });
      } else if (b.type === "text" && b.text) {
        parts.push({ text: b.text });
      }
    }
    if (parts.length) contents.push({ role: "user", parts });
  }

  return contents;
}

function toTools(tools) {
  const decls = [];
  const out = [];
  for (const t of tools || []) {
    if (t.kind === "function") {
      decls.push({
        name: t.name,
        description: t.description || `Call ${t.name}.`,
        parameters: cleanSchema(t.parameters),
      });
    } else if (t.kind === "web_search") {
      out.push({ googleSearch: {} });
    } else if (t.kind === "code_execution") {
      out.push({ codeExecution: {} });
    }
  }
  if (decls.length) out.push({ functionDeclarations: decls });
  return out.length ? out : undefined;
}

// Gemini budgets thinking in tokens rather than by effort label.
const THINKING_BUDGET = { low: 1024, medium: 8192, high: 24576, xhigh: -1, max: -1 };

function thinkingConfig(settings) {
  if (!settings.thinking) return { thinkingBudget: 0 };
  return {
    thinkingBudget: THINKING_BUDGET[settings.effort] ?? 8192,
    includeThoughts: settings.showThinking !== false,
  };
}

// ------------------------------------------------------------- requests ----

class GeminiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Features vary by model and by account. Rather than maintaining a capability
// matrix, drop whichever feature the API complained about and try once more.
const MITIGATIONS = [
  {
    id: "thinking",
    test: (msg) => /thinking|thought/i.test(msg),
    apply: (body) => { delete body.generationConfig.thinkingConfig; },
  },
  {
    id: "search",
    test: (msg) => /google.?search|grounding|search.?tool/i.test(msg),
    apply: (body) => { body.tools = (body.tools || []).filter((t) => !t.googleSearch); },
  },
  {
    id: "code",
    test: (msg) => /code.?execution/i.test(msg),
    apply: (body) => { body.tools = (body.tools || []).filter((t) => !t.codeExecution); },
  },
  {
    id: "schema",
    test: (msg) => /schema|response.?mime/i.test(msg),
    apply: (body) => {
      delete body.generationConfig.responseSchema;
      delete body.generationConfig.responseMimeType;
    },
  },
];

async function request(model, method, body, { stream = false } = {}) {
  if (!hasKey()) throw new GeminiError("No Gemini API key configured.", 401);

  const applied = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = `${BASE}/models/${encodeURIComponent(model)}:${method}${stream ? "?alt=sse" : ""}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;

    const text = await res.text();
    let detail = text;
    try {
      detail = JSON.parse(text).error?.message || text;
    } catch {
      /* keep the raw body */
    }

    const mitigation =
      res.status === 400 && MITIGATIONS.find((mg) => !applied.has(mg.id) && mg.test(detail));
    if (mitigation) {
      applied.add(mitigation.id);
      mitigation.apply(body);
      continue;
    }
    throw new GeminiError(detail, res.status, text);
  }
  throw new GeminiError("Gemini rejected the request after retries.", 400);
}

async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const tail = buf.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

// --------------------------------------------------------------- results ----

const FINISH_REASONS = {
  SAFETY: "refusal",
  PROHIBITED_CONTENT: "refusal",
  BLOCKLIST: "refusal",
  SPII: "refusal",
  RECITATION: "refusal",
  MAX_TOKENS: "max_tokens",
};

// Grounding offsets are byte positions into the UTF-8 answer, so splice on a
// Buffer rather than on the JS string.
function injectCitations(text, supports, chunkNumbers) {
  if (!text || !supports || !supports.length) return text;
  const marks = new Map();
  for (const s of supports) {
    const end = s.segment?.endIndex;
    if (typeof end !== "number") continue;
    const ns = (s.groundingChunkIndices || [])
      .map((i) => chunkNumbers[i])
      .filter(Boolean);
    if (!ns.length) continue;
    const existing = marks.get(end) || new Set();
    for (const n of ns) existing.add(n);
    marks.set(end, existing);
  }
  if (!marks.size) return text;

  const buf = Buffer.from(text, "utf8");
  const cuts = [...marks.keys()].sort((a, b) => b - a);
  let out = buf;
  for (const at of cuts) {
    if (at > out.length) continue;
    const tag = [...marks.get(at)].sort((a, b) => a - b).map((n) => `[${n}]`).join("");
    out = Buffer.concat([out.subarray(0, at), Buffer.from(tag, "utf8"), out.subarray(at)]);
  }
  return out.toString("utf8");
}

function collectUsage(meta) {
  return {
    input: meta?.promptTokenCount || 0,
    output: (meta?.candidatesTokenCount || 0) + (meta?.thoughtsTokenCount || 0),
  };
}

// -------------------------------------------------------------- exports ----

function buildBody({ system, messages, tools, settings, maxTokens, effort, jsonSchema }) {
  const body = {
    contents: toContents(messages),
    generationConfig: {
      maxOutputTokens: maxTokens || 32000,
      thinkingConfig: thinkingConfig({ ...settings, effort: effort || settings.effort }),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const t = toTools(tools);
  if (t) body.tools = t;
  if (jsonSchema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = cleanSchema(jsonSchema);
    delete body.generationConfig.thinkingConfig;
  }
  return body;
}

// Streams a turn, emitting normalized events, and resolves to a normalized
// final message: { content, stop_reason, usage, sources, artifacts }.
async function stream({ model, system, messages, tools, settings, emit, sourceOffset = 0 }) {
  const body = buildBody({ system, messages, tools, settings });
  const res = await request(model, "streamGenerateContent", body, { stream: true });

  const content = [];
  const artifacts = [];
  const groundChunks = [];
  const groundSupports = [];
  let text = "";
  let thinking = "";
  let usage = { input: 0, output: 0 };
  let finish = null;
  let codeRunning = false;
  let textSignature = null;
  const calls = [];

  for await (const raw of sseData(res)) {
    if (!raw || raw === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(raw);
    } catch {
      continue;
    }
    if (chunk.usageMetadata) usage = collectUsage(chunk.usageMetadata);

    const cand = chunk.candidates?.[0];
    if (!cand) continue;
    if (cand.finishReason) finish = cand.finishReason;

    const gm = cand.groundingMetadata;
    if (gm) {
      if (Array.isArray(gm.groundingChunks)) groundChunks.push(...gm.groundingChunks);
      if (Array.isArray(gm.groundingSupports)) groundSupports.push(...gm.groundingSupports);
    }

    for (const part of cand.content?.parts || []) {
      if (part.thought && part.text) {
        thinking += part.text;
        emit({ type: "thinking", text: part.text });
      } else if (part.text) {
        text += part.text;
        if (part.thoughtSignature) textSignature = part.thoughtSignature;
        emit({ type: "text", text: part.text });
      } else if (part.functionCall) {
        calls.push({
          type: "tool_use",
          id: `call_${calls.length}_${Date.now().toString(36)}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
          ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
        });
      } else if (part.executableCode) {
        if (!codeRunning) {
          codeRunning = true;
          emit({ type: "tool", name: "code_execution", label: "Running code" });
        }
      } else if (part.codeExecutionResult) {
        if (codeRunning) {
          codeRunning = false;
          emit({ type: "tool_done", name: "code_execution" });
        }
      } else if (part.inlineData?.data) {
        const ext = (part.inlineData.mimeType || "application/octet-stream").split("/")[1] || "bin";
        const art = saveArtifact(`gemini-output.${ext}`, Buffer.from(part.inlineData.data, "base64"));
        artifacts.push(art);
        emit({ type: "artifact", ...art });
      }
    }
  }
  if (codeRunning) emit({ type: "tool_done", name: "code_execution" });

  // Web grounding: number the chunks, then splice [n] markers into the answer
  // so citations read the same as the ones from our knowledge tool.
  // `uri` is a Google redirect; `domain`/`title` is what the reader recognises.
  const sources = groundChunks.map((c, i) => ({
    n: sourceOffset + i + 1,
    title: c.web?.title || c.web?.domain || c.web?.uri || `Source ${i + 1}`,
    url: c.web?.uri || null,
    display: c.web?.domain || c.web?.title || null,
    kind: "web",
    snippet: "",
  }));
  if (sources.length && text) {
    const cited = injectCitations(text, groundSupports, sources.map((s) => s.n));
    if (cited !== text) {
      text = cited;
      emit({ type: "replace_text", text });
    }
  }

  if (thinking) content.push({ type: "thinking", thinking });
  if (text) content.push({ type: "text", text, ...(textSignature ? { signature: textSignature } : {}) });
  content.push(...calls);

  let stopReason = FINISH_REASONS[finish] || "end_turn";
  if (calls.length && stopReason === "end_turn") stopReason = "tool_use";
  if (finish === "MALFORMED_FUNCTION_CALL") {
    throw new GeminiError("Gemini produced a malformed tool call. Try rephrasing your message.", 400);
  }

  return { content, stop_reason: stopReason, usage, sources, artifacts };
}

// One-shot call used by deep research (planning and per-question investigation).
async function create({ model, system, messages, tools, settings, maxTokens, effort, jsonSchema }) {
  const body = buildBody({ system, messages, tools, settings, maxTokens, effort, jsonSchema });
  const res = await request(model, "generateContent", body);
  const data = await res.json();
  const cand = data.candidates?.[0];

  const content = [];
  const sources = [];
  const artifacts = [];
  let text = "";
  let signature = null;
  for (const part of cand?.content?.parts || []) {
    if (part.thought) continue;
    if (part.text) {
      text += part.text;
      if (part.thoughtSignature) signature = part.thoughtSignature;
    } else if (part.inlineData?.data) {
      const ext = (part.inlineData.mimeType || "application/octet-stream").split("/")[1] || "bin";
      artifacts.push(saveArtifact(`gemini-output.${ext}`, Buffer.from(part.inlineData.data, "base64")));
    }
  }
  if (text) content.push({ type: "text", text, ...(signature ? { signature } : {}) });

  for (const c of cand?.groundingMetadata?.groundingChunks || []) {
    sources.push({
      title: c.web?.title || c.web?.domain || c.web?.uri || "Source",
      url: c.web?.uri || null,
      display: c.web?.domain || c.web?.title || null,
      kind: "web",
      snippet: "",
    });
  }

  return {
    content,
    text,
    sources,
    artifacts,
    stop_reason: FINISH_REASONS[cand?.finishReason] || "end_turn",
    usage: collectUsage(data.usageMetadata),
  };
}

async function listModels() {
  if (!hasKey()) return STATIC_MODELS;
  try {
    const res = await fetch(`${BASE}/models?pageSize=200`, {
      headers: { "x-goog-api-key": apiKey() },
    });
    if (!res.ok) return STATIC_MODELS;
    const data = await res.json();
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name).replace(/^models\//, ""))
      .filter((n) => n.startsWith("gemini") && !/embedding|aqa|tts|image|vision-latest/i.test(n));
    return names.length ? names.sort() : STATIC_MODELS;
  } catch {
    return STATIC_MODELS;
  }
}

function price(model) {
  const m = String(model || "").toLowerCase();
  for (const [key, p] of PRICES) if (m.includes(key)) return p;
  return { in: 1.25, out: 10 };
}

function errorMessage(err) {
  if (!(err instanceof GeminiError)) return null;
  if (err.status === 401 || err.status === 403) {
    return "Gemini rejected the API key — check GEMINI_API_KEY in .env.";
  }
  if (err.status === 429) return "Gemini rate limit reached — wait a moment and try again.";
  if (err.status === 404) return `Model not found. Pick a different model in Admin → Model & Tools. (${err.message})`;
  return err.message;
}

module.exports = {
  id: "gemini",
  label: "Google Gemini",
  keyName: "GEMINI_API_KEY",
  // Gemini ignores googleSearch/codeExecution once functionDeclarations are
  // present, so built-ins and functions cannot share one request.
  nativeToolsExclusive: true,
  defaultModel: "gemini-pro-latest",
  staticModels: STATIC_MODELS,
  hasKey,
  stream,
  create,
  listModels,
  price,
  errorMessage,
  // exported for tests
  _internals: { toContents, cleanSchema, injectCitations, toTools },
};
