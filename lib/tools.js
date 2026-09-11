// Tool wiring: builds a provider-neutral tool list for an agent and executes
// the client-side tools (knowledge retrieval + user-defined HTTP actions).
//
// Descriptors are one of:
//   { kind: "web_search", maxUses }
//   { kind: "code_execution" }
//   { kind: "function", name, description, parameters }
// Each provider adapter maps these to its own wire format.

const { state, searchKnowledge } = require("./store");

const isFunctionTool = (t) => t.kind === "function";
// A delegated built-in still counts as that capability for prompt purposes.
const hasTool = (tools, kind) => tools.some((t) => t.kind === kind || t.delegate === kind);
const hasFunction = (tools, name) => tools.some((t) => t.kind === "function" && t.name === name);

// Gemini stops running its own web search and code execution the moment the
// request also declares functions — it hands those calls back to the client
// instead. So when a provider works that way, we declare the built-ins as
// ordinary functions and fulfil them here with a focused single-tool sub-call.
const DELEGATES = {
  web_search: {
    kind: "function",
    name: "web_search",
    delegate: "web_search",
    description:
      "Search the public web for current, external information — news, prices, populations, releases, anything that changes over time. Returns findings with numbered source URLs; cite them as [1], [2].",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, in natural language." },
      },
      required: ["query"],
    },
  },
  code_execution: {
    kind: "function",
    name: "run_python",
    delegate: "code_execution",
    description:
      "Run Python in a sandbox and return its output. Use it to compute exact results, analyse data, and draw charts. Describe the task precisely; matplotlib and the standard library are available.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Exactly what to compute or plot, including any input data.",
        },
      },
      required: ["task"],
    },
  },
};

function buildTools(agent, settings, provider) {
  const tools = [];
  const t = agent.tools || {};

  if (t.webSearch && settings.webSearchEnabled) {
    tools.push({ kind: "web_search", maxUses: settings.maxSearchResults });
  }
  if (
    (t.codeInterpreter && settings.codeInterpreterEnabled) ||
    (t.imageGen && settings.imageGenEnabled)
  ) {
    tools.push({ kind: "code_execution" });
  }

  const hasDocs = state.documents.length > 0;
  if (t.knowledge && settings.knowledgeEnabled && hasDocs) {
    tools.push({
      kind: "function",
      name: "search_knowledge",
      description:
        "Search ONLY the user's own private corpus — files they uploaded and web pages they saved. It holds nothing about general, public, or current world knowledge, so do not reach for it to answer factual questions about the wider world. Use it when the question is about the user's own documents, notes, or material they have added. Returns numbered excerpts — cite them in your answer as [1], [2], etc.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — use the user's key terms." },
          top_k: { type: "integer", description: "How many excerpts to return (default 6)." },
        },
        required: ["query"],
      },
    });
  }

  for (const id of agent.actionIds || []) {
    const action = state.actions.find((a) => a.id === id && a.enabled);
    if (!action) continue;
    let schema;
    try {
      schema = JSON.parse(action.inputSchema || "{}");
    } catch {
      schema = { type: "object", properties: {} };
    }
    if (!schema.type) schema.type = "object";
    if (!schema.properties) schema.properties = {};
    tools.push({
      kind: "function",
      name: action.name,
      description: action.description || `Call the ${action.name} API.`,
      parameters: schema,
    });
  }

  // Mixing is only a problem when there is something to mix with: an agent
  // with no functions keeps the faster, cheaper native tools.
  if (provider && provider.nativeToolsExclusive && tools.some(isFunctionTool)) {
    return tools.map((t) => DELEGATES[t.kind] || t);
  }
  return tools;
}

