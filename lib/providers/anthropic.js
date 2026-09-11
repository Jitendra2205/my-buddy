// Anthropic (Claude) adapter — the original My Buddy backend, now behind the
// same normalized interface as the Gemini adapter so either can drive the
// agent loop. Optional: without an ANTHROPIC_API_KEY the provider simply
// reports itself as unavailable and the UI hides it.

const { saveArtifact } = require("../store");

let SDK = null;
try {
  SDK = require("@anthropic-ai/sdk");
} catch {
  // The SDK is optional — a Gemini-only install doesn't need it.
}

const STATIC_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

// USD per million tokens.
const PRICES = [
  ["opus", { in: 5, out: 25 }],
  ["sonnet", { in: 3, out: 15 }],
  ["haiku", { in: 1, out: 5 }],
];

const hasKey = () => Boolean(SDK && process.env.ANTHROPIC_API_KEY);

let client = null;
function getClient() {
  if (!SDK) throw new Error("@anthropic-ai/sdk is not installed.");
  if (!client) client = new SDK();
  return client;
}

// Server-side refusal fallbacks sit behind a beta not every account has.
// Probe once, then remember.
let betaSupported = true;

function toTools(tools, settings) {
  const out = [];
  const wantsCode = (tools || []).some((t) => t.kind === "code_execution");
  for (const t of tools || []) {
    if (t.kind === "web_search") {
      // The _20260209 variant bundles its own code execution; when we also
      // expose an interpreter, use the basic variant so the model isn't handed
      // two execution environments.
      out.push(
        wantsCode
          ? { type: "web_search_20250305", name: "web_search", max_uses: t.maxUses || settings.maxSearchResults }
          : { type: "web_search_20260209", name: "web_search", max_uses: t.maxUses || settings.maxSearchResults }
      );
    } else if (t.kind === "code_execution") {
      out.push({ type: "code_execution_20260120", name: "code_execution" });
    } else if (t.kind === "function") {
      out.push({ name: t.name, description: t.description, input_schema: t.parameters });
    }
  }
  return out;
}

function params({ model, system, messages, tools, settings, maxTokens, effort, jsonSchema }) {
  const p = {
    model,
    max_tokens: maxTokens || 32000,
    messages,
    output_config: { effort: effort || settings.effort },
  };
  if (system) p.system = system;
  if (jsonSchema) p.output_config.format = { type: "json_schema", schema: jsonSchema };
  else if (settings.thinking) {
    p.thinking = { type: "adaptive", display: settings.showThinking ? "summarized" : "omitted" };
  }
  const t = toTools(tools, settings);
  if (t.length) p.tools = t;
  return p;
}

function openStream(p) {
  const c = getClient();
  if (betaSupported) {
    return c.beta.messages.stream({
      ...p,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  }
  return c.messages.stream(p);
}

// Pull generated files out of code-execution results and store them locally.
async function collectArtifacts(content, emit) {
  const artifacts = [];
  const c = getClient();
  for (const block of content) {
    if (block.type !== "bash_code_execution_tool_result") continue;
    const result = block.content;
    if (!result || !Array.isArray(result.content)) continue;
    for (const ref of result.content) {
      if (!ref.file_id) continue;
      try {
        const meta = await c.beta.files.retrieveMetadata(ref.file_id, { betas: ["files-api-2025-04-14"] });
        const resp = await c.beta.files.download(ref.file_id, { betas: ["files-api-2025-04-14"] });
        const art = saveArtifact(meta.filename || "output", Buffer.from(await resp.arrayBuffer()));
        artifacts.push(art);
        emit({ type: "artifact", ...art });
      } catch {
        // A file we can't fetch shouldn't kill the turn.
      }
    }
  }
  return artifacts;
}

function webSources(content, startN) {
  const sources = [];
  let n = startN;
  for (const block of content) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const r of block.content) {
      sources.push({
        n: n++,
        title: r.title || r.url,
        url: r.url,
        kind: "web",
        snippet: (r.page_age ? `${r.page_age} · ` : "") + (r.title || ""),
      });
    }
  }
  return sources;
}

async function stream({ model, system, messages, tools, settings, emit, sourceOffset = 0 }) {
  const p = params({ model, system, messages, tools, settings });

  let final;
  let emitted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const s = openStream(p);
      for await (const event of s) {
        if (event.type === "content_block_start") {
          const b = event.content_block;
          if (b.type === "server_tool_use") {
            emit({ type: "tool", name: b.name, label: b.name === "web_search" ? "Searching the web" : "Running code" });
          } else if (b.type === "tool_use") {
            emit({
              type: "tool",
              name: b.name,
              label: b.name === "search_knowledge" ? "Searching your documents" : `Calling ${b.name}`,
            });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            emitted = true;
            emit({ type: "text", text: event.delta.text });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            emit({ type: "thinking", text: event.delta.thinking });
          }
        }
      }
      final = await s.finalMessage();
      break;
    } catch (err) {
      // First-request beta rejection: drop the beta and retry once.
      if (betaSupported && !emitted && /beta|fallback|unexpected|unsupported/i.test(err.message || "")) {
        betaSupported = false;
        continue;
      }
      throw err;
    }
  }

  return {
    content: final.content,
    stop_reason: final.stop_reason,
    usage: { input: final.usage.input_tokens || 0, output: final.usage.output_tokens || 0 },
    sources: webSources(final.content, sourceOffset + 1),
    artifacts: await collectArtifacts(final.content, emit),
  };
}

async function create({ model, system, messages, tools, settings, maxTokens, effort, jsonSchema }) {
  const res = await getClient().messages.create(
    params({ model, system, messages, tools, settings, maxTokens, effort, jsonSchema })
  );
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return {
    content: res.content,
    text,
    sources: webSources(res.content, 1).map(({ n, ...s }) => s),
    stop_reason: res.stop_reason,
    usage: { input: res.usage.input_tokens || 0, output: res.usage.output_tokens || 0 },
  };
}

async function listModels() {
  if (!hasKey()) return STATIC_MODELS;
  try {
    const list = await getClient().models.list({ limit: 50 });
    const ids = (list.data || []).map((m) => m.id);
    return ids.length ? ids : STATIC_MODELS;
  } catch {
    return STATIC_MODELS;
  }
}

function price(model) {
  const m = String(model || "").toLowerCase();
  for (const [key, p] of PRICES) if (m.includes(key)) return p;
  return { in: 5, out: 25 };
}

function errorMessage(err) {
  if (!SDK) return null;
  if (err instanceof SDK.AuthenticationError) return "Invalid API key — check ANTHROPIC_API_KEY in .env.";
  if (err instanceof SDK.RateLimitError) return "Rate limited — wait a moment and try again.";
  if (err instanceof SDK.APIError) return err.message;
  return null;
}

module.exports = {
  id: "anthropic",
  label: "Anthropic Claude",
  keyName: "ANTHROPIC_API_KEY",
  nativeToolsExclusive: false,
  defaultModel: "claude-opus-5",
  staticModels: STATIC_MODELS,
  hasKey,
  stream,
  create,
  listModels,
  price,
  errorMessage,
};
