// Provider registry. Gemini is the default; Anthropic stays available when an
// ANTHROPIC_API_KEY is present. Everything above this layer (chat loop, deep
// research, server routes) is provider-agnostic.

const gemini = require("./gemini");
const anthropic = require("./anthropic");

const ALL = [gemini, anthropic];
const byId = new Map(ALL.map((p) => [p.id, p]));

const get = (id) => byId.get(id) || gemini;

// Any provider at all configured?
const anyKey = () => ALL.some((p) => p.hasKey());

// The provider we should actually use: the chosen one if it has a key,
// otherwise the first configured one, otherwise the chosen one so the caller
// can report a sensible "no key" error.
function resolve(settings) {
  const chosen = get(settings.provider);
  if (chosen.hasKey()) return chosen;
  return ALL.find((p) => p.hasKey()) || chosen;
}

// Each provider remembers its own model, so switching back and forth doesn't
// leave a Claude model id pointed at Gemini.
function modelFor(provider, settings) {
  const remembered = (settings.modelByProvider || {})[provider.id];
  return remembered || provider.defaultModel;
}

function summary() {
  return ALL.map((p) => ({
    id: p.id,
    label: p.label,
    keyName: p.keyName,
    hasKey: p.hasKey(),
    defaultModel: p.defaultModel,
    models: p.staticModels,
  }));
}

// Turns any thrown error into something worth showing a user.
function describeError(err, provider) {
  const specific = provider && provider.errorMessage ? provider.errorMessage(err) : null;
  if (specific) return specific;
  for (const p of ALL) {
    const msg = p.errorMessage ? p.errorMessage(err) : null;
    if (msg) return msg;
  }
  return err.message || "Request failed.";
}

module.exports = { ALL, get, resolve, modelFor, summary, anyKey, describeError, gemini, anthropic };
