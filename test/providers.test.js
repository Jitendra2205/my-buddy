// Unit tests for the provider translation layer — the parts that are pure
// functions and can be checked without burning API calls.
//   node --test test/

const test = require("node:test");
const assert = require("node:assert");

const gemini = require("../lib/providers/gemini");
const providers = require("../lib/providers");
const { buildTools, hasTool } = require("../lib/tools");
const { state } = require("../lib/store");

const { toContents, cleanSchema, injectCitations, toTools } = gemini._internals;

test("user and assistant turns map to Gemini contents", () => {
  const contents = toContents([
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ]);
  assert.deepStrictEqual(contents, [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [{ text: "hi there" }] },
  ]);
});

test("tool calls and results round-trip by name", () => {
  const contents = toContents([
    { role: "user", content: "search my docs" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_0_x", name: "search_knowledge", input: { query: "q" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_0_x", content: "[1] excerpt" }],
    },
  ]);

  assert.deepStrictEqual(contents[1].parts[0].functionCall, {
    name: "search_knowledge",
    args: { query: "q" },
  });
  // Gemini matches responses to calls by name, not by id.
  assert.deepStrictEqual(contents[2].parts[0].functionResponse, {
    name: "search_knowledge",
    response: { result: "[1] excerpt" },
  });
});

test("error results are reported as errors, not results", () => {
  const contents = toContents([
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "get_ticket", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }] },
  ]);
  assert.deepStrictEqual(contents[2].parts[0].functionResponse.response, { error: "boom" });
});

test("thought signatures are replayed with the tool call that earned them", () => {
  // Gemini 3 rejects a replayed functionCall that has lost its signature, which
  // breaks every multi-step tool turn. Guard the round-trip.
  const contents = toContents([
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look.", signature: "sig-text" },
        { type: "tool_use", id: "c1", name: "search_knowledge", input: {}, signature: "sig-call" },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "found" }] },
  ]);
  assert.strictEqual(contents[1].parts[0].thoughtSignature, "sig-text");
  assert.strictEqual(contents[1].parts[1].thoughtSignature, "sig-call");
});

test("blocks without a signature send no signature field", () => {
  const contents = toContents([
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: {} }] },
  ]);
  assert.ok(!("thoughtSignature" in contents[1].parts[0]));
});

test("thinking blocks are dropped on the way back to Gemini", () => {
  const contents = toContents([
    { role: "user", content: "x" },
    { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "y" }] },
  ]);
  assert.strictEqual(contents[1].parts.length, 1);
  assert.strictEqual(contents[1].parts[0].text, "y");
});

test("an assistant turn with no usable parts is skipped, not sent empty", () => {
  const contents = toContents([
    { role: "user", content: "x" },
    { role: "assistant", content: [{ type: "thinking", thinking: "only thoughts" }] },
  ]);
  assert.strictEqual(contents.length, 1);
});

