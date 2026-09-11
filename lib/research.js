// Deep Research: plan → investigate in parallel → synthesize a cited report.
// This is My Buddy's counterpart to Onyx's multi-step research flow, and runs
// on whichever provider is active.

const { recordUsage, searchKnowledge } = require("./store");

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "3 to 5 focused sub-questions that together answer the request.",
      items: { type: "string" },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

async function plan({ provider, model, settings, topic, emit }) {
  emit({ type: "phase", phase: "planning", label: "Planning the research" });

  const res = await provider.create({
    model,
    settings,
    maxTokens: 2000,
    effort: "low",
    jsonSchema: PLAN_SCHEMA,
    system:
      "You break a research request into focused sub-questions. Each should be independently searchable and together they should fully cover the request. Return 3-5 questions as JSON.",
    messages: [{ role: "user", content: `Research request: ${topic}` }],
  });
  recordUsage({ provider: provider.id, model, ...res.usage, kind: "research-plan" });

  let questions = [];
  try {
    questions = JSON.parse(stripFence(res.text)).questions || [];
  } catch {
    questions = res.text
      .split("\n")
      .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
      .filter((l) => l.length > 10)
      .slice(0, 5);
  }
  if (!questions.length) questions = [topic];

  questions = questions.slice(0, 5);
  emit({ type: "plan", questions });
  return questions;
}

// Some models wrap JSON in a ```json fence even when asked for raw JSON.
const stripFence = (s) => String(s || "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();

async function investigate({ provider, model, settings, question, agent, emit, index }) {
  emit({ type: "phase", phase: "searching", label: `Investigating: ${question}`, index });

  const local = searchKnowledge(question, {
    topK: 4,
    docSetIds: (agent.docSetIds || []).length ? agent.docSetIds : null,
  });
  const localContext = local.length
    ? "Excerpts from the user's own documents:\n\n" +
      local.map((r) => `From "${r.docName}":\n${r.text}`).join("\n\n---\n\n")
    : "";

  const res = await provider.create({
    model,
    settings,
    maxTokens: 8000,
    effort: "medium",
    system:
      "You are a research analyst investigating one specific question. Search the web for current, credible information. Report concise findings as bullet points, each with the source URL. State plainly if the evidence is thin or sources conflict.",
    messages: [
      {
        role: "user",
        content: `${localContext ? localContext + "\n\n" : ""}Research this question and report your findings: ${question}`,
      },
    ],
    tools: settings.webSearchEnabled ? [{ kind: "web_search", maxUses: 5 }] : [],
  });
  recordUsage({ provider: provider.id, model, ...res.usage, kind: "research-step" });

  const sources = [...(res.sources || [])];
  for (const r of local) {
    sources.push({ title: r.docName, url: r.url, kind: "file", snippet: r.text.slice(0, 200) });
  }

  emit({ type: "phase_done", phase: "searching", index, label: question, sourceCount: sources.length });
  return { question, findings: res.text, sources };
}

async function runResearch({ provider, model, session, agent, settings, topic, emit }) {
  const questions = await plan({ provider, model, settings, topic, emit });

  const steps = await Promise.all(
    questions.map((q, i) => investigate({ provider, model, settings, question: q, agent, emit, index: i }))
  );

  // De-duplicate sources by URL, then number them for citation.
  const seen = new Map();
  for (const step of steps) {
    for (const s of step.sources) {
      const key = s.url || s.title;
      if (!seen.has(key)) seen.set(key, { ...s, n: seen.size + 1 });
    }
  }
  const sources = [...seen.values()];
  if (sources.length) emit({ type: "sources", sources });

  emit({ type: "phase", phase: "writing", label: "Writing the report" });

  const dossier = steps
    .map((s, i) => `### Sub-question ${i + 1}: ${s.question}\n\n${s.findings}`)
    .join("\n\n");
  const sourceList = sources
    .map((s) => `[${s.n}] ${s.title}${s.url ? ` — ${s.url}` : ""}`)
    .join("\n");

  const final = await provider.stream({
    model,
    settings,
    tools: [],
    emit,
    system:
      "You write research reports. Synthesize the provided findings into a clear, well-structured Markdown report: a short answer up front, then sections with detail, then open questions or caveats. Cite sources inline as [1], [2] using the numbered source list — never invent a citation number. Do not simply restate the findings; integrate them and note disagreements.",
    messages: [
      {
        role: "user",
        content: `Research request: ${topic}\n\n## Findings from sub-investigations\n\n${dossier}\n\n## Numbered sources (cite with these numbers)\n\n${sourceList}\n\nWrite the final report.`,
      },
    ],
  });

  recordUsage({
    sessionId: session.id,
    provider: provider.id,
    model,
    ...final.usage,
    kind: "research-report",
  });

  session.messages.push({ role: "assistant", content: final.content });

  return { sources, artifacts: [], usage: final.usage };
}

module.exports = { runResearch };
