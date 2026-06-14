// Natural-language shortcuts. Slash commands are a hidden CLI; most people don't
// know to type `/account`. matchIntent recognizes a few common config intents
// written in plain words and maps them to the command that does it, so the
// commands become optional rather than required knowledge.
//
// Conservative by design: only SHORT, command-shaped messages match. A real
// coding task ("add error handling to the auth provider") is long and/or lacks
// the trigger shape, so it falls through to the model. The mapped commands are
// also non-destructive (they open panels / switch routing), so a rare false
// positive shows the wrong panel at worst — never mutates code or spends money.

export interface IntentMatch {
  command: string; // the slash command to run
  note: string; // one-line explanation shown to the user
}

const MODEL_WORD =
  /\b(opus|sonnet|haiku|gpt-?5(?:\.\d+)?|gpt-?4(?:\.\d+)?|o\d|gemini|flash|deepseek|grok|kimi|qwen|llama|mistral|nova|codestral)\b/;

// A provider / account word — bare "key" is excluded (too common in code).
const PROVIDER_WORD =
  /\b(account|provider|api[\s-]?key|subscription|claude|chatgpt|codex|openai|gemini|anthropic|azure|bedrock|vertex|openrouter|deepseek|grok|groq|mistral|moonshot|together|fireworks|xai)\b/;

export function matchIntent(raw: string): IntentMatch | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith("/") || t.startsWith("!") || t.startsWith("#") || t.startsWith("@")) return null;
  const words = t.split(/\s+/);
  if (words.length > 8) return null; // long messages are tasks, not config intents

  // Add / connect an account.
  if (/^(add|connect|set\s?up|sign\s?in|log\s?in|hook\s?up)\b/.test(t) && PROVIDER_WORD.test(t)) {
    return { command: "/account add", note: "add an account · or just paste your API key into the box" };
  }

  // Spend / usage.
  if (
    /\b(how much|what)\b.{0,16}\b(spent|spend|cost|costing|usage|bill)\b/.test(t) ||
    /^(my\s)?(spend|usage|costs?)\??$/.test(t) ||
    /^show\s(me\s)?(my\s)?(spend|usage|cost)/.test(t)
  ) {
    return { command: "/usage", note: "your usage & spend" };
  }

  // Why this model / routing scorecard.
  if (/^why\??$/.test(t) || (/\bwhy\b/.test(t) && /\b(model|pick|picked|chose|chosen|route|routed|this)\b/.test(t))) {
    return { command: "/why", note: "the routing scorecard" };
  }

  // Switch the model (needs both a switch verb AND a model word).
  const m = t.match(MODEL_WORD);
  if (m && /^(use|switch(\sto)?|change(\sto)?|pin|route\s(to|with))\b/.test(t)) {
    return { command: `/model ${m[0]}`, note: `switch model · /model auto to route per task again` };
  }

  // List accounts / models.
  if (/^(list|show|see|what(?:'s| are| is)?)\b/.test(t) && /\baccounts?\b/.test(t)) {
    return { command: "/account", note: "your accounts" };
  }
  if (/^(list|show|see|what(?:'s| are| is)?)\b/.test(t) && /\bmodels?\b/.test(t)) {
    return { command: "/model", note: "available models" };
  }

  return null;
}