test("schemas are reduced to Gemini's OpenAPI subset", () => {
  const cleaned = cleanSchema({
    type: "object",
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
    properties: {
      id: { type: "string", description: "Ticket id", pattern: "^[0-9]+$" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["id"],
  });

  assert.strictEqual(cleaned.type, "OBJECT");
  assert.ok(!("additionalProperties" in cleaned));
  assert.ok(!("$schema" in cleaned));
  assert.strictEqual(cleaned.properties.id.type, "STRING");
  assert.ok(!("pattern" in cleaned.properties.id));
  assert.strictEqual(cleaned.properties.tags.items.type, "STRING");
  assert.deepStrictEqual(cleaned.required, ["id"]);
});

test("a malformed schema still yields a usable object schema", () => {
  assert.deepStrictEqual(cleanSchema(null), { type: "OBJECT", properties: {} });
  assert.deepStrictEqual(cleanSchema({}), { type: "OBJECT", properties: {} });
});

test("normalized tool descriptors map to Gemini tool blocks", () => {
  const mapped = toTools([
    { kind: "web_search", maxUses: 5 },
    { kind: "code_execution" },
    { kind: "function", name: "f", description: "d", parameters: { type: "object", properties: {} } },
  ]);
  assert.ok(mapped.some((t) => t.googleSearch));
  assert.ok(mapped.some((t) => t.codeExecution));
  const decls = mapped.find((t) => t.functionDeclarations);
  assert.strictEqual(decls.functionDeclarations[0].name, "f");
});

test("grounding citations splice in at UTF-8 byte offsets", () => {
  // "café" is 5 bytes but 4 JS characters — the offsets are byte-based.
  const text = "café is good. Tea is fine.";
  const bytes = Buffer.from(text, "utf8");
  const supports = [
    { segment: { endIndex: Buffer.from("café is good.", "utf8").length }, groundingChunkIndices: [0] },
    { segment: { endIndex: bytes.length }, groundingChunkIndices: [1, 0] },
  ];
  const out = injectCitations(text, supports, [3, 4]);
  assert.strictEqual(out, "café is good.[3] Tea is fine.[3][4]");
});

test("citation injection is a no-op without grounding support", () => {
  assert.strictEqual(injectCitations("plain", [], [1]), "plain");
  assert.strictEqual(injectCitations("plain", null, [1]), "plain");
});

test("agent tool switches produce provider-neutral descriptors", () => {
  const agent = {
    tools: { webSearch: true, codeInterpreter: true, knowledge: true, imageGen: false },
    docSetIds: [],
    actionIds: [],
  };
  const settings = {
    webSearchEnabled: true,
    codeInterpreterEnabled: true,
    knowledgeEnabled: true,
    imageGenEnabled: true,
    maxSearchResults: 6,
  };
  const docs = state.documents;
  state.documents = [{ id: "d1" }]; // knowledge tool only appears when docs exist
  try {
    const tools = buildTools(agent, settings);
    assert.deepStrictEqual(tools.map((t) => t.kind).sort(), ["code_execution", "function", "web_search"]);
    assert.ok(tools.every((t) => !("input_schema" in t) && !("type" in t)));
  } finally {
    state.documents = docs;
  }
});

test("Gemini gets built-ins delegated only when functions are also present", () => {
  // Gemini silently stops running googleSearch/codeExecution once any function
  // is declared, so those capabilities have to become functions we fulfil.
  const settings = {
    webSearchEnabled: true, knowledgeEnabled: true,
    codeInterpreterEnabled: true, imageGenEnabled: true, maxSearchResults: 6,
  };
  const docs = state.documents;
  state.documents = [{ id: "d1" }];
  try {
    const mixed = buildTools(
      { tools: { webSearch: true, codeInterpreter: true, knowledge: true }, docSetIds: [], actionIds: [] },
      settings, providers.gemini
    );
    assert.ok(mixed.every((t) => t.kind === "function"), "built-ins should be delegated");
    assert.deepStrictEqual(
      mixed.map((t) => t.name).sort(),
      ["run_python", "search_knowledge", "web_search"]
    );
    // A delegated tool still reports the capability it stands in for.
    assert.ok(hasTool(mixed, "web_search"));
    assert.ok(hasTool(mixed, "code_execution"));

    // No functions in play means no reason to give up the native tools.
    const nativeOnly = buildTools(
      { tools: { webSearch: true, codeInterpreter: true, knowledge: false }, docSetIds: [], actionIds: [] },
      settings, providers.gemini
    );
    assert.deepStrictEqual(nativeOnly.map((t) => t.kind).sort(), ["code_execution", "web_search"]);
  } finally {
    state.documents = docs;
  }
});

test("Anthropic keeps its native tools alongside functions", () => {
  const docs = state.documents;
  state.documents = [{ id: "d1" }];
  try {
    const tools = buildTools(
      { tools: { webSearch: true, codeInterpreter: true, knowledge: true }, docSetIds: [], actionIds: [] },
      { webSearchEnabled: true, knowledgeEnabled: true, codeInterpreterEnabled: true, imageGenEnabled: true, maxSearchResults: 6 },
      providers.anthropic
    );
    assert.deepStrictEqual(tools.map((t) => t.kind).sort(), ["code_execution", "function", "web_search"]);
  } finally {
    state.documents = docs;
  }
});

test("knowledge tool is withheld when nothing is indexed", () => {
  const docs = state.documents;
  state.documents = [];
  try {
    const tools = buildTools(
      { tools: { knowledge: true }, docSetIds: [], actionIds: [] },
      { knowledgeEnabled: true }
    );
    assert.strictEqual(tools.length, 0);
  } finally {
    state.documents = docs;
  }
});

test("the registry falls back to a configured provider", () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    // Asking for Anthropic without its key should land on Gemini instead.
    assert.strictEqual(providers.resolve({ provider: "anthropic" }).id, "gemini");
    assert.strictEqual(providers.resolve({ provider: "gemini" }).id, "gemini");
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test("each provider remembers its own model", () => {
  const settings = { modelByProvider: { gemini: "gemini-2.5-flash", anthropic: "claude-sonnet-5" } };
  assert.strictEqual(providers.modelFor(providers.gemini, settings), "gemini-2.5-flash");
  assert.strictEqual(providers.modelFor(providers.anthropic, settings), "claude-sonnet-5");
  assert.strictEqual(providers.modelFor(providers.gemini, {}), providers.gemini.defaultModel);
});

test("cost estimates use the right price per model", () => {
  assert.deepStrictEqual(providers.gemini.price("gemini-2.5-flash-lite"), { in: 0.1, out: 0.4 });
  assert.deepStrictEqual(providers.gemini.price("gemini-2.5-flash"), { in: 0.3, out: 2.5 });
  assert.deepStrictEqual(providers.gemini.price("gemini-2.5-pro"), { in: 1.25, out: 10 });
  assert.deepStrictEqual(providers.anthropic.price("claude-opus-5"), { in: 5, out: 25 });
});
