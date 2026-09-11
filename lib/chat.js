// The agent loop: streams a turn through whichever provider is active, runs
// client-side tools, repeats until the model is done. Collects citations and
// downloadable artifacts along the way.
//
// Everything here is provider-neutral — the adapters in lib/providers speak a
// shared message shape (an Anthropic-style block list, which is also what
// sessions.json stores, so history survives a provider switch).

const { recordUsage } = require("./store");
const { buildTools, executeTool, hasTool, hasFunction } = require("./tools");

async function runChat({ provider, model, session, agent, settings, emit }) {
  const tools = buildTools(agent, settings, provider);
  const system = buildSystem(agent, settings, tools);
  const toolCtx = { provider, model };

  const allSources = [];
  const allArtifacts = [];
  let totalIn = 0;
  let totalOut = 0;
  let guard = 0;

  while (guard++ < 12) {
    const final = await provider.stream({
      model,
      system,
      messages: apiMessages(session),
      tools,
      settings,
      emit,
      sourceOffset: allSources.length,
    });

    totalIn += final.usage.input;
    totalOut += final.usage.output;

    if (final.stop_reason === "refusal") {
      throw new Error("The model's safety system declined this request. Try rephrasing your message.");
    }

    if (final.sources && final.sources.length) {
      allSources.push(...final.sources);
      emit({ type: "sources", sources: final.sources });
    }
    if (final.artifacts && final.artifacts.length) allArtifacts.push(...final.artifacts);

    session.messages.push({ role: "assistant", content: final.content });

    if (final.stop_reason === "pause_turn") continue; // server tool paused; resume

    const toolUses = final.content.filter((b) => b.type === "tool_use");
    if (toolUses.length) {
      const results = [];
      for (const call of toolUses) {
        emit({ type: "tool", name: call.name, label: toolLabel(call.name) });
        // Tools number their own citations from the running total, so the [n]
        // markers inside a tool result line up with the sources panel.
        const out = await executeTool(call.name, call.input || {}, agent, settings, {
          ...toolCtx,
          sourceOffset: allSources.length,
        });
        if (out.sources && out.sources.length) {
          allSources.push(...out.sources);
          emit({ type: "sources", sources: out.sources });
        }
        for (const art of out.artifacts || []) {
          allArtifacts.push(art);
          emit({ type: "artifact", ...art });
        }
        emit({ type: "tool_done", name: call.name });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: out.content,
          ...(out.isError ? { is_error: true } : {}),
        });
      }
      session.messages.push({ role: "user", content: results });
      continue;
    }

    break;
  }

  recordUsage({
    sessionId: session.id,
    agentId: agent.id,
    provider: provider.id,
    model,
    input: totalIn,
    output: totalOut,
  });

  return { sources: allSources, artifacts: allArtifacts, usage: { input: totalIn, output: totalOut } };
}

const TOOL_LABELS = {
  search_knowledge: "Searching your documents",
  web_search: "Searching the web",
  run_python: "Running code",
};
const toolLabel = (name) => TOOL_LABELS[name] || `Calling ${name}`;

function buildSystem(agent, settings, tools) {
  const parts = [agent.system || ""];

  if (hasFunction(tools, "search_knowledge")) {
    parts.push(
      "You have access to the user's indexed documents via the search_knowledge tool. When your answer draws on retrieved excerpts, cite them inline as [1], [2] matching the excerpt numbers. Do not invent citation numbers."
    );
  }
  if (hasTool(tools, "web_search")) {
    parts.push(
      "You can search the web. Cite the pages you rely on, and say plainly when sources disagree or when information may be out of date."
    );
  }
  if (hasTool(tools, "code_execution")) {
    parts.push(
      "You have a Python code interpreter. Use it to compute real results rather than estimating, and to produce charts or files the user can download. When the user asks you to compute something, run the code even if you believe you know the answer. Save any file the user should keep to disk so it can be returned as an artifact."
    );
  }

  // With both a private corpus and the open web on the table, models tend to
  // over-reach for the corpus. Say plainly which question goes where.
  if (hasFunction(tools, "search_knowledge") && hasTool(tools, "web_search")) {
    parts.push(
      "Route tool use by where the answer actually lives. search_knowledge covers only the user's own documents; web search covers everything public and current. For facts about the outside world — events, prices, populations, releases — search the web, not the user's documents. If search_knowledge comes back with nothing relevant, search the web rather than answering from memory."
    );
  }
  parts.push(
    "Format responses in Markdown. Lead with the answer, then supporting detail. Keep it readable — complete sentences, no arrow-chain shorthand."
  );
  return parts.filter(Boolean).join("\n\n");
}

// Strips our UI-only fields back to what the adapters accept.
function apiMessages(session) {
  return session.messages.map((m) => ({ role: m.role, content: m.content }));
}

module.exports = { runChat, apiMessages, buildSystem };