// Executes a client-side tool call. Returns {content, sources, artifacts}.
async function executeTool(name, input, agent, settings, ctx = {}) {
  if (name === "web_search" && ctx.provider) return runWebSearch(input, settings, ctx);
  if (name === "run_python" && ctx.provider) return runPython(input, settings, ctx);

  if (name === "search_knowledge") {
    const offset = ctx.sourceOffset || 0;
    const results = searchKnowledge(input.query || "", {
      topK: Math.min(Number(input.top_k) || settings.retrievalTopK, 12),
      docSetIds: (agent.docSetIds || []).length ? agent.docSetIds : null,
    });
    if (!results.length) {
      return {
        content:
          "No matching documents found in the user's knowledge base. Do not guess — say so, or use another tool if one fits.",
        sources: [],
      };
    }
    // Number from the running total so [n] in the answer matches the panel.
    const numbered = results.map((r, i) => ({ ...r, n: offset + i + 1 }));
    const text = numbered
      .map((r) => `[${r.n}] ${r.docName}${r.url ? ` (${r.url})` : ""}\n${r.text}`)
      .join("\n\n---\n\n");
    const sources = numbered.map((r) => ({
      n: r.n,
      title: r.docName,
      url: r.url,
      kind: r.source === "web" ? "web" : "file",
      snippet: r.text.slice(0, 320),
      score: r.score,
    }));
    return { content: text, sources };
  }

  const action = state.actions.find((a) => a.name === name && a.enabled);
  if (action) return executeAction(action, input);

  return { content: `Unknown tool: ${name}`, isError: true, sources: [] };
}

// A single-tool sub-call: the provider *will* run its own web search when
// nothing else is competing for the tool slot, so we ask it in isolation and
// hand the findings back as a tool result.
async function runWebSearch(input, settings, { provider, model, sourceOffset = 0 }) {
  const query = String(input.query || "").trim();
  if (!query) return { content: "No search query supplied.", isError: true, sources: [] };

  try {
    const res = await provider.create({
      model,
      settings,
      maxTokens: 4000,
      effort: "low",
      tools: [{ kind: "web_search", maxUses: settings.maxSearchResults }],
      system:
        "You are a search assistant. Search the web and report what you find as concise bullet points, each with the source URL. Do not answer from memory — report only what the search returned. Say plainly if the evidence is thin or sources disagree.",
      messages: [{ role: "user", content: query }],
    });
    const sources = (res.sources || []).map((s, i) => ({ ...s, n: sourceOffset + i + 1 }));
    const list = sources.length
      ? "\n\nSources:\n" + sources.map((s) => `[${s.n}] ${s.title}${s.url ? ` — ${s.url}` : ""}`).join("\n")
      : "";
    return {
      content: (res.text || "No results.") + list,
      sources,
    };
  } catch (err) {
    return { content: `Web search failed: ${err.message}`, isError: true, sources: [] };
  }
}

// Same trick for the sandboxed interpreter, including any files it produces.
async function runPython(input, settings, { provider, model }) {
  const task = String(input.task || "").trim();
  if (!task) return { content: "No task supplied.", isError: true, sources: [] };

  try {
    const res = await provider.create({
      model,
      settings,
      maxTokens: 8000,
      effort: "medium",
      tools: [{ kind: "code_execution" }],
      system:
        "You are a Python execution assistant. Write and run code to complete the task, then report the exact output. Never estimate a value you could compute. Save any file the user should keep so it can be returned as a download.",
      messages: [{ role: "user", content: task }],
    });
    return {
      content: res.text || "The code produced no output.",
      sources: [],
      artifacts: res.artifacts || [],
    };
  } catch (err) {
    return { content: `Code execution failed: ${err.message}`, isError: true, sources: [] };
  }
}

// User-defined HTTP action (My Buddy's take on Onyx's OpenAPI/MCP actions).
async function executeAction(action, input) {
  let url = action.url;
  const method = (action.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(action.headers || {}) };
  let body;

  if (method === "GET" || method === "DELETE") {
    const u = new URL(url);
    for (const [k, v] of Object.entries(input || {})) {
      u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    url = u.toString();
  } else {
    body = JSON.stringify(input || {});
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    clearTimeout(timer);
    const text = (await res.text()).slice(0, 40000);
    return {
      content: `HTTP ${res.status} ${res.statusText}\n\n${text}`,
      isError: !res.ok,
      sources: [{ n: 0, title: `${action.name} → ${res.status}`, url: action.url, kind: "action", snippet: text.slice(0, 200) }],
    };
  } catch (err) {
    return { content: `Action failed: ${err.message}`, isError: true, sources: [] };
  }
}

module.exports = { buildTools, executeTool, hasTool, hasFunction, isFunctionTool };
